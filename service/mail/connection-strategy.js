/**
 * IMAP connection strategy configuration
 * Defines behavior differences for different connection types
 */
const ConnectionStrategy = {
    MAIN: {
        name: 'main',
        poolProperty: 'connections',
        heartbeatTimersProperty: 'heartbeatTimers',
        idleTimersProperty: 'idleTimers',
        supportsIdle: true,
        hasFetchLoop: false,
        openInboxMethod: '_openInbox',
        testIdleMethod: '_testIdleCommand',
        reconnectMethod: '_scheduleReconnect',
        startIdleMethod: '_startIdle',
        stopIdleMethod: '_stopIdle'
    },
    DELETE: {
        name: 'delete',
        poolProperty: 'deleteConnections',
        heartbeatTimersProperty: 'deleteHeartbeatTimers',
        idleTimersProperty: 'deleteIdleTimers',
        supportsIdle: true,
        hasFetchLoop: false,
        openInboxMethod: '_openDeleteInbox',
        testIdleMethod: '_testDeleteIdleCommand',
        reconnectMethod: '_scheduleDeleteReconnect',
        startIdleMethod: '_startDeleteIdle',
        stopIdleMethod: '_stopDeleteIdle'
    },
    IDLE: {
        name: 'idle',
        poolProperty: 'idleConnections',
        heartbeatTimersProperty: 'idleHeartbeatTimers',
        idleTimersProperty: 'idleIdleTimers',
        supportsIdle: true,
        hasFetchLoop: false,
        openInboxMethod: '_openIdleInbox',
        testIdleMethod: '_testIdleCommand',
        reconnectMethod: '_scheduleIdleReconnect',
        startIdleMethod: '_startIdle',
        stopIdleMethod: '_stopIdle'
    },
    POLLING: {
        name: 'polling',
        poolProperty: 'pollingConnections',
        heartbeatTimersProperty: 'pollingHeartbeatTimers',
        idleTimersProperty: null,
        supportsIdle: false,
        hasFetchLoop: true,
        openInboxMethod: '_openPollingInbox',
        testIdleMethod: null,
        reconnectMethod: '_schedulePollingReconnect',
        startIdleMethod: null,
        stopIdleMethod: null
    },
    NORMAL_EMAIL: {
        name: 'normalEmail',
        poolProperty: 'normalEmailConnections',
        heartbeatTimersProperty: 'normalEmailHeartbeatTimers',
        idleTimersProperty: null,
        supportsIdle: false,
        hasFetchLoop: true,
        openInboxMethod: '_openNormalEmailInbox',
        testIdleMethod: null,
        reconnectMethod: '_scheduleNormalEmailReconnect',
        startIdleMethod: null,
        stopIdleMethod: null
    },
    FETCH_BODY: {
        name: 'fetchBody',
        poolProperty: 'fetchBodyConnections',
        heartbeatTimersProperty: 'fetchBodyHeartbeatTimers',
        idleTimersProperty: null,
        supportsIdle: true,
        hasFetchLoop: false,
        openInboxMethod: '_openFetchBodyInbox',
        testIdleMethod: '_testFetchBodyIdleCommand',
        reconnectMethod: '_scheduleFetchBodyReconnect',
        startIdleMethod: '_startFetchBodyIdle',
        stopIdleMethod: '_stopFetchBodyIdle'
    }
};

module.exports = { ConnectionStrategy };
