/**
 * Electron Helper - unified handling of Electron lazy loading
 * provides safe access to Electron modules, supports main and renderer processes
 *
 * Note: this module no longer depends on electron.remote
 * remote module has been removed in Electron 14+
 */

const logger = require('../../../service/logger');

let electron = null;
let electronLoaded = false;
let ipcMain = null;
let ipcRenderer = null;

function loadElectron() {
  if (electronLoaded) return electron;
  
  try {
    electron = require('electron');
    electronLoaded = true;
    logger.debug('Electron modules loaded successfully');
  } catch (error) {
    logger.debug('Not in Electron environment');
    electronLoaded = true;
    electron = null;
  }
  
  return electron;
}

function getIpcMain() {
  if (!electronLoaded) loadElectron();
  
  if (ipcMain) return ipcMain;
  
  if (electron?.ipcMain) {
    ipcMain = electron.ipcMain;
    return ipcMain;
  }
  
  return null;
}

function getIpcRenderer() {
  if (!electronLoaded) loadElectron();
  
  if (ipcRenderer) return ipcRenderer;
  
  if (electron?.ipcRenderer) {
    ipcRenderer = electron.ipcRenderer;
    return ipcRenderer;
  }
  
  return null;
}

function getApp() {
  if (!electronLoaded) loadElectron();
  
  if (electron?.app) {
    return electron.app;
  }
  
  return null;
}

function isElectronEnv() {
  if (!electronLoaded) loadElectron();
  return electron !== null;
}

module.exports = {
  loadElectron,
  getIpcMain,
  getIpcRenderer,
  getApp,
  isElectronEnv
};
