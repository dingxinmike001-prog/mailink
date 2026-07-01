/**
 * JSON Processor Worker
 * used to process large JSON serialization/deserialization in the main process
 * avoid blocking the main thread
 */

const { parentPort } = require('worker_threads');

/**
 * Send log message to main thread
 * @param {string} level - Log level (info, warn, error)
 * @param {string} message - Log message
 */
function sendLog(level, message) {
  if (parentPort) {
    parentPort.postMessage({
      type: 'log',
      level,
      message: `[JSON Processor] ${message}`
    });
  }
}

/**
 * JSON large data serialization(stringify)
 * @param {any} data - data to serialize
 * @param {Object} options - options
 * @returns {string} JSON string
 */
function jsonStringifyLarge(data, options = {}) {
  const { space = 0 } = options;

  // Handle circular references
  const seen = new WeakSet();
  const safeData = JSON.parse(JSON.stringify(data, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular Reference]';
      }
      seen.add(value);
    }
    return value;
  }));

  return JSON.stringify(safeData, null, space);
}

/**
 * JSON large data deserialization(parse)
 * @param {string} jsonString - JSON string
 * @param {Object} options - options
 * @returns {any} parse result
 */
function jsonParseLarge(jsonString, options = {}) {
  const { defaultValue = {} } = options;

  if (!jsonString || typeof jsonString !== 'string') {
    return defaultValue;
  }

  return JSON.parse(jsonString);
}

/**
 * Batch parse email split fields(attachments and headers are JSON TEXT)
 * @param {Array} rows - email row data
 * @param {Object} options - options
 * @returns {Array} parsed row data
 */
function batchParseEmailDstr(rows, options = {}) {
  if (!Array.isArray(rows)) return [];

  const results = [];
  let successCount = 0;
  let errorCount = 0;

  for (const row of rows) {
    let parsed = { text: '', html: '', attachments: [], headers: {}, priority: '' };
    try {
      // Read txtbody and htmbody directly
      parsed.text = row.txtbody || '';
      parsed.html = row.htmbody || '';
      parsed.priority = row.priority || '';

      // Parse attachments JSON
      if (row.attachments) {
        if (typeof row.attachments === 'string') {
          parsed.attachments = JSON.parse(row.attachments);
        } else if (Array.isArray(row.attachments)) {
          parsed.attachments = row.attachments;
        }
      }

      // Parse headers JSON
      if (row.headers) {
        if (typeof row.headers === 'string') {
          parsed.headers = JSON.parse(row.headers);
        } else if (typeof row.headers === 'object') {
          parsed.headers = row.headers;
        }
      }

      successCount++;
    } catch (e) {
      errorCount++;
    }

    results.push({
      ...row,
      _parsedDstr: parsed
    });
  }

  sendLog('info', `Batch parse completed: total=${rows.length}, success=${successCount}, failed=${errorCount}`);

  return results;
}

/**
 * Batch serialize email data into separate fields
 * @param {Array} emails - email data array
 * @param {Object} options - options
 * @returns {Array} serialized email data
 */
function batchStringifyEmailDstr(emails, options = {}) {
  if (!Array.isArray(emails)) return [];

  const results = [];
  let successCount = 0;
  let errorCount = 0;

  for (const email of emails) {
    try {
      // Directly serialize attachments and headers to JSON strings
      const txtbody = email.text || '';
      const htmbody = email.html || '';
      const attachments = JSON.stringify(email.attachments || []);
      const headers = JSON.stringify(email.headers || {});
      const priority = email.priority || '';

      results.push({
        ...email,
        _txtbody: txtbody,
        _htmbody: htmbody,
        _attachments: attachments,
        _headers: headers,
        _priority: priority
      });
      successCount++;
    } catch (e) {
      errorCount++;
      results.push({
        ...email,
        _txtbody: '',
        _htmbody: '',
        _attachments: '[]',
        _headers: '{}',
        _priority: ''
      });
    }
  }

  sendLog('info', `Batch stringify completed: total=${emails.length}, success=${successCount}, failed=${errorCount}`);

  return results;
}

// Listen to main thread messages
parentPort.on('message', async (message) => {
  const { taskId, action, params } = message;
  const startTime = Date.now();

  try {
    let result;

    switch (action) {
      case 'jsonParse':
        result = jsonParseLarge(params.jsonString, params.options);
        break;
      case 'jsonStringify':
        result = jsonStringifyLarge(params.data, params.options);
        break;
      case 'batchParseEmailDstr':
        result = batchParseEmailDstr(params.rows, params.options);
        break;
      case 'batchStringifyEmailDstr':
        result = batchStringifyEmailDstr(params.emails, params.options);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const duration = Date.now() - startTime;
    sendLog('info', `Task completed: action=${action}, taskId=${taskId}, duration=${duration}ms`);

    // Send success result back to main thread
    parentPort.postMessage({
      taskId,
      success: true,
      result
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    sendLog('error', `Task failed: action=${action}, taskId=${taskId}, error=${error.message}, duration=${duration}ms`);

    // Send error result back to main thread
    parentPort.postMessage({
      taskId,
      success: false,
      error: {
        message: error.message,
        stack: error.stack
      }
    });
  }
});

sendLog('info', 'JSON Processor Worker initialized');
