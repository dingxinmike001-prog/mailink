/**
 * Event Emitter - unified event system
 * provides enhanced event management, supports async handling and statistics
 */

const logger = require('../../../service/logger');

class EventEmitter {
  constructor(options = {}) {
    this.events = new Map();
    this.eventStats = new Map();
    this.maxListeners = options.maxListeners || 100;
    this.captureRejections = options.captureRejections !== false;
  }

  on(event, listener, options = {}) {
    const { once = false, priority = 0 } = options;
    
    if (typeof listener !== 'function') {
      throw new Error('Listener must be a function');
    }

    const wrapper = once
      ? (...args) => {
          this.off(event, wrapper);
          listener(...args);
        }
      : listener;

    wrapper._isOnce = once;
    wrapper._priority = priority;
    wrapper._originalListener = listener;

    if (!this.events.has(event)) {
      this.events.set(event, []);
    }

    const listeners = this.events.get(event);
    const index = this._findInsertionIndex(listeners, priority);
    listeners.splice(index, 0, wrapper);

    this._incrementStat(event, 'count');
    this._checkMaxListeners(event);

    return () => this.off(event, wrapper);
  }

  once(event, listener, options = {}) {
    return this.on(event, listener, { ...options, once: true });
  }

  off(event, listener) {
    if (this.events.has(event)) {
      const listeners = this.events.get(event);
      const index = listeners.findIndex((l) => l._originalListener === listener || l === listener);
      
      if (index !== -1) {
        listeners.splice(index, 1);
        this._incrementStat(event, 'removed');
        
        if (listeners.length === 0) {
          this.events.delete(event);
        }
      }
    }
  }

  emit(event, ...args) {
    const listeners = this.events.get(event);
    
    if (!listeners || listeners.length === 0) {
      this._incrementStat(event, 'empty');
      return false;
    }

    const errors = [];
    let hasAsync = false;

    for (const listener of listeners) {
      try {
        const result = listener(...args);
        
        if (result && typeof result.then === 'function') {
          hasAsync = true;
          result.catch((error) => {
            errors.push(error);
            logger.error(`Async event listener error for ${event}:`, error);
          });
        }
      } catch (error) {
        errors.push(error);
        
        if (this.captureRejections) {
          logger.error(`Event listener error for ${event}:`, error);
        } else {
          throw error;
        }
      }
    }

    this._incrementStat(event, 'emitted');

    return !errors.length;
  }

  listenerCount(event) {
    if (!this.events.has(event)) return 0;
    return this.events.get(event).length;
  }

  listeners(event) {
    if (!this.events.has(event)) return [];
    return [...this.events.get(event)];
  }

  eventNames() {
    return [...this.events.keys()];
  }

  removeAllListeners(event) {
    if (event) {
      this.events.delete(event);
      this.eventStats.delete(event);
    } else {
      this.events.clear();
      this.eventStats.clear();
    }
  }

  setMaxListeners(n) {
    this.maxListeners = n;
  }

  getMaxListeners() {
    return this.maxListeners;
  }

  _findInsertionIndex(listeners, priority) {
    let index = listeners.length;
    
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i]._priority <= priority) {
        index = i + 1;
        break;
      }
    }
    
    return index;
  }

  _checkMaxListeners(event) {
    const count = this.listenerCount(event);
    
    if (count >= this.maxListeners) {
      logger.warn(`Max listeners (${this.maxListeners}) reached for event "${event}". Use setMaxListeners() to increase.`);
    }
  }

  _incrementStat(event, type) {
    if (!this.eventStats.has(event)) {
      this.eventStats.set(event, {
        count: 0,
        emitted: 0,
        empty: 0,
        removed: 0
      });
    }
    
    const stats = this.eventStats.get(event);
    if (stats[type] !== undefined) {
      stats[type]++;
    }
  }
}

module.exports = {
  EventEmitter
};
