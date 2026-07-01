const path = require('path');
const WorkerManager = require('./worker-manager');

const workerConfigs = {
  http: {
    workerPath: path.join(__dirname, '../../service/http/http-server.worker.js'),
    mode: 'single'
  },
  // IMAP management operation Worker (used for cleaning logs, searching deleted emails, deleting emails by UID)
  imapManagement: {
    workerPath: path.join(__dirname, '../../service/mail/workers/imap-management.worker.js'),
    mode: 'single'
  },
  // Signaling email dedicated Worker (used for fetching signaling emails)
  imapSignaling: {
    workerPath: path.join(__dirname, '../../service/mail/workers/imap-signaling-fetch.worker.js'),
    mode: 'single'
  },
  // Normal email dedicated Worker (used for fetching normal emails)
  imapNormal: {
    workerPath: path.join(__dirname, '../../service/mail/workers/imap-normal-fetch.worker.js'),
    mode: 'single'
  },
  // Email body download dedicated Worker
  fetchEmailBody: {
    workerPath: path.join(__dirname, '../../service/mail/workers/fetch-email-body.worker.js'),
    mode: 'single'
  },
  smtp: {
    workerPath: path.join(__dirname, '../../service/mail/smtp-worker.js'),
    mode: 'pool',
    poolSize: Math.min(4, require('os').cpus().length)
  },
  contactBackup: {
    workerPath: path.join(__dirname, '../../service/mail/workers/contact-backup.worker.js'),
    mode: 'single'
  },
  contactBackupRestore: {
    workerPath: path.join(__dirname, '../../service/mail/workers/contact-backup-restore.worker.js'),
    mode: 'single'
  },
  // File security detection Worker (used for dangerous file detection to avoid blocking the main thread)
  fileSecurity: {
    workerPath: path.join(__dirname, '../../service/security/workers/file-security.worker.js'),
    mode: 'pool',
    poolSize: Math.min(4, require('os').cpus().length)
  },
  // Thumbnail generation Worker (used for image thumbnail generation to avoid blocking the main thread)
  thumbnail: {
    workerPath: path.join(__dirname, '../../service/images/workers/thumbnail.worker.js'),
    mode: 'single'
  },
  // Email batch processing Worker (used for batch converting emails to chat messages to avoid blocking the main thread)
  emailBatchProcessor: {
    workerPath: path.join(__dirname, '../../service/mail/workers/email-batch-processor.worker.js'),
    mode: 'single'
  }
};

function createWorkerManager(type) {
  const config = workerConfigs[type];
  if (!config) {
    throw new Error(`Unknown worker type: ${type}`);
  }
  return new WorkerManager(config);
}

module.exports = { createWorkerManager, workerConfigs };
