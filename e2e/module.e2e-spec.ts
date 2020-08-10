import { Test, TestingModule } from '@nestjs/testing';
import { SqsModule, SqsService } from '../lib';
import { SqsConsumerOptions, SqsProducerOptions } from '../lib/sqs.types';
import { Injectable } from '@nestjs/common';
import { SqsConsumerEventHandler, SqsMessageHandler } from '../lib/sqs.decorators';
import * as AWS from 'aws-sdk';
import { promisify } from 'util';
import waitForExpect from 'wait-for-expect';

const delay = promisify(setTimeout);
const SQS_ENDPOINT = process.env.SQS_ENDPOINT || 'http://localhost:9324';

enum TestQueue {
  Test = 'test',
  DLQ = 'test-dead',
}

const sqs = new AWS.SQS({
  apiVersion: '2012-11-05',
  credentials: new AWS.Credentials('x', 'x'),
  region: 'none',
});

const TestQueues: { [key in TestQueue]: SqsConsumerOptions | SqsProducerOptions } = {
  [TestQueue.Test]: {
    name: TestQueue.Test,
    queueUrl: `${SQS_ENDPOINT}/queue/test`,
    sqs,
  },
  [TestQueue.DLQ]: {
    name: TestQueue.DLQ,
    queueUrl: `${SQS_ENDPOINT}/queue/test-dead`,
    sqs,
  },
};

describe('SqsModule', () => {
  let module: TestingModule;

  describe('full flow', () => {
    const fakeProcessor = jest.fn();
    const fakeDLQProcessor = jest.fn();
    const fakeErrorEventHandler = jest.fn();

    @Injectable()
    class A {
      public constructor(
        public readonly sqsService: SqsService,
      ) {
      }

      @SqsMessageHandler(TestQueue.Test)
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      public async handleTestMessage(message: AWS.SQS.Message) {
        fakeProcessor(message);
      }

      @SqsConsumerEventHandler(TestQueue.Test, 'processing_error')
      public handleErrorEvent(err: Error, message: AWS.SQS.Message) {
        fakeErrorEventHandler(err, message);
      }

      @SqsMessageHandler(TestQueue.DLQ)
      public async handleDLQMessage(message: AWS.SQS.Message) {
        fakeDLQProcessor(message);
      }
    }

    beforeAll(async () => {
      module = await Test.createTestingModule({
        imports: [
          SqsModule.register({
            consumers: [
              {
                ...TestQueues[TestQueue.Test],
                waitTimeSeconds: 1,
                batchSize: 3,
                terminateVisibilityTimeout: true,
                messageAttributeNames: ['All'],
              },
              {
                ...TestQueues[TestQueue.DLQ],
                waitTimeSeconds: 1,
              },
            ],
            producers: [
              {
                ...TestQueues[TestQueue.Test],
              },
            ],
          }),
        ],
        providers: [
          A,
        ],
      }).compile();
      await module.init();

      const sqsService = module.get(SqsService);
      await Promise.all(Object.values(TestQueue).map((queueName) => sqsService.purgeQueue(queueName)));
    });

    afterEach(() => {
      fakeProcessor.mockRestore();
      fakeErrorEventHandler.mockRestore();
    });

    afterAll(async () => {
      fakeDLQProcessor.mockReset();
      await module.close();
    });

    it('should register message handler', () => {
      const sqsService = module.get(SqsService);
      expect(sqsService.consumers.has(TestQueue.Test)).toBe(true);
    });

    it('should register message producer', () => {
      const sqsService = module.get(SqsService);
      expect(sqsService.producers.has(TestQueue.Test)).toBe(true);
    });

    it('should call message handler when a new message has come', async (done) => {
      jest.setTimeout(30000);

      const sqsService = module.get(SqsService);
      const id = String(Math.floor(Math.random() * 1000000));
      fakeProcessor.mockImplementationOnce((message) => {
        expect(message).toBeTruthy();
        expect(JSON.parse(message.Body)).toStrictEqual({ test: true });
        done();
      });

      await sqsService.send(TestQueue.Test, {
        id,
        body: { test: true },
        delaySeconds: 0,
        groupId: 'test',
        deduplicationId: id,
      });
    });

    it('should call message handler multiple times when multiple messages have come', async (done) => {
      let called = 0;

      const sqsService = module.get(SqsService);
      const groupId = String(Math.floor(Math.random() * 1000000));
      fakeProcessor.mockImplementation((message) => {
        expect(message).toBeTruthy();

        if (++called === 3) {
          done();
        }
      });

      for (let i = 0; i < 3; i++) {
        const id = `${groupId}_${i}`;
        await sqsService.send(TestQueue.Test, {
          id,
          body: { test: true, i },
          delaySeconds: 0,
          groupId,
          deduplicationId: id,
        });
      }
    });

    it('should call the registered error handler when an error occurs', async (done) => {
      jest.setTimeout(10000);

      const sqsService = module.get(SqsService);
      const id = String(Math.floor(Math.random() * 1000000));
      fakeProcessor.mockImplementationOnce((message) => {
        throw new Error('test');
      });
      fakeErrorEventHandler.mockImplementationOnce((error, message) => {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('test');
        done();
      });

      await sqsService.send(TestQueue.Test, {
        id,
        body: { test: true },
        delaySeconds: 0,
        groupId: 'test',
        deduplicationId: id,
      });
    });

    it('should consume a dead letter from DLQ', async () => {
      jest.setTimeout(10000);

      await waitForExpect(() => {
        expect(fakeDLQProcessor.mock.calls.length).toBe(1);
      }, 9900, 500);
    });
  });
});