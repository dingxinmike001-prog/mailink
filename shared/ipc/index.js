/**
 * IPC Module Index
 */

const ipcManager = require('./ipc-manager');

module.exports = {
  ...ipcManager
};

module.exports.ipcManager = ipcManager;
