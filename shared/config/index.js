/**
 * Config Module Index
 */

const emailConfig = require('./email-config');
const signalingConstants = require('./signaling-constants');

module.exports = {
  ...emailConfig,
  ...signalingConstants
};

module.exports.emailConfig = emailConfig;
module.exports.signalingConstants = signalingConstants;
