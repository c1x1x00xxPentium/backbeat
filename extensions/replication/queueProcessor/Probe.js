const { ProbeServer, DEFAULT_LIVE_ROUTE } =
    require('arsenal').network.probe.ProbeServer;

/**
 * Configure probe servers
 * @typedef {Object} ProbeServerConfig
 * @property {string} bindAddress - Address to bind probe server to
 * @property {number} port - Port to bind probe server to
 */

/**
 * Callback when Queue Processor Probe server is listening
 * @callback DoneCallback
 * @param {ProbeServer} [probeServer] - Probe server or undefined if disabled
 */

/**
 * Start probe server for Queue Processor
 * @param {Map<string, QueueProcessor>} queueProcessor - Queue processor
 * @param {ProbeServerConfig} config - Configuration for probe server
 * @param {DoneCallback} [callback] - Callback when probe server is up
 */
function startProbeServer(queueProcessors, config, callback) {
    if (process.env.CRR_METRICS_PROBE === 'false' || config === undefined) {
        callback();
        return;
    }
    const probeServer = new ProbeServer(config);
    probeServer.addHandler(
        DEFAULT_LIVE_ROUTE,
        (res, log) => {
            // take all our processors and create one liveness response
            let responses = [];
            Object.keys(queueProcessors).forEach(site => {
                const qp = queueProcessors[site];
                responses = responses.concat(qp.handleLiveness(log));
            });
            if (responses.length > 0) {
                return JSON.stringify(responses);
            }
            res.writeHead(200);
            res.end();
            return undefined;
        }
    );
    if (callback) {
        probeServer._cbOnListening = () => callback(probeServer);
    }
    probeServer.start();
    return undefined;
}

module.exports = { startProbeServer };
