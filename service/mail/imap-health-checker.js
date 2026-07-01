const ImapLogger = require('./imap-logger');

/**
 * IMAP connection health check module
 * Responsible for connection health detection and statistics
 */
const ImapHealthChecker = {

    _checkConnectionHealth(connInfo, username) {
        return new Promise(async (resolve) => {
            const imapLogger = ImapLogger.getInstance(username);

            if (!connInfo.imap || connInfo.imap.state !== 'authenticated') {
                imapLogger.info(`[ConnectionManager] connection status abnormal, unhealthy: ${username}, @:  ${connInfo.imap?.state || 'unknown'}`);
                resolve(false);
                return;
            }

            if (connInfo.imap.__mailinkBusy) {
                resolve(true);
                return;
            }

            const connectionAge = Date.now() - connInfo.lastActivity;
            if (connectionAge < this.minConnectionAge) {
                imapLogger.debug(`[ConnectionManager] connection just established, skipped health check: ${username}, establishment time: ${connectionAge}ms`);
                resolve(true);
                return;
            }

            connInfo.healthCheckFailures = (connInfo.healthCheckFailures || 0);

            for (let attempt = 1; attempt <= this.healthCheckMaxRetries; attempt++) {
                try {
                    const result = await this._performHealthCheckWithTimeout(connInfo, username, this.healthCheckTimeout);
                    
                    if (result) {
                        if (connInfo.healthCheckFailures > 0) {
                            imapLogger.info(`[ConnectionManager] connection health recovered, reset failure count: ${username}, previously failed: ${connInfo.healthCheckFailures}times`);
                        }
                        connInfo.healthCheckFailures = 0;
                        this._recordHealthCheckResult(true, username);
                        resolve(true);
                        return;
                    }

                    imapLogger.warn(`[ConnectionManager] health check failed (attempt ${attempt}/${this.healthCheckMaxRetries}): ${username}`);

                    if (attempt < this.healthCheckMaxRetries) {
                        await this._sleep(this.healthCheckRetryDelay * attempt);
                    }
                } catch (error) {
                    imapLogger.error(`[ConnectionManager] health check exception (attempt ${attempt}/${this.healthCheckMaxRetries}): ${username}`, error.message);

                    if (attempt < this.healthCheckMaxRetries) {
                        await this._sleep(this.healthCheckRetryDelay * attempt);
                    }
                }
            }

            connInfo.healthCheckFailures++;
            imapLogger.warn(`[ConnectionManager] connection health check consecutive failures ${connInfo.healthCheckFailures} times: ${username}`);

            if (connInfo.healthCheckFailures >= this.maxConsecutiveFailures) {
                imapLogger.error(`[ConnectionManager] connection consecutive failures exceeded${this.maxConsecutiveFailures}times, determined unhealthy: ${username}`);
                connInfo.healthCheckFailures = 0;
                this._recordHealthCheckResult(false, username);
                resolve(false);
                return;
            }

            imapLogger.info(`[ConnectionManager] connection temporarily unstable, gave recovery chance: ${username}, consecutive failures: ${connInfo.healthCheckFailures}times`);
            this._recordHealthCheckResult(true, username);
            resolve(true);
        });
    },

    _performHealthCheckWithTimeout(connInfo, username, timeout) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const imapLogger = ImapLogger.getInstance(username);
                imapLogger.warn(`[ConnectionManager] health check timeout (${timeout}ms): ${username}`);
                resolve(false);
            }, timeout);

            try {
                connInfo.imap.noop((err) => {
                    clearTimeout(timer);
                    const imapLogger = ImapLogger.getInstance(username);

                    if (err) {
                        imapLogger.debug(`[ConnectionManager] NOOPcommand failed: ${username}, error: ${err.message}`);
                        resolve(false);
                    } else {
                        imapLogger.debug(`[ConnectionManager] health check succeeded: ${username}`);
                        resolve(true);
                    }
                });
            } catch (error) {
                clearTimeout(timer);
                const imapLogger = ImapLogger.getInstance(username);
                imapLogger.error(`[ConnectionManager] health check exception: ${username}`, error);
                resolve(false);
            }
        });
    },

    _recordHealthCheckResult(isHealthy, username) {
        this.connectionStats.totalChecks++;
        if (isHealthy) {
            this.connectionStats.successfulChecks++;
        } else {
            this.connectionStats.failedChecks++;
        }

        if (this.connectionStats.totalChecks % 100 === 0) {
            const successRate = (this.connectionStats.successfulChecks / this.connectionStats.totalChecks * 100).toFixed(2);
            const imapLogger = ImapLogger.getInstance(username);
            imapLogger.info(`[ConnectionManager] health check statistics: ` +
                `total checks: ${this.connectionStats.totalChecks}, ` +
                `succeeded: ${this.connectionStats.successfulChecks}, ` +
                `failed: ${this.connectionStats.failedChecks}, ` +
                `success rate: ${successRate}%`);
        }
    },

    _recordConnectionLifetime(username) {
        const connInfo = this.mainPool.pool.get(username);
        if (connInfo && connInfo.connectionStartTime) {
            const lifetime = Date.now() - connInfo.connectionStartTime;
            this.connectionStats.connectionLifetimeSamples.push(lifetime);

            if (this.connectionStats.connectionLifetimeSamples.length > 100) {
                this.connectionStats.connectionLifetimeSamples.shift();
            }

            const sum = this.connectionStats.connectionLifetimeSamples.reduce((a, b) => a + b, 0);
            this.connectionStats.avgConnectionLifetime = sum / this.connectionStats.connectionLifetimeSamples.length;

            const imapLogger = ImapLogger.getInstance(username);
            imapLogger.info(`[ConnectionManager] connection lifetime statistics: ` +
                `this time: ${(lifetime/1000/60).toFixed(2)}minutes, ` +
                `average: ${(this.connectionStats.avgConnectionLifetime/1000/60).toFixed(2)}minutes`);
        }
    },

    getStats() {
        return {
            totalChecks: this.connectionStats.totalChecks,
            successfulChecks: this.connectionStats.successfulChecks,
            failedChecks: this.connectionStats.failedChecks,
            reconnections: this.connectionStats.reconnections,
            avgConnectionLifetime: this.connectionStats.avgConnectionLifetime,
            successRate: this.connectionStats.totalChecks > 0 
                ? (this.connectionStats.successfulChecks / this.connectionStats.totalChecks * 100).toFixed(2) + '%'
                : 'N/A'
        };
    },

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};

module.exports = { ImapHealthChecker };
