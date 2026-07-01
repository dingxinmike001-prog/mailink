/**
 * Cache management worker
 * Handles cache-related operations, including SQLite cache proxy and cache cleanup/optimization
 */

// Import dependencies
importScripts('./sqlite-cache-proxy.js');

// Cache configuration
const CACHE_CONFIG = {
    name: 'mailink-main-cache',
    maxSize: 1000,
    optimizationInterval: 60000 // Check every 1 minute
};

// Initialize cache instance
let sqliteCache;
let optimizationTimer;

/**
 * Initialize function
 */
async function init() {
    try {
        // Create SQLite cache proxy instance
        sqliteCache = new SQLiteCacheProxy(CACHE_CONFIG.name, CACHE_CONFIG.maxSize);
        
        // Wait for initialization to complete
        await sqliteCache.initPromise;
        
        // Start optimization timer
        startOptimizationTimer();
        
        return { success: true };
    } catch (error) {
        console.error('Cache initialization failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Start optimization timer
 */
function startOptimizationTimer() {
    // Clear existing timer
    if (optimizationTimer) {
        clearInterval(optimizationTimer);
    }
    
    // Set new timer
    optimizationTimer = setInterval(() => {
        optimizeCache();
    }, CACHE_CONFIG.optimizationInterval);
}

/**
 * Execute cache optimization
 */
async function optimizeCache() {
    try {
        // Check and optimize SQLite cache
        const sqliteSize = await sqliteCache.size();
        if (sqliteSize > CACHE_CONFIG.maxSize) {
            // SQLite cache LRU is handled automatically by the main process; only update in-memory cache here
            await sqliteCache.deleteOldest(sqliteSize - Math.floor(CACHE_CONFIG.maxSize * 0.8));
        }
        
        return { success: true };
    } catch (error) {
        console.error('Cache optimization failed:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Handle cache operation requests
 */
async function handleCacheOperation(type, payload) {
    try {
        let result;
        
        switch (type) {
            case 'init':
                result = await init();
                break;
                
            case 'has':
                // Check whether key exists (check SQLite cache)
                const sqliteHas = await sqliteCache.has(payload.key);
                result = { sqlite: sqliteHas, any: sqliteHas };
                break;
                
            case 'add':
                // Add key to cache (add to SQLite cache)
                await sqliteCache.add(payload.key);
                result = { success: true };
                break;
                
            case 'clear':
                // Clear cache (clear SQLite cache)
                await sqliteCache.clear();
                result = { success: true };
                break;
                
            case 'size':
                // Get cache size (get SQLite cache size)
                const sqliteSize = await sqliteCache.size();
                result = { sqlite: sqliteSize };
                break;
                
            case 'deleteOldest':
                // Delete least recently used record (delete record from SQLite cache)
                await sqliteCache.deleteOldest(payload.count);
                result = { success: true };
                break;
                
            case 'optimize':
                // Execute cache optimization
                result = await optimizeCache();
                break;
                
            default:
                throw new Error(`Unknown operation type: ${type}`);
        }
        
        return { success: true, data: result };
    } catch (error) {
        console.error(`Error handling ${type} operation:`, error);
        return { success: false, error: error.message };
    }
}

/**
 * Message handling logic
 */
self.onmessage = async (event) => {
    const { type, payload } = event.data;
    
    // Handle cache operation
    const result = await handleCacheOperation(type, payload);
    
    // Return result to main thread
    self.postMessage({
        type,
        result
    });
};

/**
 * Listen to error events
 */
self.onerror = (error) => {
    console.error('Cache manager worker error:', error);
};

// Initialize
init();
