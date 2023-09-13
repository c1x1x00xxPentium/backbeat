const assert = require('assert');
const async = require('async');

const BackbeatProducer = require('../../../lib/BackbeatProducer');
const BackbeatConsumer = require('../../../lib/BackbeatConsumer');
const zookeeperConf = { connectionString: 'localhost:2181' };
const kafkaConf = { hosts: 'localhost:9092' };
const producerKafkaConf = {
    hosts: 'localhost:9092',
};
const consumerKafkaConf = {
    hosts: 'localhost:9092',
    backlogMetrics: {
        zkPath: '/test/kafka-backlog-metrics',
        intervalS: 1,
    },
};

describe('BackbeatConsumer concurrency tests', () => {
    const topicConc = 'backbeat-consumer-spec-conc-1000';
    const groupIdConc = `replication-group-conc-${Math.random()}`;
    let producer;
    let consumer;
    let consumedMessages = [];

    function queueProcessor(message, cb) {
        if (message.value.toString() !== 'taskStuck') {
            consumedMessages.push(message.value);
            process.nextTick(cb);
        }
    }
    before(function before(done) {
        this.timeout(60000);

        producer = new BackbeatProducer({
            kafka: kafkaConf,
            topic: topicConc,
            pollIntervalMs: 100,
        });
        consumer = new BackbeatConsumer({
            zookeeper: zookeeperConf,
            kafka: kafkaConf, groupId: groupIdConc, topic: topicConc,
            queueProcessor,
            concurrency: 10,
            bootstrap: true,
        });
        async.parallel([
            innerDone => producer.on('ready', innerDone),
            innerDone => consumer.on('ready', innerDone),
        ], done);
    });
    afterEach(() => {
        consumedMessages = [];
        consumer.removeAllListeners('consumed');
    });
    after(done => {
        async.parallel([
            innerDone => producer.close(innerDone),
            innerDone => consumer.close(innerDone),
        ], done);
    });

    it('should be able to process 1000 messages with concurrency', done => {
        const boatloadOfMessages = [];
        for (let i = 0; i < 1000; ++i) {
            boatloadOfMessages.push({
                key: `message-${i}`,
                message: `{"message_index":"${i}"}`,
            });
        }
        async.series([
            next => {
                setTimeout(() => producer.send(boatloadOfMessages, err => {
                    assert.ifError(err);
                }), 1000);
                let totalConsumed = 0;
                consumer.subscribe();
                consumer.on('consumed', messagesConsumed => {
                    totalConsumed += messagesConsumed;
                    assert(totalConsumed <= boatloadOfMessages.length);
                    if (totalConsumed === boatloadOfMessages.length) {
                        next();
                    }
                });
            },
            next => {
                // looping to ease reporting when test fails
                // (otherwise node gets stuck for ages during diff
                // generation with an assert.deepStrictEqual() on
                // whole message arrays)
                assert.strictEqual(consumedMessages.length,
                                   boatloadOfMessages.length);
                for (let i = 0; i < consumedMessages.length; ++i) {
                    assert.deepStrictEqual(consumedMessages[i].toString(),
                                           boatloadOfMessages[i].message);
                }
                next();
            },
        ], done);
    });

    it('should not prevent progress with concurrency if one task is stuck',
    done => {
        const boatloadOfMessages = [];
        const stuckIndex = 500;
        for (let i = 0; i < 1000; ++i) {
            boatloadOfMessages.push({
                key: `message-${i}`,
                message: i === stuckIndex ?
                    'taskStuck' : `{"message_index":"${i}"}`,
            });
        }
        async.series([
            next => {
                setTimeout(() => producer.send(boatloadOfMessages, err => {
                    assert.ifError(err);
                }), 1000);
                let totalConsumed = 0;
                consumer.subscribe();
                consumer.on('consumed', messagesConsumed => {
                    totalConsumed += messagesConsumed;
                    assert(totalConsumed <= boatloadOfMessages.length);
                    if (totalConsumed === boatloadOfMessages.length) {
                        next();
                    }
                });
            },
            next => {
                // looping to ease reporting when test fails
                // (otherwise node gets stuck for ages during diff
                // generation with an assert.deepStrictEqual() on
                // whole message arrays)
                assert.strictEqual(consumedMessages.length,
                                   boatloadOfMessages.length - 1);
                for (let i = 0; i < consumedMessages.length; ++i) {
                    assert.deepStrictEqual(
                        consumedMessages[i].toString(),
                        i < stuckIndex ?
                            boatloadOfMessages[i].message :
                            boatloadOfMessages[i + 1].message);
                }
                next();
            },
        ], done);
    });
});

describe('BackbeatConsumer "deferred committable" tests', () => {
    const topicConc = 'backbeat-consumer-spec-deferred';
    const groupIdConc = `replication-group-deferred-${Math.random()}`;
    let producer;
    let consumer;
    let consumedMessages = [];

    function queueProcessor(message, cb) {
        consumedMessages.push(message.value);
        if (JSON.parse(message.value.toString()).deferred) {
            process.nextTick(() => cb(null, { committable: false }));
            setTimeout(() => {
                consumer.onEntryCommittable(message);
            }, 900 + Math.floor(Math.random() * 200));
        } else {
            process.nextTick(cb);
        }
    }
    before(function before(done) {
        this.timeout(60000);

        producer = new BackbeatProducer({
            kafka: kafkaConf,
            topic: topicConc,
            pollIntervalMs: 100,
        });
        consumer = new BackbeatConsumer({
            zookeeper: zookeeperConf,
            kafka: kafkaConf, groupId: groupIdConc, topic: topicConc,
            queueProcessor,
            concurrency: 10,
            bootstrap: true,
        });
        async.parallel([
            innerDone => producer.on('ready', innerDone),
            innerDone => consumer.on('ready', innerDone),
        ], done);
    });
    afterEach(() => {
        consumedMessages = [];
        consumer.removeAllListeners('consumed');
    });
    after(done => {
        async.parallel([
            innerDone => producer.close(innerDone),
            innerDone => consumer.close(innerDone),
        ], done);
    });

    it('should be able to process 1000 messages with some deferred ' +
    'committable status', done => {
        const boatloadOfMessages = [];
        for (let i = 0; i < 1000; ++i) {
            boatloadOfMessages.push({
                key: `message-${i}`,
                message: `{"message_index":"${i}",` +
                    `"deferred":${i % 2 === 0 ? 'true' : 'false'}}`,
            });
        }
        setTimeout(() => producer.send(boatloadOfMessages, err => {
            assert.ifError(err);
        }), 1000);
        let totalConsumed = 0;
        consumer.subscribe();
        consumer.on('consumed', messagesConsumed => {
            totalConsumed += messagesConsumed;
            assert(totalConsumed <= boatloadOfMessages.length);
            if (totalConsumed === boatloadOfMessages.length) {
                assert.strictEqual(
                    consumer.getOffsetLedger().getProcessingCount(),
                    500);
                // offsets are set to be committable after 1 second in this
                // test, so wait for 2 seconds
                setTimeout(() => {
                    assert.strictEqual(
                        consumer.getOffsetLedger().getProcessingCount(),
                        0);
                    done();
                }, 2000);
            }
        });
    });
});

describe('BackbeatConsumer statistics logging tests', () => {
    const topic = 'backbeat-consumer-spec-statistics';
    const groupId = `replication-group-${Math.random()}`;
    const messages = [
        { key: 'foo', message: '{"hello":"foo"}' },
        { key: 'bar', message: '{"world":"bar"}' },
        { key: 'qux', message: '{"hi":"qux"}' },
    ];
    let producer;
    let consumer;
    let consumedMessages = [];

    function queueProcessor(message, cb) {
        consumedMessages.push(message.value);
        process.nextTick(cb);
    }
    before(function before(done) {
        this.timeout(60000);

        producer = new BackbeatProducer({
            kafka: kafkaConf,
            topic,
            pollIntervalMs: 100,
        });
        consumer = new BackbeatConsumer({
            zookeeper: zookeeperConf,
            kafka: kafkaConf, groupId, topic,
            queueProcessor,
            concurrency: 10,
            bootstrap: true,
            // this enables statistics logging
            logConsumerMetricsIntervalS: 1,
        });
        async.parallel([
            innerDone => producer.on('ready', innerDone),
            innerDone => consumer.on('ready', innerDone),
        ], done);
    });
    afterEach(() => {
        consumedMessages = [];
        consumer.removeAllListeners('consumed');
    });
    after(done => {
        async.parallel([
            innerDone => producer.close(innerDone),
            innerDone => consumer.close(innerDone),
        ], done);
    });

    it('should be able to log consumer statistics', done => {
        producer.send(messages, err => {
            assert.ifError(err);
        });
        let totalConsumed = 0;
        // It would have been nice to check that the lag is strictly
        // positive when we haven't consumed yet, but the lag seems
        // off when no consumer offset has been written yet to Kafka,
        // so it cannot be tested reliably until we start consuming.
        consumer.subscribe();
        consumer.on('consumed', messagesConsumed => {
            totalConsumed += messagesConsumed;
            assert(totalConsumed <= messages.length);
            if (totalConsumed === messages.length) {
                let firstTime = true;
                setTimeout(() => {
                    consumer._log = {
                        error: () => {},
                        warn: () => {},
                        info: (message, args) => {
                            if (firstTime && message.indexOf('statistics') !== -1) {
                                firstTime = false;
                                assert.strictEqual(args.topic, topic);
                                const consumerStats = args.consumerStats;
                                assert.strictEqual(typeof consumerStats, 'object');
                                const lagStats = consumerStats.lag;
                                assert.strictEqual(typeof lagStats, 'object');
                                // there should be one consumed partition
                                assert.strictEqual(Object.keys(lagStats).length, 1);
                                // everything should have been
                                // consumed hence consumer offsets
                                // stored equal topic offset, and lag
                                // should be 0.
                                const partitionLag = lagStats['0'];
                                assert.strictEqual(partitionLag, 0);
                                done();
                            }
                        },
                        debug: () => {},
                        trace: () => {},
                    };
                }, 5000);
            }
        });
    }).timeout(30000);
});

describe('BackbeatConsumer with circuit breaker', () => {
    const nMessages = 0;

    const testCases = [
        {
            description: 'should consume if breaker state nominal',
            startDelayMs: 0,
            expectedMessages: nMessages,
            breakerConf: {
                probes: [
                    {
                        type: 'noop',
                        returnConstantValue: true,
                    },
                ],
            },
        },
        {
            description: 'should not consume if breaker state not nominal',
            startDelayMs: 50,
            expectedMessages: 0,
            breakerConf: {
                nominalEvaluateIntervalMs: 1,
                probes: [
                    {
                        type: 'noop',
                        returnConstantValue: false,
                    },
                ],
            },
        },
    ];

    testCases.forEach(t => {
        const topicBreaker = 'backbeat-consumer-spec-breaker';
        const groupIdBreaker = `replication-group-breaker-${Math.random()}`;
        let producer;
        let consumer;
        let consumedMessages = [];

        function queueProcessor(message, cb) {
            if (message.value.toString() !== 'taskStuck') {
                consumedMessages.push(message.value);
                process.nextTick(cb);
            }
        }
        before(function before(done) {
            this.timeout(60000);

            producer = new BackbeatProducer({
                kafka: producerKafkaConf,
                topic: topicBreaker,
                pollIntervalMs: 100,
            });
            consumer = new BackbeatConsumer({
                zookeeper: zookeeperConf,
                kafka: consumerKafkaConf, groupId: groupIdBreaker, topic: topicBreaker,
                queueProcessor,
                concurrency: 10,
                bootstrap: true,
                circuitBreaker: t.breakerConf,
            });
            async.parallel([
                innerDone => producer.on('ready', innerDone),
                innerDone => consumer.on('ready', innerDone),
            ], (err, res) => {
                setTimeout(() => done(err, res), t.startDelayMs);
            });
        });
        afterEach(() => {
            consumedMessages = [];
            consumer.removeAllListeners('consumed');
        });
        after(done => {
            async.parallel([
                innerDone => producer.close(innerDone),
                innerDone => consumer.close(innerDone),
            ], done);
        });

        it(t.description, done => {
            const boatloadOfMessages = [];
            for (let i = 0; i < nMessages; ++i) {
                boatloadOfMessages.push({
                    key: `message-${i}`,
                    message: `{"message_index":"${i}"}`,
                });
            }

            let totalConsumed = 0;

            async.series([
                next => {
                    setTimeout(() => producer.send(boatloadOfMessages, err => {
                        assert.ifError(err);
                    }), 1000);
                    consumer.subscribe();
                    setTimeout(next, 5000);
                    consumer.on('consumed', messagesConsumed => {
                        totalConsumed += messagesConsumed;
                    });
                },
                next => {
                    assert.strictEqual(totalConsumed, t.expectedMessages);
                    next();
                },
            ], done);
        });
    });
});
