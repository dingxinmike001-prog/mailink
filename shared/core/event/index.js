/**
 * Event Module Index
 */

const eventEmitter = require('./event-emitter');

module.exports = {
  ...eventEmitter
};

module.exports.eventEmitter = eventEmitter;
