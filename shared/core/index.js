/**
 * Core Module Index - shared-layer core infrastructure
 * provides Electron helper, timeout control, event system, etc.
 */

const electronHelper = require('./electron/electron-helper');
const timeout = require('./timeout/timeout');
const eventEmitter = require('./event/event-emitter');
const configBase = require('./config/config-base');

module.exports = {
  ...electronHelper,
  ...timeout,
  ...eventEmitter,
  ...configBase
};

module.exports.electron = electronHelper;
module.exports.timeout = timeout;
module.exports.eventEmitter = eventEmitter;
module.exports.configBase = configBase;
