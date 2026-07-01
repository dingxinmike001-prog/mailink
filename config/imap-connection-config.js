module.exports = {
    connection: {
        timeout: 30000,
        connTimeout: 30000,
        authTimeout: 20000
    },
    
    healthCheck: {
        timeout: 10000,
        maxRetries: 2,
        retryDelay: 1000,
        maxConsecutiveFailures: 3,
        minConnectionAge: 10000,
        checkInterval: 120000
    },

    reconnect: {
        maxRetries: 3,
        baseDelay: 3000,
        maxDelay: 300000,
        backoffMultiplier: 1.5,
        jitterRange: 0.2,
        maxConsecutiveFailuresForBackoff: 5,
        backoffDuration: 30 * 60 * 1000
    },

    heartbeat: {
        interval: 120000,
        idleInterval: 300000,
        forceNoop: false
    },

    monitoring: {
        enabled: true,
        statsInterval: 100,
        maxLifetimeSamples: 100
    },

    logging: {
        detailed: true,
        logHealthChecks: true,
        logReconnections: true,
        logStats: true
    }
};
