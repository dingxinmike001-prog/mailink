/**
 * Timeout Utilities - unified timeout utilities
 * provides Promise timeout wrapper and timeout controller
 */

const logger = require('../../../service/logger');

const DEFAULT_TIMEOUT = 30000;

class TimeoutError extends Error {
  constructor(message, timeout) {
    super(message);
    this.name = 'TimeoutError';
    this.timeout = timeout;
    this.isTimeout = true;
  }
}

function withTimeout(promise, timeoutMs, options = {}) {
  const {
    timeoutMessage = `Operation timed out after ${timeoutMs}ms`,
    onTimeout = null
  } = options;

  if (!promise || typeof promise.then !== 'function') {
    return Promise.reject(new Error('Invalid promise provided to withTimeout'));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout) {
        try {
          onTimeout();
        } catch (error) {
          logger.error('Error in onTimeout callback:', error);
        }
      }
      reject(new TimeoutError(timeoutMessage, timeoutMs));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createTimeoutController(timeoutMs, options = {}) {
  let timer = null;
  let rejected = false;
  const {
    timeoutMessage = `Operation timed out after ${timeoutMs}ms`,
    onTimeout = null
  } = options;

  const controller = {
    timeoutMs,
    isAborted: false,

    start(promise) {
      if (rejected) {
        return Promise.reject(new TimeoutError(timeoutMessage, timeoutMs));
      }

      return new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          if (!rejected) {
            rejected = true;
            controller.isAborted = true;
            if (onTimeout) {
              try {
                onTimeout();
              } catch (error) {
                logger.error('Error in onTimeout callback:', error);
              }
            }
            reject(new TimeoutError(timeoutMessage, timeoutMs));
          }
        }, timeoutMs);

        promise
          .then((result) => {
            if (!rejected) {
              clearTimeout(timer);
              resolve(result);
            }
          })
          .catch((error) => {
            if (!rejected) {
              clearTimeout(timer);
              reject(error);
            }
          });
      });
    },

    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    abort() {
      if (!rejected) {
        rejected = true;
        controller.isAborted = true;
        this.clear();
      }
    }
  };

  return controller;
}

module.exports = {
  TimeoutError,
  withTimeout,
  createTimeoutController,
  DEFAULT_TIMEOUT
};
