export const MIN_TRIGGER_INTERVAL = 5000;

export const DISCOVER_RETRY_CONFIG = {
    maxRetries: 3,
    retryDelay: 2000,
    timeout: 30000
};

export const DISCOVER_REPLY_RETRY_CONFIG = {
    replyTimeout: 30000,
    maxDiscoverRetries: 3,
    discoverRetryDelay: 5000
};

export const DISCOVER_DEDUP_CONFIG = {
    lockTimeout: 3000,
    minInterval: 3000,
    cacheExpiration: 60000,
    debounceDelay: 100,
    maxPendingCount: 1
};

export const DISCOVER_MESSAGE_ID_CONFIG = {
    counterPrefix: Math.floor(Math.random() * 1000000),
    counter: 0
};
