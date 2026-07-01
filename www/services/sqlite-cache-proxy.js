/**
 * SQLite Cache Proxy for Renderer Process
 * Implements an IDBCache-compatible API using an SQLite database for storage
 */

class SQLiteCacheProxy {
    constructor(name, maxSize = 1000) {
        this.name = name;
        this.maxSize = maxSize;
        this.memoryCache = new Map(); // In-memory cache to speed up access
        this.isInitialized = false;
        this.initPromise = this.init();
    }
    
    /**
     * Initialize the cache
     */
    async init() {
        this.isInitialized = true;
        return Promise.resolve();
    }
    
    /**
     * Check whether a key exists
     * @param {string} key - key to check
     * @returns {Promise<boolean>} - whether the key exists
     */
    async has(key) {
        // Check the in-memory cache first
        if (this.memoryCache.has(key)) {
            return true;
        }
        
        try {
            // Call the main process IPC service
            const result = await window.electron.ipcRenderer.invoke('sqlite-cache-has', {
                cacheName: this.name,
                key: key
            });
            
            // Update the in-memory cache if it exists
            if (result) {
                this.memoryCache.set(key, {
                    lastAccessTime: Date.now(),
                    createdTime: Date.now()
                });
            }
            
            return result;
        } catch (error) {
            console.error('Error in SQLiteCacheProxy.has:', error);
            return false;
        }
    }
    
    /**
     * Add a key to the cache
     * @param {string} key - key to add
     * @returns {Promise<void>}
     */
    async add(key) {
        const now = Date.now();
        
        // Update the in-memory cache
        this.memoryCache.set(key, {
            lastAccessTime: now,
            createdTime: now
        });
        
        try {
            // Call the main process IPC service
            await window.electron.ipcRenderer.invoke('sqlite-cache-add', {
                cacheName: this.name,
                key: key,
                maxSize: this.maxSize
            });
        } catch (error) {
            console.error('Error in SQLiteCacheProxy.add:', error);
            // Even if the IPC call fails, the in-memory cache is retained
        }
    }
    
    /**
     * Clear the cache
     * @returns {Promise<void>}
     */
    async clear() {
        // Clear the in-memory cache
        this.memoryCache.clear();
        
        try {
            // Call the main process IPC service
            await window.electron.ipcRenderer.invoke('sqlite-cache-clear', {
                cacheName: this.name
            });
        } catch (error) {
            console.error('Error in SQLiteCacheProxy.clear:', error);
        }
    }
    
    /**
     * Get the cache size
     * @returns {Promise<number>} - cache size
     */
    async size() {
        try {
            // Call the main process IPC service
            const result = await window.electron.ipcRenderer.invoke('sqlite-cache-size', {
                cacheName: this.name
            });
            return result;
        } catch (error) {
            console.error('Error in SQLiteCacheProxy.size:', error);
            return 0;
        }
    }
    
    /**
     * Delete the least recently used records
     * @param {number} count - number of records to delete
     * @returns {Promise<void>}
     */
    async deleteOldest(count) {
        // In-memory cache handling
        if (this.memoryCache.size > count) {
            // Convert the Map to an array and sort by access time
            const entries = Array.from(this.memoryCache.entries());
            entries.sort((a, b) => a[1].lastAccessTime - b[1].lastAccessTime);
            
            // Delete the oldest records
            const keysToDelete = entries.slice(0, count).map(entry => entry[0]);
            keysToDelete.forEach(key => this.memoryCache.delete(key));
        }
        
        // SQLite database LRU is automatically handled by the main process
        // No additional call is needed here
    }
}

// Export the class for Worker environments
if (typeof self !== 'undefined') {
    self.SQLiteCacheProxy = SQLiteCacheProxy;
} else if (typeof module !== 'undefined' && module.exports) {
    module.exports = SQLiteCacheProxy;
}