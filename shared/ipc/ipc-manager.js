/**
 * IPC communication manager
 * provides unified IPC registration and handling mechanism, supports automatic error capture, logging, and timeout handling
 */

const logger = require('../../service/logger');
const { getIpcMain } = require('../core/electron/electron-helper');
const { withTimeout, createTimeoutController } = require('../core/timeout/timeout');

const DEFAULT_OPTIONS = {
  timeout: 30000,
  enableLogging: true,
  enableTimeout: true,
  frequencyLimit: null,
  typeCheck: false,
};

const rateLimitMap = new WeakMap();

class IPCManager {
  constructor() {
    this.defaultOptions = { ...DEFAULT_OPTIONS };
    this.handlers = new Map();
  }

  setDefaultOptions(options) {
    this.defaultOptions = { ...this.defaultOptions, ...options };
  }

  async checkRateLimit(channel, options) {
    if (!options.frequencyLimit) return;

    const now = Date.now();
    const key = `${channel}_${options.frequencyLimit}`;
    
    let rateLimitInfo = rateLimitMap.get(this);
    if (!rateLimitInfo) {
      rateLimitInfo = {};
      rateLimitMap.set(this, rateLimitInfo);
    }
    
    const lastCallTime = rateLimitInfo[key] || 0;
    const timeSinceLastCall = now - lastCallTime;

    if (timeSinceLastCall < options.frequencyLimit) {
      const waitTime = options.frequencyLimit - timeSinceLastCall;
      
      if (options.enableLogging) {
        logger.debug(`[${channel}] Rate limit: waiting ${waitTime}ms`);
      }
      
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    rateLimitInfo[key] = Date.now();
  }

  wrapHandler(channel, handler, options) {
    return async (event, ...args) => {
      await this.checkRateLimit(channel, options);

      if (options.enableLogging) {
        logger.info(`[IPC] Handling ${channel} request`);
      }

      const executeHandler = async () => {
        try {
          const res = await handler(event, ...args);
          if (options.enableLogging) {
            logger.info(`[IPC] ${channel} request completed successfully`);
          }
          return res;
        } catch (error) {
          if (options.enableLogging) {
            logger.error(`[IPC] Error handling ${channel}: ${error?.stack || error?.message || String(error)}`);
          }
          throw error;
        }
      };

      if (options.enableTimeout) {
        return withTimeout(executeHandler(), options.timeout, {
          timeoutMessage: `IPC call ${channel} timed out after ${options.timeout}ms`
        });
      }

      return executeHandler();
    };
  }

  registerHandler(channel, handler, options = {}) {
    const currentIpcMain = getIpcMain();
    
    if (!currentIpcMain) {
      logger.debug(`Not in Electron environment, skipping IPC handler registration for ${channel}`);
      return;
    }

    const mergedOptions = Object.assign({}, this.defaultOptions, options);
    
    const wrappedHandler = this.wrapHandler(channel, handler, mergedOptions);
    
    currentIpcMain.handle(channel, wrappedHandler);
    
    this.handlers.set(channel, { originalHandler: handler, wrappedHandler, options: mergedOptions });
    
    if (mergedOptions.enableLogging) {
      logger.info(`[IPC] Registered handler for ${channel}`);
    }
  }

  registerMultipleHandlers(handlersMap) {
    for (const [channel, config] of Object.entries(handlersMap)) {
      const { handler, options = {} } = config;
      this.registerHandler(channel, handler, options);
    }
  }

  unregisterHandler(channel) {
    const currentIpcMain = getIpcMain();
    
    if (!currentIpcMain) {
      logger.debug(`Not in Electron environment, skipping IPC handler unregistration for ${channel}`);
      return;
    }

    currentIpcMain.removeHandler(channel);
    this.handlers.delete(channel);
    
    logger.info(`[IPC] Unregistered handler for ${channel}`);
  }

  getHandlers() {
    return new Map(this.handlers);
  }

  getHandler(channel) {
    return this.handlers.get(channel) || null;
  }
}

const ipcManager = new IPCManager();

module.exports = {
  IPCManager,
  ipcManager,
  registerHandler: (channel, handler, options) => ipcManager.registerHandler(channel, handler, options),
  registerMultipleHandlers: (handlersMap) => ipcManager.registerMultipleHandlers(handlersMap),
  setDefaultOptions: (options) => ipcManager.setDefaultOptions(options),
  unregisterHandler: (channel) => ipcManager.unregisterHandler(channel),
};
