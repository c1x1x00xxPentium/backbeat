const http = require('http');
const assert = require('assert');

const werelogs = require('werelogs');
const Logger = werelogs.Logger;

const QueueProcessor = require('../../../extensions/replication' +
                               '/queueProcessor/QueueProcessor');
const ReplicateObject =
      require('../../../extensions/replication/tasks/ReplicateObject');

const constants = {
    bucket: 'test-bucket',
    objectKey: 'test-object',
    versionId: 'test-object-versionId',
    dataStoreName: 'us-east-1',
    // data size should be sufficient to have data held in the socket
    // buffers, 10MB seems to work
    contents: Buffer.alloc(10000000).fill('Z'),
};

const qpParams = [
    { hosts: 'localhost:9092' },
    { auth: { type: 'account', account: 'bart' },
      s3: { host: '127.0.0.1',
            port: 7777 },
      transport: 'http',
    },
    { auth: { type: 'account', account: 'bart' },
      bootstrapList: [{
          site: 'sf', servers: ['127.0.0.2:7777'],
      }],
      transport: 'http' },
    { topic: 'backbeat-func-test-dummy-topic',
      replicationStatusTopic: 'backbeat-func-test-repstatus',
      queueProcessor: {
          retry: {
              scality: { timeoutS: 5 },
          },
          groupId: 'backbeat-func-test-group-id',
      },
    },
    {},
    {},
    'sf',
    { topic: 'metrics-test-topic' },
];

const mockSourceEntry = {
    getLogInfo: () => ({}),
    getContentLength: () => constants.contents.length,
    getBucket: () => constants.bucket,
    getObjectKey: () => constants.objectKey,
    getEncodedVersionId: () => constants.versionId,
    getDataStoreName: () => constants.dataStoreName,
    getReplicationIsNFS: () => false,
    getOwnerId: () => 'bart',
    getContentMd5: () => 'bac4bea7bac4bea7bac4bea7bac4bea7',
    getReplicationStorageType: () => 'aws_s3',
    getUserMetadata: () => {},
    getContentType: () => 'application/octet-stream',
    getCacheControl: () => undefined,
    getContentDisposition: () => undefined,
    getContentEncoding: () => undefined,
    getTags: () => {},
    setReplicationSiteDataStoreVersionId: () => {},
};

const mockPartInfo = {
    key: 'bac4bea7bac4bea7bac4bea7bac4bea7bac4bea7',
    start: 0,
    size: constants.contents.length,
    dataStoreName: 'us-east-1',
    dataStoreETag: '1:',
};

const log = new Logger('test:streamedCopy');

class S3Mock {
    constructor() {
        this.log = new Logger('test:streamedCopy:S3Mock');

        this.testScenario = null;
    }

    setTestScenario(testScenario) {
        this.testScenario = testScenario;
    }

    onRequest(req, res) {
        if (req.method === 'PUT') {
            assert.strictEqual(
                req.url, `/_/backbeat/data/${constants.bucket}` +
                    `/${constants.objectKey}`);
            const chunks = [];
            req.on('data', chunk => {
                if (this.testScenario === 'abortPut') {
                    log.info('aborting PUT request');
                    res.socket.end();
                    res.socket.destroy();
                } else {
                    chunks.push(chunk);
                }
            });
            req.on('end', () => {
                res.write('[{"key":"target-key","dataStoreName":"us-east-2"}]');
                res.end();
            });
        } else if (req.method === 'GET') {
            assert.strictEqual(
                req.url, `/${constants.bucket}/${constants.objectKey}` +
                    `?partNumber=1&versionId=${constants.versionId}`);
            if (this.testScenario === 'abortGet') {
                log.info('aborting GET request');
                res.socket.end();
                res.socket.destroy();
            } else {
                res.write(constants.contents);
                res.end();
            }
        } else {
            assert(false, `did not expect HTTP method ${req.method}`);
        }
    }
}

describe('streamed copy functional tests', () => {
    let httpServer;
    let s3mock;
    let qp;
    beforeEach(done => {
        s3mock = new S3Mock();
        httpServer = http.createServer(
            (req, res) => s3mock.onRequest(req, res));
        httpServer.listen(7777);
        qp = new QueueProcessor(...qpParams);
        qp._mProducer = {
            getProducer: () => ({
                send: () => {},
            }),
            publishMetrics: () => {},
        };
        process.nextTick(done);
    });

    afterEach(done => {
        httpServer.close();
        process.nextTick(done);
    });

    [{ name: 'ReplicateObject::_getAndPutPartOnce',
       call: cb => {
           const repTask = new ReplicateObject(qp);
           repTask._setupSourceClients('dummyrole', log);
           repTask._setupDestClients('dummyrole', log);
           repTask._getAndPutPartOnce(
               mockSourceEntry, mockSourceEntry, mockPartInfo,
               log.newRequestLogger(), cb);
       },
     }].forEach(testedFunc => {
         ['noError', 'abortGet', 'abortPut'].forEach(testScenario => {
             it(`${testedFunc.name} with test scenario ${testScenario}`,
             done => {
                 s3mock.setTestScenario(testScenario);
                 testedFunc.call(err => {
                     if (testScenario === 'noError') {
                         assert.ifError(err);
                     } else {
                         assert(err);
                     }
                     // socket processing in the agent is asynchronous, so
                     // we have to make the check asynchronous too
                     setTimeout(() => {
                         if (testScenario === 'abortGet' ||
                             testScenario === 'abortPut') {
                             // check that sockets have been properly
                             // closed after an error occurred
                             const srcAgentSockets = qp.sourceHTTPAgent.sockets;
                             assert.strictEqual(
                                 Object.keys(srcAgentSockets).length, 0,
                                 'HTTP source agent still has open sockets');
                             const dstAgentSockets = qp.destHTTPAgent.sockets;
                             assert.strictEqual(
                                 Object.keys(dstAgentSockets).length, 0,
                                 'HTTP dest agent still has open sockets');
                         }
                         s3mock.setTestScenario(null);
                         done();
                     }, 0);
                 });
             });
         });
     });
});
