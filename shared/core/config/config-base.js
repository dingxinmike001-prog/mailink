/**
 * Config Base - unified configuration management base class
 * provides common functions for config load, save, cache, and event management
 */

const logger = require('../../../service/logger');

const DEFAULT_CACHE_DURATION = 30000;

class ConfigBase {
  constructor(options = {}) {
    this.cacheEnabled = options.cacheEnabled !== false;
    this.cacheDuration = options.cacheDuration || DEFAULT_CACHE_DURATION;
    this.autoSave = options.autoSave || false;
    this.configCache = null;
    this.cacheLastUpdated = 0;
    this.listeners = new Map();
    this.initialized = false;
    this.initPromise = null;
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize().finally(() => {
      this.initialized = true;
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async _doInitialize() {
    return Promise.resolve();
  }

  _getCacheKey() {
    return `${this.constructor.name}_cache`;
  }

  _isCacheValid(forceReload = false) {
    if (!this.cacheEnabled || forceReload) return false;
    if (!this.configCache) return false;
    const now = Date.now();
    return (now - this.cacheLastUpdated) < this.cacheDuration;
  }

  _updateCache(configs) {
    if (!this.cacheEnabled) return;
    this.configCache = configs;
    this.cacheLastUpdated = Date.now();
  }

  _clearCache() {
    this.configCache = null;
    this.cacheLastUpdated = 0;
  }

  async getConfigs(forceReload = false) {
    await this.initialize();

    if (this._isCacheValid(forceReload)) {
      return this.configCache;
    }

    const configs = await this._loadConfigs();
    this._updateCache(configs);
    return configs;
  }

  async getConfig(configId, forceReload = false) {
    const configs = await this.getConfigs(forceReload);
    return configs.find((c) => c.id === configId) || null;
  }

  async saveConfig(config) {
    await this.initialize();

    const validation = this._validateConfig(config);
    if (!validation.valid) {
      throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
    }

    const savedConfig = await this._doSave(config);
    this._clearCache();
    this._emit('configUpdated', savedConfig);
    return savedConfig;
  }

  async updateConfig(configId, updates) {
    await this.initialize();

    const existingConfig = await this.getConfig(configId);
    if (!existingConfig) {
      throw new Error(`Configuration does not exist: ${configId}`);
    }

    const mergedConfig = { ...existingConfig, ...updates };
    const validation = this._validateConfig(mergedConfig);
    if (!validation.valid) {
      throw new Error(`Configuration validation failed: ${validation.errors.join(', ')}`);
    }

    const savedConfig = await this._doUpdate(configId, updates);
    this._clearCache();
    this._emit('configUpdated', { ...existingConfig, ...savedConfig });
    return savedConfig;
  }

  async deleteConfig(configId) {
    await this.initialize();

    await this._doDelete(configId);
    this._clearCache();
    this._emit('configDeleted', configId);
    return true;
  }

  async _loadConfigs() {
    return [];
  }

  async _doSave(config) {
    return config;
  }

  async _doUpdate(configId, updates) {
    return { id: configId, ...updates };
  }

  async _doDelete(configId) {
    return true;
  }

  _validateConfig(config) {
    const errors = [];
    if (!config) {
      errors.push('Configuration cannot be empty');
      return { valid: false, errors };
    }

    const requiredFields = this._getRequiredFields();
    for (const field of requiredFields) {
      if (config[field] === undefined || config[field] === null || config[field] === '') {
        errors.push(`${field} is required`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  _getRequiredFields() {
    return ['id'];
  }

  on(event, listener) {
    if (typeof listener !== 'function') {
      throw new Error('Listener must be a function');
    }

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(listener);

    return () => this.off(event, listener);
  }

  off(event, listener) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(listener);
    }
  }

  once(event, listener) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    this.on(event, wrapper);
  }

  _emit(event, data) {
    if (this.listeners.has(event)) {
      for (const listener of this.listeners.get(event)) {
        try {
          listener(data);
        } catch (error) {
          logger.error(`Error in config listener for ${event}:`, error);
        }
      }
    }
  }

  getStatus() {
    return {
      initialized: this.initialized,
      cacheEnabled: this.cacheEnabled,
      cacheDuration: this.cacheDuration,
      cacheValid: this._isCacheValid()
    };
  }
}

module.exports = {
  ConfigBase,
  DEFAULT_CACHE_DURATION
};
