const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;

function getBaseDir() {
  let exeDir;
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      exeDir = path.dirname(process.execPath);
      console.log('[PathUtils] Packaged mode detected (via Electron). exeDir:', exeDir);
    } else {
      exeDir = path.resolve(__dirname, '../..');
      console.log('[PathUtils] Dev mode detected (via Electron). exeDir:', exeDir);
    }
  } catch {
    // Electron unavailable (e.g., Worker threads), use process.execPath to determine
    // After packaging: process.execPath points to the .exe file (e.g., app.exe)
    // In development: process.execPath points to node.exe or electron.exe (inside node_modules)
    const execPath = process.execPath;
    const execName = path.basename(execPath).toLowerCase();

    const isElectronDevMode = execPath.includes('node_modules' + path.sep + 'electron') ||
                               execPath.includes('node_modules/electron');

    if (execName === 'node.exe' || execName === 'node' || isElectronDevMode) {
      exeDir = path.resolve(__dirname, '../..');
      console.log('[PathUtils] Dev mode detected (via process.execPath). exeDir:', exeDir);
    } else {
      exeDir = path.dirname(execPath);
      console.log('[PathUtils] Packaged mode detected (via process.execPath). exeDir:', exeDir);
    }
  }
  return exeDir;
}

function getResourcesDir() {
  const exeDir = getBaseDir();
  const resourcesDir = path.join(exeDir, 'resources');
  return resourcesDir;
}

async function getResourcesDirAsync() {
  const resourcesDir = getResourcesDir();

  try {
    await fsPromises.mkdir(resourcesDir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  return resourcesDir;
}

function getConfigDbPath() {
  const resourcesDir = getResourcesDir();
  return path.join(resourcesDir, 'sys', 'config.db');
}

function getUserDbPath(username) {
  const resourcesDir = getResourcesDir();
  const userDir = path.join(resourcesDir, 'users', username);
  const dbFilename = `${username}_emails.db`;
  return path.join(userDir, dbFilename);
}

/**
 * Get user-specific file directory root path
 * @param {string} username - email address
 * @returns {string} user file directory path
 */
function getUserFilesDir(username) {
  const resourcesDir = getResourcesDir();
  const userDir = path.join(resourcesDir, 'users', username);
  const filesDir = path.join(userDir, 'files');
  return filesDir;
}

/**
 * Get user-specific received files directory
 * @param {string} username - email address
 * @returns {string} received files directory path
 */
function getUserRecvsDir(username) {
  const userFilesDir = getUserFilesDir(username);
  const recvsDir = path.join(userFilesDir, 'recvs');
  return recvsDir;
}

/**
 * Get user-specific sent files directory
 * @param {string} username - email address
 * @returns {string} sent files directory path
 */
function getUserSendsDir(username) {
  const userFilesDir = getUserFilesDir(username);
  const sendsDir = path.join(userFilesDir, 'sends');
  return sendsDir;
}

/**
 * Get user-specific email attachment directory
 * @param {string} username - email address
 * @returns {string} email attachment directory path
 */
function getUserAttachmentDir(username) {
  const userFilesDir = getUserFilesDir(username);
  const attachmentDir = path.join(userFilesDir, 'attachment');
  return attachmentDir;
}

/**
 * Get user-specific log directory
 * @param {string} username - email address
 * @returns {string} log directory path
 */
function getUserLogDir(username) {
  const resourcesDir = getResourcesDir();
  const userDir = path.join(resourcesDir, 'users', username);
  const logDir = path.join(userDir, 'log');
  return logDir;
}

/**
 * Create all directory structures needed by the user(async version)
 * called before IMAP login, ensure all folders are ready
 * @param {string} username - email address
 * @returns {Promise<Object>} created directory path info
 */
async function createUserDirectoriesAsync(username) {
  const exeDir = getBaseDir();
  const resourcesDir = path.join(exeDir, 'resources');
  const userDir = path.join(resourcesDir, 'users', username);
  const filesDir = path.join(userDir, 'files');
  const recvsDir = path.join(filesDir, 'recvs');
  const sendsDir = path.join(filesDir, 'sends');
  const attachmentDir = path.join(filesDir, 'attachment');
  const logDir = path.join(userDir, 'log');

  const dirsToCreate = [resourcesDir, userDir, filesDir, recvsDir, sendsDir, attachmentDir, logDir];
  
  await Promise.all(
    dirsToCreate.map(async (dir) => {
      try {
        await fsPromises.mkdir(dir, { recursive: true });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    })
  );

  return {
    userDir,
    filesDir,
    recvsDir,
    sendsDir,
    attachmentDir,
    logDir
  };
}

module.exports = {
  getBaseDir,
  getResourcesDir,
  getResourcesDirAsync,
  getConfigDbPath,
  getUserDbPath,
  getUserFilesDir,
  getUserRecvsDir,
  getUserSendsDir,
  getUserAttachmentDir,
  getUserLogDir,
  createUserDirectoriesAsync
};
