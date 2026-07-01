const { app, BrowserWindow, dialog, Tray, Menu, nativeImage, clipboard } = require('electron');

const path = require('path');
const fs = require('fs');
const fsPromises = fs.promises;

// Import the app initializer module (directories must be initialized before logger)
const appInitializer = require('./service/app-initializer');

// Import the logger module
const logger = require('./service/logger');
const httpServerManager = require('./service/http/http-server-manager');

// Import the file copy manager (Worker thread)
const fileCopyManager = require('./service/files/workers/file-copy-manager');

// Import path utility module
const pathUtils = require('./shared/path/path-utils');

// Import IPC manager
const { registerHandler } = require('./shared/ipc/ipc-manager');

// Register DevTools toggle handler
const { ipcMain } = require('electron');
ipcMain.handle('toggle-devtools', (event) => {
  const webContents = event.sender;
  if (webContents.isDevToolsOpened()) {
    webContents.closeDevTools();
  } else {
    webContents.openDevTools();
  }
});

// Register get renderer process ID handler
ipcMain.handle('get-renderer-id', (event) => {
  return event.sender.id;
});

// Window control handling
ipcMain.on('window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  switch (action) {
    case 'minimize':
      win.minimize();
      break;
    case 'maximize':
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
      break;
    case 'close':
      win.close();
      break;
  }
});

// After successful login, restore window size and show developer tools
ipcMain.handle('login-success', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { success: false, error: 'Window not found' };

  try {
    // Restore window size to 1200x800
    win.setSize(1200, 800);

    // Center display
    win.center();

    // Open developer tools
    if (!win.webContents.isDevToolsOpened()) {
      win.webContents.openDevTools();
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

/**
 * Chunk parsing of clipboard buffer to avoid blocking the main thread with large buffers
 * @param {Buffer} rawBuffer - original buffer
 * @returns {Promise<string[]>} array of parsed file paths
 */
async function parseClipboardBufferInChunks(rawBuffer) {
  const filePaths = [];
  let currentPath = '';
  const chunkSize = 2000; // Process 2000 characters at a time

  for (let offset = 0; offset < rawBuffer.length; offset += chunkSize * 2) {
    const end = Math.min(offset + chunkSize * 2, rawBuffer.length);

    for (let i = offset; i < end; i += 2) {
      const charCode = rawBuffer.readUInt16LE(i);
      if (charCode === 0) {
        if (currentPath) {
          filePaths.push(currentPath);
          currentPath = '';
        }
      } else {
        currentPath += String.fromCharCode(charCode);
      }
    }

    // Yield event loop after each chunk
    if (end < rawBuffer.length) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  // Process the last path
  if (currentPath) {
    filePaths.push(currentPath);
  }

  return filePaths;
}

// Register clipboard file read handler
ipcMain.handle('clipboard-read-files', async (event) => {
  try {
    // Get file paths from clipboard (when copying files in Windows Explorer)
    const rawBuffer = clipboard.readBuffer('FileNameW');
    if (rawBuffer && rawBuffer.length > 0) {
      // Parse Windows file paths (null-terminated Unicode strings)
      // Use chunked processing to avoid blocking the main thread with large buffers
      const filePaths = await parseClipboardBufferInChunks(rawBuffer);

      const validFiles = [];
      for (const filePath of filePaths) {
        try {
          const stats = await fsPromises.stat(filePath);
          if (stats.isFile()) {
            validFiles.push({
              path: filePath,
              name: path.basename(filePath),
              size: stats.size
            });
          }
        } catch (e) {
          // Ignore invalid paths
        }
      }

      if (validFiles.length > 0) {
        return { success: true, files: validFiles };
      }
    }
    
    // Try to read image data
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const pngBuffer = image.toPNG();
      return { 
        success: true, 
        image: {
          data: pngBuffer.toString('base64'),
          type: 'image/png',
          name: `clipboard-image-${Date.now()}.png`
        }
      };
    }
    
    // Try to read text
    const text = clipboard.readText();
    if (text) {
      return { success: true, text };
    }
    
    return { success: false, error: 'No readable content in clipboard' };
  } catch (err) {
    console.error('[Main] Failed to read clipboard:', err);
    return { success: false, error: err.message };
  }
});

// Import IMAP, SMTP, and SQLite modules
require('./service/mail/imap.js');
require('./service/mail/smtp.js');
require('./service/sqlite/sqlite.js');
require('./service/mail/contact-backup.js'); // Import contact backup module

// Import file writer Worker manager
const fileWriterManager = require('./service/files/workers/file-writer-manager');
const logAppendManager = require('./service/files/log-append-manager');

const FILE_WRITE_TRACE =
  process.env.MAILINK_FILE_WRITE_TRACE === '1' ||
  process.env.MAILINK_FILE_WRITE_TRACE === 'true' ||
  process.env.MAILINK_FILE_WRITE_TRACE === 'TRUE';

const FILE_TRANSFER_TRACE =
  process.env.MAILINK_FILE_TRANSFER_TRACE === '1' ||
  process.env.MAILINK_FILE_TRANSFER_TRACE === 'true' ||
  process.env.MAILINK_FILE_TRANSFER_TRACE === 'TRUE';

const fileWriteTraces = new Map();
const fileTransferProgressLogs = new Map();

function shouldLogTransferProgress(filePath, endOffset, totalSizeNum, closed) {
  if (FILE_TRANSFER_TRACE) return true;
  if (closed) return true;
  if (totalSizeNum > 0 && endOffset >= totalSizeNum) return true;
  if (endOffset <= 0) return false;

  const lastLogged = fileTransferProgressLogs.get(filePath) || 0;
  if (endOffset === lastLogged) return false;

  const interval = 2 * 1024 * 1024;
  if (endOffset - lastLogged >= interval || lastLogged === 0) {
    fileTransferProgressLogs.set(filePath, endOffset);
    return true;
  }
  return false;
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

// File processing utility functions
async function ensureDirectoryAsync(dir) {
  try {
    await fsPromises.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }
  return dir;
}

function convertToBuffer(fileData, isBase64 = false) {
  if (fileData instanceof ArrayBuffer) {
    return Buffer.from(fileData);
  } else if (Array.isArray(fileData)) {
    return Buffer.from(new Uint8Array(fileData));
  } else if (typeof fileData === 'string') {
    if (isBase64) {
      return Buffer.from(fileData, 'base64');
    }
    // Check whether it is a Base64 string
    const isBase64Data = fileData.length % 4 === 0 &&
                         /^[A-Za-z0-9+/]*={0,2}$/.test(fileData) &&
                         fileData.length > 100;
    if (isBase64Data) {
      return Buffer.from(fileData, 'base64');
    }
    return Buffer.from(fileData);
  }
  return Buffer.from(fileData);
}

/**
 * Save file - use File Writer Worker to avoid blocking the main thread
 * @param {string} filePath - file path
 * @param {Buffer} bufferData - file data
 * @returns {Promise<string>} - returns file path
 */
async function saveFile(filePath, bufferData) {
  // Use File Writer Worker for async writes to avoid blocking the main thread
  await fileWriterManager.writeFile(filePath, bufferData, 0, false, true);
  return filePath;
}

/**
 * Save file asynchronously - use fs.promises (kept for compatibility)
 * @param {string} filePath - file path
 * @param {Buffer} bufferData - file data
 * @returns {Promise<string>} - returns file path
 */
async function saveFileAsync(filePath, bufferData) {
  // Prefer using File Writer Worker
  await fileWriterManager.writeFile(filePath, bufferData, 0, false, true);
  return filePath;
}

if (FILE_WRITE_TRACE && typeof fileWriterManager.on === 'function') {
  fileWriterManager.on('telemetry', (data) => {
    if (!data || !data.filePath) return;
    const filePath = data.filePath;
    const fileName = data.fileName || path.basename(filePath);

    const trace = fileWriteTraces.get(filePath) || {
      filePath,
      fileName,
      msgId: null,
      userId: null,
      totalSize: 0,
      expectedNextOffset: 0,
      maxWrittenEnd: 0,
      writeCount: 0,
      outOfOrderCount: 0,
      gapBytes: 0,
      overlapBytes: 0,
      flushCount: 0
    };

    if (typeof data.flushCount === 'number') {
      trace.flushCount = data.flushCount;
    }

    fileWriteTraces.set(filePath, trace);

    if (data.event === 'flush') {
      logger.info(
        `[FILE_WRITE_TRACE] flush #${trace.flushCount} file=${fileName} reason=${data.reason || ''} start=${data.startPosition} bytes=${data.bytes}`
      );
    } else if (data.event === 'direct-write') {
      logger.info(
        `[FILE_WRITE_TRACE] direct-write file=${fileName} pos=${data.position} bytes=${data.bytes} flushCount=${trace.flushCount}`
      );
    }
  });
}

// Import Worker manager
const WorkerManager = require('./shared/worker/worker-manager');

// Create database Worker manager instance (single-Worker mode)
const dbWorkerManager = new WorkerManager({
  workerPath: path.join(__dirname, 'service/sqlite/workers/db.worker.js'),
  mode: 'single'
});




// Global main window reference
let mainWindow;

// System tray related variables
let tray = null;
let trayIcon = null;
let trayIconEmpty = null;
let isTrayIconFlashing = false;
let flashInterval = null;
let currentFlashAvatar = null; // Contact avatar used for current flashing
let currentUserAvatar = null; // Current logged-in user's avatar

// Avatar size configuration (system tray standard size)
const TRAY_ICON_SIZE = 16; // Windows system tray standard size

// Create window function
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 340,
    frame: false, // hide native title bar，use customHTMLtitle bar
    autoHideMenuBar: true, // hide top menu bar（pressAltdisplayable）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Note: webSecurity: false is to allow loading local files (file:// protocol)
      // In current code, file-transfer.js uses fetch('file://...') to read local files
      // TODO: In the future, serve files via HTTP server and then enable webSecurity
      webSecurity: false
    }
  });

  // Load HTML file
  mainWindow.loadFile('www/index.html');

  // Capture renderer console messages and errors, write to main process log
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelNames = ['verbose', 'info', 'warning', 'error'];
    const levelName = levelNames[level] || 'unknown';
    if (level >= 2) { // only log warning and error
      logger.warn(`[Renderer] [${levelName}] ${message} (${sourceId}:${line})`);
    }
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logger.error(`[Renderer] Renderer process crashed: ${JSON.stringify(details)}`);
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    logger.error(`[Renderer] Page load failed: ${errorCode} - ${errorDescription}`);
  });

  // Do not open DevTools by default (open via IPC after successful login)

  // Expose mainWindow globally for IMAP connection manager use
  global.mainWindow = mainWindow;

  // Ensure menu bar is hidden
  mainWindow.setMenuBarVisibility(false);

  // Hide to tray instead of quitting when window closes
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  // Stop tray flashing when window gains focus
  mainWindow.on('focus', () => {
    stopTrayFlash();
  });
}

async function createTray() {
  const iconPath = path.join(pathUtils.getResourcesDir(), 'sys', 'assets', 'icon.ico');

  try {
    await fsPromises.access(iconPath);
  } catch {
    logger.warn(`Tray icon file does not exist: ${iconPath}`);
    return;
  }

  trayIcon = nativeImage.createFromPath(iconPath);
  trayIconEmpty = nativeImage.createEmpty();
  
  tray = new Tray(trayIcon);
  tray.setToolTip('Mailink');
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          stopTrayFlash();
        }
      }
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
      stopTrayFlash();
    }
  });
  
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      stopTrayFlash();
    }
  });
  
  logger.info('System tray created successfully');
}

/**
 * Convert avatar data to NativeImage
 * @param {string} avatarData - avatar data (Base64 DataURL, SVG, or file path)
 * @returns {NativeImage|null} - Electron NativeImage object
 */
async function convertAvatarToNativeImage(avatarData) {
  if (!avatarData || typeof avatarData !== 'string') {
    return null;
  }

  try {
    let buffer = null;
    let extension = 'png';

    if (avatarData.startsWith('data:image')) {
      // Base64 DataURL format
      const matches = avatarData.match(/^data:image\/(\w+);base64,(.+)$/);
      if (matches) {
        extension = matches[1];
        buffer = Buffer.from(matches[2], 'base64');
      }
    } else if (avatarData.startsWith('<svg')) {
      // SVG format - needs to be converted to PNG (better handled in renderer using canvas)
      // Simplified handling: if SVG is small, return null and use the default icon
      logger.warn('SVG avatar needs to be converted to bitmap in renderer process first');
      return null;
    } else if (await fsPromises.access(avatarData).then(() => true).catch(() => false)) {
      // Local file path
      return nativeImage.createFromPath(avatarData).resize({
        width: TRAY_ICON_SIZE,
        height: TRAY_ICON_SIZE
      });
    }

    if (buffer) {
      // Create NativeImage and resize
      const image = nativeImage.createFromBuffer(buffer);
      return image.resize({
        width: TRAY_ICON_SIZE,
        height: TRAY_ICON_SIZE
      });
    }
  } catch (err) {
    logger.error('Avatar conversion failed:', err);
  }

  return null;
}

/**
 * Start tray icon flashing (using default icon)
 */
function startTrayFlash() {
  startTrayFlashWithAvatar(null);
}

/**
 * Start tray icon flashing (using contact avatar)
 * @param {string} avatarData - avatar data (optional)
 */
async function startTrayFlashWithAvatar(avatarData) {
  if (isTrayIconFlashing) {
    // If already flashing, stop first
    stopTrayFlash();
  }

  if (!tray) return;

  // Convert avatar
  let avatarIcon = null;
  if (avatarData) {
    avatarIcon = await convertAvatarToNativeImage(avatarData);
  }

  // Save currently used avatar
  currentFlashAvatar = avatarIcon;

  isTrayIconFlashing = true;
  let isVisible = true;

  flashInterval = setInterval(() => {
    if (tray && !tray.isDestroyed()) {
      if (avatarIcon) {
        // Flash between empty icon and contact avatar
        tray.setImage(isVisible ? trayIconEmpty : avatarIcon);
      } else {
        // Flash using default icon
        tray.setImage(isVisible ? trayIconEmpty : trayIcon);
      }
      isVisible = !isVisible;
    }
  }, 500);

  logger.info(`Tray icon started flashing${avatarIcon ? ' (using contact avatar)' : ''}`);
}

function stopTrayFlash() {
  if (!isTrayIconFlashing) return;

  if (flashInterval) {
    clearInterval(flashInterval);
    flashInterval = null;
  }

  // If current user avatar exists, restore to it; otherwise restore to default icon
  if (tray && !tray.isDestroyed()) {
    if (currentUserAvatar) {
      tray.setImage(currentUserAvatar);
    } else if (trayIcon) {
      tray.setImage(trayIcon);
    }
  }

  isTrayIconFlashing = false;
  currentFlashAvatar = null;
  logger.info('Tray icon stopped flashing');
}

/**
 * Set tray icon to current user avatar
 * @param {string} avatarData - avatar data (Base64 DataURL, PNG/JPEG)
 * @returns {Promise<boolean>} - whether setting succeeded
 */
async function setTrayIconToUserAvatar(avatarData) {
  if (!tray || !avatarData) {
    return false;
  }

  try {
    // Convert avatar to NativeImage
    const avatarIcon = await convertAvatarToNativeImage(avatarData);
    
    if (avatarIcon && tray && !tray.isDestroyed()) {
      // Save current user avatar
      currentUserAvatar = avatarIcon;
      
      // Update tray icon only when not flashing
      if (!isTrayIconFlashing) {
        tray.setImage(avatarIcon);
        logger.info('System tray icon has been set to current user avatar');
      } else {
        logger.info('Tray is flashing, user avatar will be shown after flashing stops');
      }
      return true;
    }
  } catch (err) {
    logger.error('Failed to set tray icon to user avatar:', err);
  }
  
  return false;
}

/**
 * Reset tray icon to default icon
 */
function resetTrayIconToDefault() {
  currentUserAvatar = null;
  
  if (tray && !tray.isDestroyed() && trayIcon) {
    tray.setImage(trayIcon);
    logger.info('System tray icon has been reset to default icon');
  }
}



app.whenReady().then(async () => {
  // Note: files directory is now user-isolated; no global files directory is created at app startup
  // Instead, create the corresponding user directory based on userId during specific file operations
  // resources/{username}/files/recvs/ and resources/{username}/files/sends/

  // Initialize app base directories first (resources, resources/log, etc.)
  try {
    const dirs = await appInitializer.initializeAppDirectories();
    console.log('[Main] App base directories initialized:', dirs);
  } catch (err) {
    console.error('[Main] Failed to initialize app base directories:', err);
    // directory initialization failure is a serious issue，but the app still tries to continue running
  }

  createWindow();
  await createTray();

  try {
    const port = await httpServerManager.startHttpServer();
    global.httpServerPort = port;
    logger.info(`HTTP server started, port: ${port} stored globally`);
  } catch (e) {
    logger.error('Failed to start HTTP server:', e);
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit app when all windows are closed
app.on('window-all-closed', async function () {
  if (process.platform !== 'darwin') {
    // Clean up all IMAP long connections
    try {
      const connectionManager = require('./service/mail/imap-connection-manager');
      connectionManager.disconnectAll();
      logger.info('All IMAP connections cleaned up on app quit');
    } catch (error) {
      logger.error('Error cleaning up IMAP connections:', error);
    }
    try {
      logAppendManager.closeAll();
    } catch (e) {
      logger.error('Error closing log append streams:', e);
    }
    try {
      const { cleanupDecoderPool } = require('./service/mail/streaming-decoder');
      await cleanupDecoderPool();
      logger.info('Decoder Worker pool cleaned up');
    } catch (e) {
      logger.error('Error cleaning up decoder worker pool:', e);
    }
    app.quit();
  }
});

// Cleanup before app quits
app.on('before-quit', async () => {
  try {
    const connectionManager = require('./service/mail/imap-connection-manager');
    connectionManager.disconnectAll();
    logger.info('All IMAP connections cleaned up before quit');
  } catch (error) {
    logger.error('Error cleaning up IMAP connections before quit:', error);
  }
  try {
    logAppendManager.closeAll();
  } catch (e) {
    logger.error('Error closing log append streams before quit:', e);
  }
  try {
    const { cleanupDecoderPool } = require('./service/mail/streaming-decoder');
    await cleanupDecoderPool();
    logger.info('Decoder Worker pool cleaned up');
  } catch (e) {
    logger.error('Error cleaning up decoder worker pool:', e);
  }
});

// IPC handler: read email config from database
registerHandler('load-email-configs-from-db', async () => {
  // Determine database file path to ensure it can still be found after packaging
  const dbPath = pathUtils.getConfigDbPath();

  // Send request to Worker thread
  return dbWorkerManager.sendTask({
    action: 'load-email-configs-from-db',
    dbPath
  });
});

// IPC handler: save email config to database
registerHandler('save-email-config', async (event, config) => {
  // Determine database file path to ensure it can still be found after packaging
  const dbPath = pathUtils.getConfigDbPath();

  // Send request to Worker thread
  return dbWorkerManager.sendTask({
    action: 'save-email-config',
    dbPath,
    config
  });
});

// IPC handler: update email config in database
registerHandler('update-email-config', async (event, id, config) => {
  // Determine database file path to ensure it can still be found after packaging
  const dbPath = pathUtils.getConfigDbPath();

  // Send request to Worker thread
  return dbWorkerManager.sendTask({
    action: 'update-email-config',
    dbPath,
    configId: id,
    config
  });
});

// IPC handler: write to log file
registerHandler('write-file', async (event, filePath, content, append) => {
  try {
    // Handle relative paths: if relative (starting with resources/), convert to absolute path
    let absolutePath = filePath;
    if (filePath.startsWith('resources/')) {
      const resourcesDir = pathUtils.getResourcesDir();
      absolutePath = path.join(resourcesDir, filePath.substring('resources/'.length));
    }

    if (append === true) {
      await logAppendManager.append(absolutePath, content);
      return true;
    }
    return await fileWriterManager.addToBatch({ filePath: absolutePath, content, position: 0 });
  } catch (err) {
    logger.error(`Failed to write file: ${filePath}`, err);
    throw err;
  }
});

// Import signaling state manager
const signalingStateManager = require('./service/mail/signaling-state-manager');

// IPC handler: signaling transfer status notification
registerHandler('signaling-state', async (event, action) => {
  try {
    if (action === 'start') {
      signalingStateManager.startSignaling();
    } else if (action === 'end') {
      signalingStateManager.endSignaling();
    }

    // Notify polling scheduler to enter high-frequency mode
    const state = signalingStateManager.getState();
    // Send message to renderer Worker via window webContents
    event.sender.send('signaling-state-changed', { active: state.isActive });

    return { success: true, state };
  } catch (err) {
    logger.error(`Signaling state management failed: ${action}`, err);
    throw err;
  }
});

// IPC handler: save received file
registerHandler('save-received-file', async (event, fileName, fileData, userId) => {
  try {
    logger.info(`Started saving file: ${fileName}, userId: ${userId}`);

    if (!userId) {
      throw new Error('userId is required');
    }

    // Ensure user-specific recvs directory exists
    const filesDir = pathUtils.getUserRecvsDir(userId);

    // File full path
    const filePath = path.join(filesDir, fileName);

    // Convert data and save
    const bufferData = convertToBuffer(fileData);
    await saveFile(filePath, bufferData);

    logger.info(`File saved successfully: ${filePath}, size: ${bufferData.length} bytes`);
    return { success: true, filePath };
  } catch (err) {
    logger.error(`Failed to save file: ${fileName}`, err);
    return { success: false, error: err.message, stack: err.stack };
  }
});

// IPC handler: get file status (used to check if file write is complete)
registerHandler('get-file-stats', async (event, filePath) => {
  try {
    if (!filePath) {
      return null;
    }
    
    const stats = await fsPromises.stat(filePath);
    return {
      size: stats.size,
      mtime: stats.mtime,
      isFile: stats.isFile()
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    logger.error(`Failed to get file status: ${filePath}`, err);
    return null;
  }
});

// IPC handler: read file and convert to Base64
registerHandler('read-file-as-base64', async (event, filePath) => {
  try {
    logger.info(`Started reading file and converting to Base64: ${filePath}`);

    if (!filePath) {
      logger.error('File path is empty');
      return null;
    }

    try {
      const fileBuffer = await fsPromises.readFile(filePath);
      const base64 = fileBuffer.toString('base64');
      
      logger.info(`File read successfully: ${filePath}, Base64 length: ${base64.length}`);
      return base64;
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.error(`File does not exist: ${filePath}`);
      }
      throw err;
    }
  } catch (err) {
    logger.error(`Failed to read file: ${filePath}`, err);
    return null;
  }
});

// IPC handler: save sent file (for cases like pasted images without local paths)
registerHandler('save-sent-file', async (event, fileName, fileData, userId) => {
  try {
    logger.info(`Started saving sent file: ${fileName}, userId: ${userId}`);

    if (!userId) {
      throw new Error('userId is required');
    }

    // Ensure user-specific sends directory exists (async)
    const filesDir = pathUtils.getUserSendsDir(userId);
    await ensureDirectoryAsync(filesDir);

    // File full path
    const filePath = path.join(filesDir, fileName);

    // Convert data and save (async)
    const bufferData = convertToBuffer(fileData);
    await saveFileAsync(filePath, bufferData);

    logger.info(`Sent file saved successfully: ${filePath}, size: ${bufferData.length} bytes`);
    return { success: true, filePath };
  } catch (err) {
    logger.error(`Failed to save sent file: ${fileName}`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: stream write file chunk
registerHandler('stream-write-file-chunk', async (event, fileName, fileData, offset, totalSize, msgId, userId, flush, storedFileName) => {
  try {
    const totalSizeNum = typeof totalSize === 'number' ? totalSize : Number(totalSize) || 0;

    if (!userId) {
      throw new Error('userId is required');
    }

    // Ensure user-specific recvs directory exists
    const filesDir = pathUtils.getUserRecvsDir(userId);

    const safeBaseName = sanitizeFilenamePart(path.basename(fileName || 'unknown'));
    
    // Prefer the passed storedFileName (used to reuse old file for resume)
    let finalStoredFileName;
    if (storedFileName) {
      finalStoredFileName = sanitizeFilenamePart(path.basename(storedFileName));
    } else {
      const safeMsgId = msgId ? sanitizeFilenamePart(msgId) : '';
      finalStoredFileName = safeMsgId ? `${safeMsgId}-${safeBaseName}` : safeBaseName;
    }

    const filePath = path.join(filesDir, finalStoredFileName);

    // Convert data to Buffer (streaming uses base64)
    const bufferData = convertToBuffer(fileData, true);

    if (FILE_WRITE_TRACE) {
      const trace = fileWriteTraces.get(filePath) || {
        filePath,
        fileName,
        msgId: msgId || null,
        userId: userId || null,
        totalSize: typeof totalSize === 'number' ? totalSize : Number(totalSize) || 0,
        expectedNextOffset: offset,
        maxWrittenEnd: offset,
        writeCount: 0,
        outOfOrderCount: 0,
        gapBytes: 0,
        overlapBytes: 0,
        flushCount: 0
      };

      const chunkLen = bufferData.length;
      const chunkEnd = offset + chunkLen;
      const expected = trace.expectedNextOffset;
      const delta = offset - expected;
      const isContiguous = delta === 0;

      trace.writeCount += 1;
      trace.maxWrittenEnd = Math.max(trace.maxWrittenEnd, chunkEnd);

      if (isContiguous) {
        trace.expectedNextOffset = chunkEnd;
      } else {
        trace.outOfOrderCount += 1;
        if (delta > 0) trace.gapBytes += delta;
        if (delta < 0) trace.overlapBytes += Math.abs(delta);
      }

      fileWriteTraces.set(filePath, trace);

      logger.info(
        `[FILE_WRITE_TRACE] write #${trace.writeCount} file=${fileName} msgId=${msgId || ''} offset=${offset} len=${chunkLen} expected=${expected} contiguous=${isContiguous ? 1 : 0} delta=${delta}`
      );
    }

    // Use async file write, supports writing at random positions
    const writtenBytes = bufferData.length;
    const endOffset = offset + writtenBytes;

    if (offset === 0 || FILE_TRANSFER_TRACE) {
      logger.info(
        `Started streaming receive write: ${storedFileName}, offset=${offset}, chunk=${writtenBytes}, total=${totalSizeNum || '?'}, flush=${!!flush}`
      );
    }

    // [NEW] The flush parameter here will be passed to fileWriterManager.writeFile
    await fileWriterManager.writeFile(filePath, bufferData, offset, false, !!flush);

    let closed = false;
    let verified = false;
    let actualSize = 0;

    if (totalSizeNum > 0 && endOffset >= totalSizeNum) {
      await fileWriterManager.closeFile(filePath);
      closed = true;

      try {
        const stats = await fsPromises.stat(filePath);
        actualSize = stats.size;
        verified = actualSize === totalSizeNum;
      } catch (e) {
        verified = false;
      }
    }

    // Resume transfer: update database record every 1MB offset increase (or if it's exactly the last chunk)
    if (msgId && userId && (offset % (1024 * 1024) === 0 || endOffset >= totalSizeNum)) {
      try {
        // Call internal logic directly to avoid IPC round-trips (or reuse if already registered)
        const sqlite = require('./service/sqlite/sqlite');
        const dbPath = pathUtils.getUserDbPath(userId);
        const now = Date.now();
        const sql = `INSERT OR REPLACE INTO transfer_metadata 
                     (msg_id, file_name, file_path, total_size, received_size, createtime, metadata) 
                     VALUES (?, ?, ?, ?, ?, 
                     COALESCE((SELECT createtime FROM transfer_metadata WHERE msg_id = ?), ?),
                     COALESCE((SELECT metadata FROM transfer_metadata WHERE msg_id = ?), NULL))`;

        const UnifiedDB = require('./service/sqlite/sqlite-unified').UnifiedDB;
        await UnifiedDB.execute(dbPath, sql, [
          msgId, finalStoredFileName, filePath, totalSizeNum, endOffset, msgId, now, msgId
        ]);

        logger.info(`[Main] Synced transfer progress to DB: ${finalStoredFileName}, Offset: ${endOffset}`);
      } catch (e) {
        logger.error('Failed to update file transfer metadata:', e);
      }
    }

    if (shouldLogTransferProgress(filePath, endOffset, totalSizeNum, closed)) {
      logger.info(
        `Streaming write progress: ${finalStoredFileName}, ${endOffset}/${totalSizeNum || '?'}${closed ? ', closed' : ''}`
      );
    }
    return { success: true, filePath, offset, writtenBytes, endOffset, closed, verified, actualSize, storedFileName: finalStoredFileName };
  } catch (err) {
    logger.error(`Failed to write file chunk: ${fileName}, offset: ${offset}`, err);
    return { success: false, error: err.message, stack: err.stack };
  }
});

// IPC handler: complete streaming file write (optional, used to mark completion status)
registerHandler('finalize-stream-file', async (event, fileName, msgId, totalSize, userId) => {
  try {
    logger.info(`[IPC] Started Finalize: ${fileName}, userId: ${userId}`);
    const totalSizeNum = typeof totalSize === 'number' ? totalSize : Number(totalSize) || 0;

    if (!userId) {
      throw new Error('userId is required');
    }

    // Ensure user-specific recvs directory exists
    const filesDir = pathUtils.getUserRecvsDir(userId);

    const safeBaseName = sanitizeFilenamePart(path.basename(fileName || 'unknown'));
    const safeMsgId = msgId ? sanitizeFilenamePart(msgId) : '';
    const storedFileName = safeMsgId ? `${safeMsgId}-${safeBaseName}` : safeBaseName;

    const filePath = path.join(filesDir, storedFileName);

    // Key fix: explicitly close file stream before verification to ensure data is flushed to disk
    await fileWriterManager.closeFile(filePath);

    logger.info(`File write completed (stream closed): ${filePath}`);

    let actualSize = 0;
    let verified = false;
    if (totalSizeNum > 0) {
      try {
        const stats = await fsPromises.stat(filePath);
        actualSize = stats.size;
        verified = actualSize === totalSizeNum;
      } catch (e) {
        verified = false;
      }
    }

    if (FILE_WRITE_TRACE) {
      const trace = fileWriteTraces.get(filePath);
      if (trace) {
        logger.info(
          `[FILE_WRITE_TRACE] summary file=${trace.fileName} msgId=${trace.msgId || ''} writes=${trace.writeCount} outOfOrder=${trace.outOfOrderCount} expectedNextOffset=${trace.expectedNextOffset} maxWrittenEnd=${trace.maxWrittenEnd} gapBytes=${trace.gapBytes} overlapBytes=${trace.overlapBytes} flushCount=${trace.flushCount}`
        );
      } else {
        logger.info(`[FILE_WRITE_TRACE] summary file=${fileName} (no trace record)`);
      }
    }

    // Check if file exists
    try {
      await fsPromises.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`File does not exist: ${filePath}`);
      }
      throw err;
    }

    // Resume transfer: transfer complete, delete metadata (if any)
    // Note: more parameters may be needed here to determine msgId and userId.
    // But deleteTransferMetadata is usually called in handleFileCompleteLocal.
    // We could also try to clean up based on fileName here, but it may not be accurate.
    // A better approach is to call delete-transfer-metadata from the frontend.

    logger.info(`File write completion verified: ${storedFileName}`);
    return { success: true, filePath: filePath, storedFileName, verified, actualSize };
  } catch (err) {
    logger.error(`Failed to complete streaming file write: ${fileName}`, err);
    return { success: false, error: err.message, stack: err.stack };
  }
});

// IPC handler: get path of sent file
registerHandler('get-sent-file-path', async (event, fileName, isSender, userId) => {
  try {
    if (!userId) {
      throw new Error('userId is required');
    }

    // Fix: check if fileName is empty
    if (!fileName || String(fileName).trim() === '') {
      logger.warn(`[IPC] get-sent-file-path: fileName is empty, cannot search for file`);
      return { success: false, error: 'fileName cannot be empty' };
    }

    const recvsDir = pathUtils.getUserRecvsDir(userId);
    const sendsDir = pathUtils.getUserSendsDir(userId);

    const recvPath = path.join(recvsDir, fileName);
    const sendPath = path.join(sendsDir, fileName);

    const findBestMatchedFilePath = async (baseDir, requestedName) => {
      try {
        if (!requestedName) {
          return '';
        }
        
        let dirExists = false;
        try {
          await fsPromises.stat(baseDir);
          dirExists = true;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        
        if (!dirExists) {
          return '';
        }

        const normalizedRequested = String(path.basename(requestedName)).trim();
        if (!normalizedRequested) {
          return '';
        }

        const requestedLower = normalizedRequested.toLowerCase();
        const suffixLower = `-${requestedLower}`;
        const prefixLower = `${requestedLower}-`;
        const allEntries = await fsPromises.readdir(baseDir, { withFileTypes: true });
        const fileEntries = allEntries.filter(entry => entry.isFile());
        if (fileEntries.length === 0) {
          return '';
        }

        let exactMatch = fileEntries.find(entry => entry.name === normalizedRequested);
        if (!exactMatch) {
          exactMatch = fileEntries.find(entry => entry.name.toLowerCase() === requestedLower);
        }
        if (exactMatch) {
          return path.join(baseDir, exactMatch.name);
        }

        const candidates = [];
        for (const entry of fileEntries) {
          const lowerName = entry.name.toLowerCase();
          let score = Number.MAX_SAFE_INTEGER;
          if (lowerName.endsWith(suffixLower)) {
            score = 0;
          } else if (lowerName.startsWith(prefixLower)) {
            score = 1;
          } else if (lowerName.includes(requestedLower)) {
            score = 2;
          }

          if (score !== Number.MAX_SAFE_INTEGER) {
            const fullPath = path.join(baseDir, entry.name);
            let mtimeMs = 0;
            try {
              const stats = await fsPromises.stat(fullPath);
              mtimeMs = stats.mtimeMs || 0;
            } catch (e) {
              mtimeMs = 0;
            }
            candidates.push({ fullPath, score, mtimeMs });
          }
        }

        if (candidates.length === 0) {
          return '';
        }

        candidates.sort((a, b) => {
          if (a.score !== b.score) {
            return a.score - b.score;
          }
          return b.mtimeMs - a.mtimeMs;
        });

        return candidates[0].fullPath;
      } catch (e) {
        logger.warn(`[IPC] get-sent-file-path: fallback match failed for ${requestedName} in ${baseDir}: ${e.message}`);
        return '';
      }
    };

    logger.info(`[IPC] get-sent-file-path: fileName=${fileName}, isSender=${isSender}, userId=${userId}`);

    // Decide which directory to search first based on isSender parameter
    if (isSender === true) {
      try {
        await fsPromises.stat(sendPath);
        logger.info(`[IPC] get-sent-file-path: sender found send copy: ${sendPath}`);
        return { success: true, filePath: sendPath };
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const matchedSendPath = await findBestMatchedFilePath(sendsDir, fileName);
      if (matchedSendPath) {
        logger.info(`[IPC] get-sent-file-path: sender fuzzy-matched send copy: ${matchedSendPath}`);
        return { success: true, filePath: matchedSendPath };
      }
    } else if (isSender === false) {
      try {
        await fsPromises.stat(recvPath);
        logger.info(`[IPC] get-sent-file-path: receiver found receive copy: ${recvPath}`);
        return { success: true, filePath: recvPath };
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const matchedRecvPath = await findBestMatchedFilePath(recvsDir, fileName);
      if (matchedRecvPath) {
        logger.info(`[IPC] get-sent-file-path: receiver fuzzy-matched receive copy: ${matchedRecvPath}`);
        return { success: true, filePath: matchedRecvPath };
      }
    } else {
      // isSender not specified, keep original logic (sends first, then recvs)
      try {
        await fsPromises.stat(sendPath);
        logger.info(`[IPC] get-sent-file-path: found send copy: ${sendPath}`);
        return { success: true, filePath: sendPath };
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      
      try {
        await fsPromises.stat(recvPath);
        logger.info(`[IPC] get-sent-file-path: found receive copy: ${recvPath}`);
        return { success: true, filePath: recvPath };
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      
      const matchedSendPath = await findBestMatchedFilePath(sendsDir, fileName);
      if (matchedSendPath) {
        logger.info(`[IPC] get-sent-file-path: fuzzy-matched send copy: ${matchedSendPath}`);
        return { success: true, filePath: matchedSendPath };
      }
      const matchedRecvPath = await findBestMatchedFilePath(recvsDir, fileName);
      if (matchedRecvPath) {
        logger.info(`[IPC] get-sent-file-path: fuzzy-matched receive copy: ${matchedRecvPath}`);
        return { success: true, filePath: matchedRecvPath };
      }
    }

    logger.warn(`[IPC] get-sent-file-path: file not found: ${fileName}, isSender=${isSender}, userId=${userId}`);
    return { success: false, error: 'File does not exist' };
  } catch (err) {
    logger.error(`Failed to get file path: ${fileName}`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: get file size
registerHandler('get-file-size', async (event, filePath) => {
  try {
    if (!filePath) {
      logger.warn(`[IPC] get-file-size: file path is empty`);
      return { success: false, error: 'File path is empty', size: 0 };
    }

    const stats = await fsPromises.stat(filePath);
    const size = stats.size;
    logger.info(`[IPC] get-file-size: file size retrieved successfully: ${filePath}, size=${size}`);
    return { success: true, size };
  } catch (err) {
    if (err.code === 'ENOENT') {
      logger.warn(`[IPC] get-file-size: file does not exist: ${filePath}`);
      return { success: false, error: 'File does not exist', size: 0 };
    }
    logger.error(`Failed to get file size: ${filePath}`, err);
    return { success: false, error: err.message, size: 0 };
  }
});

// IPC handler: show save dialog
registerHandler('show-save-dialog', async (event, options) => {
  try {
    const result = await dialog.showSaveDialog(options);
    return { success: true, ...result };
  } catch (err) {
    logger.error(`Failed to show save dialog:`, err);
    return { success: false, error: err.message, canceled: true };
  }
});

// IPC handler: copy file
registerHandler('copy-file', async (event, sourcePath, targetPath) => {
  try {
    try {
      await fsPromises.stat(sourcePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { success: false, error: 'Source file does not exist' };
      }
      throw err;
    }

    await fsPromises.copyFile(sourcePath, targetPath);
    logger.info(`[IPC] File copied successfully: ${sourcePath} -> ${targetPath}`);
    return { success: true, targetPath };
  } catch (err) {
    logger.error(`Failed to copy file:`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: show file in folder
registerHandler('show-item-in-folder', async (event, filePath) => {
  try {
    try {
      await fsPromises.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn(`[IPC] show-item-in-folder: file does not exist: ${filePath}`);
        return { success: false, error: 'File does not exist' };
      }
      throw err;
    }

    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
    logger.info(`[IPC] Showed file in folder: ${filePath}`);
    return { success: true };
  } catch (err) {
    logger.error(`Failed to show file in folder:`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: open file with system default program
registerHandler('open-file', async (event, filePath) => {
  try {
    try {
      await fsPromises.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn(`[IPC] open-file: file does not exist: ${filePath}`);
        return { success: false, error: 'File does not exist' };
      }
      throw err;
    }

    const { shell } = require('electron');
    const result = await shell.openPath(filePath);
    if (result) {
      logger.warn(`[IPC] open-file: error occurred while opening file: ${result}`);
      return { success: false, error: result };
    }
    logger.info(`[IPC] Opened file: ${filePath}`);
    return { success: true };
  } catch (err) {
    logger.error(`Failed to open file:`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: copy file to sends directory (using Worker thread)
registerHandler('copy-file-to-sends', async (event, sourcePath, transferId, userId) => {
  logger.info(`[IPC] Handling copy-file-to-sends request for: ${sourcePath}, transferId: ${transferId}, userId: ${userId}`);
  try {
    if (!sourcePath) {
      throw new Error('Source file path cannot be empty');
    }

    if (!userId) {
      throw new Error('userId is required');
    }

    // Check if source file exists
    try {
      await fsPromises.stat(sourcePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Source file does not exist: ${sourcePath}`);
      }
      throw err;
    }

    const sendsDir = pathUtils.getUserSendsDir(userId);

    // Use Worker thread to copy file to sends directory
    const result = await fileCopyManager.copyFileToSends(sourcePath, sendsDir, transferId);

    logger.info(`[IPC] File successfully copied to sends directory (Worker): ${result.filePath}`);
    return { success: true, filePath: result.filePath, fileName: result.fileName };
  } catch (err) {
    logger.error(`[IPC] Failed to copy file to sends directory: ${err.message}`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: save video cover image
registerHandler('save-video-poster', async (event, params) => {
  const { transferId, posterDataUrl, userId } = params;
  logger.info(`[IPC] save-video-poster started: transferId=${transferId}, userId=${userId}, posterDataUrl length=${posterDataUrl?.length || 0}`);

  try {
    if (!transferId || !posterDataUrl) {
      logger.error(`[IPC] save-video-poster parameter error: transferId=${transferId}, posterDataUrl exists=${!!posterDataUrl}`);
      throw new Error('transferId and posterDataUrl cannot be empty');
    }

    if (!userId) {
      logger.error(`[IPC] save-video-poster userId missing`);
      throw new Error('userId is required');
    }

    const sendsDir = pathUtils.getUserSendsDir(userId);
    logger.info(`[IPC] sendsDir=${sendsDir}`);

    const posterFileName = `${transferId}-poster.jpg`;
    const posterPath = path.join(sendsDir, posterFileName);
    logger.info(`[IPC] Poster full path: ${posterPath}`);

    const base64Match = posterDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
    if (!base64Match) {
      logger.error(`[IPC] posterDataUrl format invalid: ${posterDataUrl.substring(0, 50)}...`);
      throw new Error('Invalid data URL format');
    }

    const base64Data = base64Match[1];
    logger.info(`[IPC] base64 data length: ${base64Data.length}`);
    const buffer = Buffer.from(base64Data, 'base64');
    logger.info(`[IPC] Converted buffer size: ${buffer.length}`);

    // Ensure directory exists
    await fs.promises.mkdir(sendsDir, { recursive: true });
    logger.info(`[IPC] sendsDir directory ensured exists: ${sendsDir}`);

    // Write file
    await fs.promises.writeFile(posterPath, buffer);
    logger.info(`[IPC] ✅ Video poster saved to sends: ${posterPath}, size=${buffer.length}`);

    return { success: true, posterFileName, posterPath };
  } catch (err) {
    logger.error(`[IPC] ❌ Failed to save video poster: ${err.message}`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: receiver saves video cover image (save to recvs directory)
registerHandler('save-receiver-video-poster', async (event, params) => {
  const { transferId, posterDataUrl, userId } = params;
  logger.info(`[IPC] save-receiver-video-poster started: transferId=${transferId}, userId=${userId}, posterDataUrl length=${posterDataUrl?.length || 0}`);

  try {
    if (!transferId || !posterDataUrl) {
      logger.error(`[IPC] save-receiver-video-poster parameter error: transferId=${transferId}, posterDataUrl exists=${!!posterDataUrl}`);
      throw new Error('transferId and posterDataUrl cannot be empty');
    }

    if (!userId) {
      logger.error(`[IPC] save-receiver-video-poster userId missing`);
      throw new Error('userId is required');
    }

    const recvsDir = pathUtils.getUserRecvsDir(userId);
    logger.info(`[IPC] recvsDir=${recvsDir}`);

    const posterFileName = `${transferId}-poster.jpg`;
    const posterPath = path.join(recvsDir, posterFileName);
    logger.info(`[IPC] Poster full path: ${posterPath}`);

    const base64Match = posterDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
    if (!base64Match) {
      logger.error(`[IPC] posterDataUrl format invalid: ${posterDataUrl.substring(0, 50)}...`);
      throw new Error('Invalid data URL format');
    }

    const base64Data = base64Match[1];
    logger.info(`[IPC] base64 data length: ${base64Data.length}`);
    const buffer = Buffer.from(base64Data, 'base64');
    logger.info(`[IPC] Converted buffer size: ${buffer.length}`);

    // Ensure directory exists
    await fs.promises.mkdir(recvsDir, { recursive: true });
    logger.info(`[IPC] recvsDir directory ensured exists: ${recvsDir}`);

    // Write file
    await fs.promises.writeFile(posterPath, buffer);
    logger.info(`[IPC] ✅ Receiver video poster saved to recvs: ${posterPath}, size=${buffer.length}`);

    return { success: true, posterFileName, posterPath };
  } catch (err) {
    logger.error(`[IPC] ❌ Receiver failed to save video poster: ${err.message}`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: generate image thumbnail
registerHandler('generate-thumbnail', async (event, { filePath, maxWidth }) => {
  try {
    const result = await thumbnailGenerator.generateThumbnail(filePath, { maxWidth: maxWidth || 200 });
    return { success: true, ...result };
  } catch (err) {
    logger.error(`[IPC] Failed to generate thumbnail: ${err.message}`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: get HTTP service port
registerHandler('get-http-server-port', async () => {
  try {
    const port = await httpServerManager.startHttpServer();
    return { success: true, port };
  } catch (err) {
    logger.error(`Failed to get HTTP server port: ${err.message}`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: get currently selected email config (from renderer's window.selectedConfig)
registerHandler('get-current-config', async (event) => {
  try {
    const webContents = event.sender;
    const windows = BrowserWindow.getAllWindows();
    const targetWindow = windows.find(w => w.webContents.id === webContents.id);

    if (!targetWindow) {
      logger.warn('[IPC] get-current-config: target window not found');
      return null;
    }

    const config = await targetWindow.webContents.executeJavaScript(
      'window.selectedConfig || window.getSelectedConfig ? (window.getSelectedConfig ? window.getSelectedConfig() : window.selectedConfig) : null'
    );

    return config;
  } catch (err) {
    logger.error(`Failed to get current config: ${err.message}`, err);
    return null;
  }
});

// IPC handler: frontend log recording
registerHandler('log-message', async (event, { level, message, module, userId }) => {
  try {
    const timestamp = new Date().toISOString();
    const logContent = `[${timestamp}] [${level?.toUpperCase() || 'INFO'}] [${module || 'Renderer'}] ${message}\n`;

    // Use existing logging system
    logger.info(`[Renderer] ${message}`);

    // Determine log directory: if userId is provided, use user-specific log directory
    // Note: global log directory resources/users/log is created at app startup by app-initializer.js
    const logDir = userId 
      ? pathUtils.getUserLogDir(userId)
      : path.join(pathUtils.getResourcesDir(), 'users', 'log');

    const logFile = path.join(logDir, `renderer_${process.pid}.log`);
    await fsPromises.appendFile(logFile, logContent);

    return { success: true };
  } catch (err) {
    console.error('Failed to write renderer log:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler: batch write files
registerHandler('batch-write-files', async (event, fileList) => {
  try {
    if (!fileList || !Array.isArray(fileList) || fileList.length === 0) {
      return { success: false, error: 'Invalid file list' };
    }

    const results = [];
    const chunks = [];
    
    for (let i = 0; i < fileList.length; i += 5) {
      chunks.push(fileList.slice(i, i + 5));
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(async (file) => {
          try {
            const { filePath, content, position } = file;
            
            let bufferData;
            if (content instanceof ArrayBuffer) {
              bufferData = Buffer.from(content);
            } else if (Array.isArray(content)) {
              bufferData = Buffer.from(new Uint8Array(content));
            } else if (typeof content === 'string') {
              bufferData = Buffer.from(content, 'base64');
            } else {
              bufferData = Buffer.from(content);
            }

            await fileWriterManager.writeFile(filePath, bufferData, position || 0);
            
            return { success: true, filePath };
          } catch (err) {
            return { success: false, error: err.message, filePath: file.filePath };
          }
        })
      );
      
      results.push(...chunkResults);
      
      if (chunks.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    return { success: true, results };
  } catch (err) {
    logger.error(`Failed to batch write files: ${err.message}`, err);
    return { success: false, error: err.message };
  }
});

// IPC handler: start tray icon flashing
registerHandler('start-tray-flash', async (event, avatarData) => {
  try {
    if (avatarData) {
      await startTrayFlashWithAvatar(avatarData);
    } else {
      startTrayFlash();
    }
    return { success: true };
  } catch (err) {
    logger.error('Failed to start tray flash:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler: stop tray icon flashing
registerHandler('stop-tray-flash', async () => {
  try {
    stopTrayFlash();
    return { success: true };
  } catch (err) {
    logger.error('Failed to stop tray flash:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler: set tray icon to current user avatar
registerHandler('set-tray-icon-to-user-avatar', async (event, avatarData) => {
  try {
    const result = await setTrayIconToUserAvatar(avatarData);
    return { success: result };
  } catch (err) {
    logger.error('Failed to set tray icon to user avatar:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler: reset tray icon to default icon
registerHandler('reset-tray-icon-to-default', async () => {
  try {
    resetTrayIconToDefault();
    return { success: true };
  } catch (err) {
    logger.error('Failed to reset tray icon:', err);
    return { success: false, error: err.message };
  }
});

// IPC handler: open image preview window (for web image formats like webp, svg)
registerHandler('open-image-preview-window', async (event, { filePath, filename }) => {
  try {
    if (!filePath) {
      throw new Error('File path cannot be empty');
    }

    try {
      await fsPromises.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn(`[IPC] open-image-preview-window: file does not exist: ${filePath}`);
        return { success: false, error: 'File does not exist' };
      }
      throw err;
    }

    const imageWindow = new BrowserWindow({
      width: 900,
      height: 700,
      title: filename || 'Image Preview',
      frame: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false
      }
    });

    const imageUrl = `file://${filePath.replace(/\\/g, '/')}`;
    await imageWindow.loadURL(imageUrl);

    imageWindow.webContents.on('did-finish-load', () => {
      logger.info(`[IPC] Image preview window loaded: ${filePath}`);
    });

    imageWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      logger.error(`[IPC] Image preview window load failed: ${errorCode} - ${errorDescription}`);
    });

    return { success: true };
  } catch (err) {
    logger.error(`Failed to open image preview window:`, err);
    return { success: false, error: err.message };
  }
});
