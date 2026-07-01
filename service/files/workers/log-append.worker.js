const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');

const logger = require('../../logger');

const LOG_APPEND_TRACE =
  process.env.MAILINK_LOG_APPEND_TRACE === '1' ||
  process.env.MAILINK_LOG_APPEND_TRACE === 'true' ||
  process.env.MAILINK_LOG_APPEND_TRACE === 'TRUE';

const BATCH_SIZE = 50;
const BATCH_INTERVAL = 100;

const fileStates = new Map();
const batchBuffers = new Map();
const batchTimers = new Map();

function log(level, message) {
  if (LOG_APPEND_TRACE) {
    logger[level](`[LogAppendWorker] ${message}`);
  }
}

function ensureDir(filePath) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function getFileState(filePath) {
  const existing = fileStates.get(filePath);
  if (existing) return existing;

  ensureDir(filePath);

  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  const state = {
    stream,
    chain: Promise.resolve(),
    broken: null,
    pendingCount: 0
  };

  stream.on('error', (err) => {
    state.broken = err || new Error('log stream error');
    log('error', `Stream error for ${filePath}: ${err.message}`);
  });

  fileStates.set(filePath, state);
  return state;
}

function writeToStream(state, data) {
  return new Promise((resolve, reject) => {
    if (state.broken) {
      reject(state.broken);
      return;
    }

    const ok = state.stream.write(data, (err) => {
      if (err) {
        state.broken = err;
        reject(err);
        return;
      }
      resolve(true);
    });

    if (!ok) {
      state.stream.once('drain', () => resolve(true));
    }
  });
}

function flushBatch(filePath) {
  const buffer = batchBuffers.get(filePath);
  const timer = batchTimers.get(filePath);

  if (timer) {
    clearTimeout(timer);
    batchTimers.delete(filePath);
  }

  if (!buffer || buffer.length === 0) {
    batchBuffers.delete(filePath);
    return Promise.resolve();
  }

  const state = getFileState(filePath);
  const combinedData = Buffer.concat(buffer);
  batchBuffers.delete(filePath);

  log('info', `Flushing batch for ${filePath}, ${buffer.length} items, ${combinedData.length} bytes`);

  state.pendingCount++;
  state.chain = state.chain
    .then(() => writeToStream(state, combinedData))
    .then(() => {
      state.pendingCount--;
      if (state.pendingCount === 0 && state.broken) {
        cleanupFile(filePath);
      }
    })
    .catch((err) => {
      state.pendingCount--;
      log('error', `Batch write failed for ${filePath}: ${err.message}`);
    });

  return state.chain;
}

function addToBatch(filePath, data) {
  if (!batchBuffers.has(filePath)) {
    batchBuffers.set(filePath, []);
  }

  const buffer = batchBuffers.get(filePath);
  buffer.push(data);

  if (buffer.length >= BATCH_SIZE) {
    return flushBatch(filePath);
  }

  if (!batchTimers.has(filePath)) {
    const timer = setTimeout(() => {
      flushBatch(filePath);
    }, BATCH_INTERVAL);
    batchTimers.set(filePath, timer);
  }

  return Promise.resolve();
}

function cleanupFile(filePath) {
  const state = fileStates.get(filePath);
  if (state) {
    flushBatch(filePath).then(() => {
      if (state.stream) {
        state.stream.end(() => {
          log('info', `Closed stream for ${filePath}`);
        });
      }
      fileStates.delete(filePath);
    });
  }
}

function handleAppend(id, filePath, content, options = {}) {
  try {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const { flush = false, batch = true } = options;

    log('info', `Append request: ${filePath}, ${data.length} bytes, batch=${batch}, flush=${flush}`);

    if (flush || !batch) {
      const state = getFileState(filePath);
      state.chain = state.chain.then(() => writeToStream(state, data));

      state.chain
        .then(() => {
          parentPort.postMessage({ id, success: true });
        })
        .catch((err) => {
          parentPort.postMessage({ id, success: false, error: err.message });
        });
    } else {
      addToBatch(filePath, data)
        .then(() => {
          parentPort.postMessage({ id, success: true });
        })
        .catch((err) => {
          parentPort.postMessage({ id, success: false, error: err.message });
        });
    }
  } catch (err) {
    log('error', `Handle append error: ${err.message}`);
    parentPort.postMessage({ id, success: false, error: err.message });
  }
}

function handleFlush(id, filePath) {
  flushBatch(filePath)
    .then(() => {
      parentPort.postMessage({ id, success: true });
    })
    .catch((err) => {
      parentPort.postMessage({ id, success: false, error: err.message });
    });
}

function handleClose(id, filePath) {
  if (filePath) {
    cleanupFile(filePath);
    parentPort.postMessage({ id, success: true });
  } else {
    const allFlushes = Array.from(fileStates.keys()).map(fp => flushBatch(fp));
    Promise.all(allFlushes).then(() => {
      for (const [fp, state] of fileStates) {
        if (state.stream) {
          state.stream.end();
        }
      }
      fileStates.clear();
      batchBuffers.clear();
      batchTimers.clear();
      parentPort.postMessage({ id, success: true });
    });
  }
}

function handleGetStatus(id) {
  const status = {
    files: Array.from(fileStates.keys()),
    batchBuffers: Array.from(batchBuffers.entries()).map(([fp, buf]) => ({
      filePath: fp,
      itemCount: buf.length
    })),
    pendingTimers: batchTimers.size
  };
  parentPort.postMessage({ id, success: true, data: status });
}

parentPort.on('message', (message) => {
  const { type, id, filePath, content, options } = message;

  switch (type) {
    case 'append':
      handleAppend(id, filePath, content, options);
      break;
    case 'flush':
      handleFlush(id, filePath);
      break;
    case 'close':
      handleClose(id, filePath);
      break;
    case 'get-status':
      handleGetStatus(id);
      break;
    default:
      parentPort.postMessage({ id, success: false, error: `Unknown type: ${type}` });
  }
});

log('info', 'LogAppendWorker initialized');
