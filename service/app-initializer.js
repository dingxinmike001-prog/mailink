const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const pathUtils = require('../shared/path/path-utils.js');

/**
 * App initializer module
 * Check and create all necessary directory structures immediately after app startup
 */

/**
 * Ensure directory exists (async version)
 * @param {string} dir - directory path
 * @returns {Promise<void>}
 */
async function ensureDirAsync(dir) {
    try {
        await fsPromises.mkdir(dir, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') {
            throw err;
        }
    }
}

/**
 * Initialize app base directory structure
 * Call immediately after app.whenReady
 * @returns {Promise<Object>} created directory path info
 */
async function initializeAppDirectories() {
    const startTime = Date.now();
    const exeDir = pathUtils.getBaseDir();
    
    // Define all base directories that need to be created
    const resourcesDir = path.join(exeDir, 'resources');
    const globalLogDir = path.join(resourcesDir, 'users', 'log');
    
    // Base directory list
    const baseDirs = [
        resourcesDir,
        globalLogDir
    ];
    
    // Create all base directories in parallel
    await Promise.all(
        baseDirs.map(dir => ensureDirAsync(dir))
    );
    
    const elapsed = Date.now() - startTime;
    console.log(`[AppInitializer] App base directories initialized, took ${elapsed}ms`);
    
    return {
        resourcesDir,
        globalLogDir,
        exeDir
    };
}

/**
 * Initialize user-specific directory structure
 * Call after user login
 * @param {string} username - user email address
 * @returns {Promise<Object>} created directory path info
 */
async function initializeUserDirectories(username) {
    if (!username) {
        throw new Error('Username cannot be empty');
    }
    
    const startTime = Date.now();
    
    // Use existing createUserDirectoriesAsync function
    const dirs = await pathUtils.createUserDirectoriesAsync(username);
    
    const elapsed = Date.now() - startTime;
    console.log(`[AppInitializer] User directories initialized (${username}), took ${elapsed}ms`);
    
    return dirs;
}

module.exports = {
    initializeAppDirectories,
    initializeUserDirectories,
    ensureDirAsync
};
