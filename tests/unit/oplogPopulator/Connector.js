const assert = require('assert');
const sinon = require('sinon');
const werelogs = require('werelogs');

const Connector =
    require('../../../extensions/oplogPopulator/modules/Connector');

const logger = new werelogs.Logger('Connector');

const connectorConfig = {
    'name': 'example-connector',
    'database': 'metadata',
    'connection.uri': 'mongodb://user:password@localhost:27017,localhost:27018,' +
        'localhost:27019/?w=majority&readPreference=primary&replicaSet=rs0',
    'topic.namespace.map': '{*:"oplogTopic"}',
    'connector.class': 'com.mongodb.kafka.connect.MongoSourceConnector',
    'pipeline': '[]',
    'collection': '',
};

describe('Connector', () => {
    let connector;

    beforeEach(() => {
        connector = new Connector({
            name: 'example-connector',
            config: connectorConfig,
            buckets: [],
            isRunning: false,
            kafkaConnectHost: '127.0.0.1',
            kafkaConnectPort: 8083,
            logger,
        });
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('spawn', () => {
        it('Should spawn connector with correct pipeline', async () => {
            const createStub = sinon.stub(connector._kafkaConnect, 'createConnector')
                .resolves();
            assert.strictEqual(connector.isRunning, false);
            await connector.spawn();
            assert(createStub.calledOnceWith({
                name: 'example-connector',
                config: connectorConfig
            }));
            assert.strictEqual(connector.isRunning, true);
        });
        it('Should change partition name on creation', async () => {
            sinon.stub(connector._kafkaConnect, 'createConnector')
                .resolves();
            await connector.spawn();
            const partitionName = connector.config['offset.partition.name'];
            connector._isRunning = false;
            await connector.spawn();
            assert.notStrictEqual(partitionName, connector.config['offset.partition.name']);
        });
        it('Should not try spawning a new connector when on is already existent', async () => {
            const createStub = sinon.stub(connector._kafkaConnect, 'createConnector')
                .resolves();
            connector._isRunning = true;
            await connector.spawn();
            assert(createStub.notCalled);
        });
    });

    describe('destroy', () => {
        it('Should destroy connector', async () => {
            const deleteStub = sinon.stub(connector._kafkaConnect, 'deleteConnector')
                .resolves();
            connector._isRunning = true;
            assert.strictEqual(connector.isRunning, true);
            await connector.destroy();
            assert(deleteStub.calledOnceWith('example-connector'));
            assert.strictEqual(connector.isRunning, false);
        });
        it('Should not try destroying a new connector when connector is already destroyed', async () => {
            const deleteStub = sinon.stub(connector._kafkaConnect, 'deleteConnector')
                .resolves();
            connector._isRunning = false;
            await connector.destroy();
            assert(deleteStub.notCalled);
        });
        it('Should reset resume point', async () => {
            sinon.stub(connector._kafkaConnect, 'deleteConnector')
                .resolves();
            connector._isRunning = true;
            await connector.destroy();
            assert.strictEqual(connector.config['startup.mode.timestamp.start.at.operation.time'], undefined);
        });
    });

    describe('addBucket', () => {
        it('Should add bucket and update connector', async () => {
            const connectorUpdateStub = sinon.stub(connector, 'updatePipeline')
                .resolves();
            await connector.addBucket('example-bucket');
            assert(connectorUpdateStub.calledOnce);
            assert.strictEqual(connector._buckets.has('example-bucket'), true);
        });

        it('Should add bucket without updating connector', async () => {
            const connectorUpdateStub = sinon.stub(connector, 'updatePipeline')
                .resolves();
            await connector.addBucket('example-bucket', false);
            assert(connectorUpdateStub.calledWith(false));
        });
    });

    describe('removeBucket', () => {
        it('Should remove bucket and update connector', async () => {
            const connectorUpdateStub = sinon.stub(connector, 'updatePipeline')
                .resolves();
            connector._buckets.add('example-bucket');
            await connector.removeBucket('example-bucket');
            assert(connectorUpdateStub.calledOnce);
            assert.strictEqual(connector._buckets.has('example-bucket'), false);
        });

        it('Should remove bucket without updating connector', async () => {
            const connectorUpdateStub = sinon.stub(connector, 'updatePipeline')
                .resolves();
            await connector.removeBucket('example-bucket', false);
            assert(connectorUpdateStub.calledWith(false));
        });
    });

    describe('_generateConnectorPipeline', () => {
        it('Should return new pipeline', () => {
            const buckets = ['example-bucket-1', 'example-bucket-2'];
            const pipeline = connector._generateConnectorPipeline(buckets);
            assert.strictEqual(pipeline, JSON.stringify([
                {
                    $match: {
                        'ns.coll': {
                            $in: buckets,
                        }
                    }
                }
            ]));
        });
    });

    describe('_updateConnectorState', () => {
        it('Should update all fields when a bucket is added/removed', () => {
            const clock = sinon.useFakeTimers();
            clock.tick(100);
            connector._state.bucketsGotModified = false;
            const oldDate = connector._state.lastUpdated;
            connector._updateConnectorState(true);
            assert.strictEqual(connector._state.bucketsGotModified, true);
            assert.notEqual(oldDate, connector._state.lastUpdated);
        });

        it('Should update all fields when connector got updated and no other operations occured', () => {
            connector._state.bucketsGotModified = true;
            const oldDate = connector._state.lastUpdated;
            const now = Date.now();
            const clock = sinon.useFakeTimers();
            clock.tick(100);
            connector._updateConnectorState(false, now);
            assert.strictEqual(connector._state.bucketsGotModified, false);
            assert.notEqual(oldDate, connector._state.lastUpdated);
        });

        it('Should only update date incase an opetation happend while updating connector', () => {
            const oldDate = Date.now();
            connector._state.lastUpdated = oldDate;
            connector._state.bucketsGotModified = true;
            const clock = sinon.useFakeTimers();
            clock.tick(100);
            const now = Date.now();
            connector._updateConnectorState(false, now);
            assert.strictEqual(connector._state.bucketsGotModified, true);
            assert.notEqual(oldDate, connector._state.lastUpdated);
        });
    });

    describe('updatePipeline', () => {
        it('Should only update connector pipeline data if conditions are met', async () => {
            connector._state.bucketsGotModified = true;
            connector._state.isUpdating = false;
            const pipelineStub = sinon.stub(connector, '_generateConnectorPipeline')
                .returns('example-pipeline');
            const updateStub = sinon.stub(connector._kafkaConnect, 'updateConnectorConfig')
                .resolves();
            const didUpdate = await connector.updatePipeline();
            assert.strictEqual(didUpdate, false);
            assert(pipelineStub.calledOnceWith([]));
            assert(updateStub.notCalled);
        });

        it('Should update connector', async () => {
            connector._state.bucketsGotModified = true;
            connector._state.isUpdating = false;
            connector._isRunning = true;
            const pipelineStub = sinon.stub(connector, '_generateConnectorPipeline')
                .returns('example-pipeline');
            const updateStub = sinon.stub(connector._kafkaConnect, 'updateConnectorConfig')
                .resolves();
            const didUpdate = await connector.updatePipeline(true);
            assert.strictEqual(didUpdate, true);
            assert(pipelineStub.calledOnceWith([]));
            assert(updateStub.calledOnceWith('example-connector', connector._config));
        });

        it('Should not update when buckets assigned to connector haven\'t changed', async () => {
            connector._state.bucketsGotModified = false;
            connector._state.isUpdating = false;
            const pipelineStub = sinon.stub(connector, '_generateConnectorPipeline')
                .returns('example-pipeline');
            const updateStub = sinon.stub(connector._kafkaConnect, 'updateConnectorConfig')
                .resolves();
            const didUpdate = await connector.updatePipeline(true);
            assert.strictEqual(didUpdate, false);
            assert(pipelineStub.notCalled);
            assert(updateStub.notCalled);
        });

        it('Should not update when connector is updating', async () => {
            connector._state.bucketsGotModified = true;
            connector._state.isUpdating = true;
            const pipelineStub = sinon.stub(connector, '_generateConnectorPipeline')
                .returns('example-pipeline');
            const updateStub = sinon.stub(connector._kafkaConnect, 'updateConnectorConfig')
                .resolves();
            const didUpdate = await connector.updatePipeline(true);
            assert.strictEqual(didUpdate, false);
            assert(pipelineStub.notCalled);
            assert(updateStub.notCalled);
        });

        it('Should not update destroyed connector', async () => {
            connector._state.bucketsGotModified = true;
            connector._state.isUpdating = false;
            connector._isRunning = false;
            const pipelineStub = sinon.stub(connector, '_generateConnectorPipeline')
                .returns('example-pipeline');
            const updateStub = sinon.stub(connector._kafkaConnect, 'updateConnectorConfig')
                .resolves();
            const didUpdate = await connector.updatePipeline(true);
            assert.strictEqual(didUpdate, false);
            assert(pipelineStub.calledOnceWith([]));
            assert(updateStub.notCalled);
        });
    });

    describe('getConfigSizeInBytes', () => {
        it('Should return correct size in bytes', () => {
            connector._config = { key: 'value' };
            const size = connector.getConfigSizeInBytes();
            assert.strictEqual(size, 15);
        });
    });

    describe('updatePartitionName', () => {
        it('Should update partition name in config', () => {
            connector._config['offset.partition.name'] = 'partition-name';
            connector.updatePartitionName();
            assert.notStrictEqual(connector._config['offset.partition.name'], 'partition-name');
        });
    });

    describe('setResumePoint', () => {
        it('Should not set the resume point when resume point already set', () => {
            connector._isRunning = false;
            connector._config['startup.mode.timestamp.start.at.operation.time'] = '2023-11-15T16:18:53.000Z';
            connector.setResumePoint(new Date('2023-11-16T16:18:53.000Z'));
            assert.strictEqual(
                connector.config['startup.mode.timestamp.start.at.operation.time'],
                '2023-11-15T16:18:53.000Z',
            );
        });

        it('Should set the resume point when not present and connector is stopped', () => {
            connector._isRunning = false;
            delete connector._config['startup.mode.timestamp.start.at.operation.time'];

            connector.setResumePoint(new Date('2023-11-16T16:18:53.000Z'));
            assert.strictEqual(
                connector.config['startup.mode.timestamp.start.at.operation.time'],
                '2023-11-16T16:18:53.000Z',
            );
        });
    });
});
