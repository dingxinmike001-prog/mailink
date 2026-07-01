const { parentPort } = require('worker_threads');
const logger = require('../logger');

/**
 * Execute connection health check
 * @param {Object} connInfo - Connection info
 * @param {string} username - Username
 * @returns {Promise<boolean>} Whether connection is healthy
 */
function checkConnectionHealth(connInfo, username) {
    return new Promise((resolve) => {
        // If connection state is not authenticated, directly return unhealthy
        if (!connInfo.imap || connInfo.imap.state !== 'authenticated') {
            logger.info(`[ConnectionManager] connection status abnormal, unhealthy: ${username}, @:  ${connInfo.imap?.state || 'unknown'}`);
            resolve(false);
            return;
        }

        // Send NOOP command to check connection health
        try {
            connInfo.imap.noop((err) => {
                if (err) {
                    logger.error(`[ConnectionManager] connection health check failed: ${username}`, err);
                    resolve(false);
                } else {
                    logger.debug(`[ConnectionManager] connection health check succeeded: ${username}`);
                    resolve(true);
                }
            });
        } catch (error) {
            logger.error(`[ConnectionManager] connection health check exception: ${username}`, error);
            resolve(false);
        }
    });
}

// Listen to messages from the main thread
parentPort.on('message', async ({ connInfo, username, checkId }) => {
    try {
        const isHealthy = await checkConnectionHealth(connInfo, username);
        parentPort.postMessage({ checkId, isHealthy });
    } catch (error) {
        logger.error(`[ConnectionManager] health checkWorkerexecution exception: ${username}`, error);
        parentPort.postMessage({ checkId, isHealthy: false });
    }
});