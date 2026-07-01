/**
 * Worker Module Index
 */

const WorkerManager = require('./worker-manager');
const { createWorkerManager, workerConfigs } = require('./worker-factory');

module.exports = {
  WorkerManager,
  createWorkerManager,
  workerConfigs
};

module.exports.WorkerManager = WorkerManager;
module.exports.createWorkerManager = createWorkerManager;
module.exports.workerConfigs = workerConfigs;
