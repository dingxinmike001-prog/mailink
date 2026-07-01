const path = require('path');
const net = require('net');
const pathUtils = require('../../shared/path/path-utils');
const logger = require('../logger');
const { createWorkerManager } = require('../../shared/worker/worker-factory');

const httpServerWorkerManager = createWorkerManager('http');

// Flag whether HTTP service has started
let httpServerStarted = false;

// Store startup Promise to prevent race conditions
let startPromise = null;

// HTTP service config (port will be dynamically generated at startup)
let httpServerConfig = {
  host: '127.0.0.1',
  port: null,
  // No longer use a single rootDir; resolve user directory dynamically based on request
  resourcesDir: pathUtils.getResourcesDir()
};

/**
 * Check if port is in use
 * @param {number} port - port to check
 * @returns {Promise<boolean>} - whether port is available
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });

    server.listen(port);
  });
}

function isPortListening(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let finished = false;

    const finish = (ok) => {
      if (finished) return;
      finished = true;
      try {
        socket.destroy();
      } catch (e) { console.debug('Socket destroy failed:', e); }
      resolve(ok);
    };

    socket.setTimeout(800);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Generate random port greater than 20000
 * @returns {number} - random port number
 */
function generateRandomPort() {
  // Generate random port between 20001 and 65535
  return Math.floor(Math.random() * (65535 - 20001 + 1)) + 20001;
}

/**
 * Get available random port
 * @returns {Promise<number>} - available port number
 */
async function getAvailablePort() {
  let maxAttempts = 10;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const port = generateRandomPort();
    const isAvailable = await isPortAvailable(port);

    if (isAvailable) {
      return port;
    }

    attempts++;
    logger.debug(`Port ${port} is occupied, trying next port...`);
  }

  throw new Error('Cannot find available random port');
}

/**
 * Start HTTP service
 */
async function startHttpServer() {
  if (httpServerStarted) {
    const host = httpServerConfig.host || '127.0.0.1';
    const port = httpServerConfig.port;
    if (port && await isPortListening(host, port)) {
      logger.info('HTTP service is already running, no need to start again');
      return Promise.resolve(port);
    }
    logger.warn('HTTP service not listening, preparing self-healing restart');
    httpServerStarted = false;
    startPromise = null;
  }

  // If already starting, return existing Promise directly
  if (startPromise) {
    logger.info('HTTP service is starting, waiting for existing tasks to complete...');
    return startPromise;
  }

  logger.info('Preparing to start HTTP service...');

  startPromise = (async () => {
    try {
      // If port is not set, generate a random available port
      if (!httpServerConfig.port) {
        const port = await getAvailablePort();
        httpServerConfig.port = port;
        logger.info(`Available port obtained: ${port}`);
      }

      logger.info(`HTTP service config: ${JSON.stringify(httpServerConfig)}`);

      const result = await httpServerWorkerManager.sendTask({
        action: 'start',
        ...httpServerConfig
      });

      logger.info(`HTTP service started successfully: ${result}`);
      httpServerStarted = true;
      return httpServerConfig.port;
    } catch (error) {
      logger.error('HTTP service failed to start:', error);
      // Clear Promise on startup failure to allow retry
      startPromise = null;
      httpServerConfig.port = null;
      throw error;
    }
  })();

  return startPromise;
}

/**
 * Stop HTTP service
 */
function stopHttpServer() {
  if (!httpServerStarted) {
    logger.info('HTTP service is not running, no need to stop');
    return Promise.resolve();
  }

  logger.info('Preparing to stop HTTP service...');

  return httpServerWorkerManager.sendTask({
    action: 'stop'
  }).then((result) => {
    logger.info(`HTTP service stopped successfully: ${result}`);
    httpServerStarted = false;
    return result;
  }).catch((error) => {
    logger.error('HTTP service failed to stop:', error);
    throw error;
  });
}

module.exports = {
  startHttpServer,
  stopHttpServer,
  /**
   * Get current HTTP service port
   * @returns {number|null} - current port number, null if not started
   */
  getHttpServerPort: () => httpServerConfig.port,

  /**
   * Get current HTTP service config
   * @returns {Object} - HTTP service config
   */
  getHttpServerConfig: () => httpServerConfig,

  /**
   * Get HTTP service startup status
   * @returns {boolean} - whether service is started
   */
  isHttpServerStarted: () => httpServerStarted,

  /**
   * Get HTTP service resource directory
   * @returns {string} - HTTP service resource directory
   */
  getHttpServerResourcesDir: () => httpServerConfig.resourcesDir,

  /**
   * Get user-specific file path
   * @param {string} username - email address
   * @param {string} fileType - file type ('recvs' or 'sends')
   * @param {string} fileName - file name
   * @returns {string} - full file path
   */
  getUserFilePath: (username, fileType, fileName) => {
    return path.join(httpServerConfig.resourcesDir, username, 'files', fileType, fileName);
  }
};
