// Dependencies
const { parentPort } = require('worker_threads');
const EmailDedupLRU = require('../cache/email-dedup-lru');

/**
 * Email deduplication Worker
 * Handles CPU-intensive email deduplication operations, runs in independent threads
 * Note: this Worker does not create EmailDedupManager instance to avoid circular dependency
 */

// Local cache implementation - does not depend on EmailDedupManager
const cacheStrategy = 'map'; // Can be passed via workerData, but keep simple for now
const useLRU = cacheStrategy === 'lru';
let processedEmails;

if (useLRU) {
  processedEmails = new EmailDedupLRU(10000);
} else {
  processedEmails = new Map();
}

const ttl = 86400000; // Default 24-hour expiration
const maxSize = 10000; // Maximum cache count

// Signaling email cache
const signalingEmails = new EmailDedupLRU(5000);
const signalingTtl = 600000; // Default 10 minutes

/**
 * Send log message to main thread
 * @param {string} level - Log level (info, warn, error)
 * @param {string} message - Log message
 */
function sendLog(level, message) {
  parentPort.postMessage({
    type: 'log',
    level,
    message: `[EmailDedup] ${message}`
  });
}

/**
 * Generate email unique identifier
 * @param {number|string} uid - Email UID
 * @param {string} messageId - Email Message-ID header
 * @param {string} subject - Email subject
 * @returns {string} Unique identifier
 */
function generateKey(uid, messageId, subject, from = '') {
  if (messageId) {
    return `msgid:${messageId}`;
  }
  return `uid:${uid}:${from}:${subject}`;
}

/**
 * Batch check whether emails have been processed
 * @param {Array} emails - Email array
 * @returns {Object} Processing result
 */
function handleBatchIsProcessed(emails) {
  const startTime = Date.now();
  const cutoffTime = Date.now() - ttl;
  const result = {};

  for (const email of emails) {
    const key = generateKey(
      email.uid,
      email.messageId,
      email.subject,
      email.from
    );
    
    let timestamp;
    if (useLRU) {
      timestamp = processedEmails.get(key);
    } else {
      timestamp = processedEmails.get(key);
    }
    
    const isProcessed = timestamp && timestamp > cutoffTime;
    result[key] = isProcessed;
  }

  const duration = Date.now() - startTime;
  sendLog('info', `Batch check completed, processed ${emails.length} email(s), duration ${duration}ms`);
  
  return result;
}

/**
 * Batch mark emails as processed
 * @param {Array} emails - Email array
 * @returns {Object} Processing result
 */
function handleBatchMarkAsProcessed(emails) {
  const startTime = Date.now();
  const now = Date.now();

  for (const email of emails) {
    const key = generateKey(
      email.uid,
      email.messageId,
      email.subject,
      email.from
    );

    if (processedEmails.size >= maxSize) {
      clearOldest(1000);
    }

    if (useLRU) {
      processedEmails.set(key, now);
    } else {
      processedEmails.set(key, now);
    }
  }

  const duration = Date.now() - startTime;
  sendLog('info', `Batch mark completed, processed ${emails.length} email(s), duration ${duration}ms`);
  
  return { success: true, count: emails.length };
}

/**
 * Clear oldest N records
 * @param {number} count - Number of records to clear
 */
function clearOldest(count = 1000) {
  if (useLRU) {
    processedEmails.evictLRU();
    return;
  }

  const toDelete = [];
  let removed = 0;
  
  for (const key of processedEmails.keys()) {
    if (removed >= count) break;
    toDelete.push(key);
    removed++;
  }
  
  toDelete.forEach(key => processedEmails.delete(key));
  sendLog('warn', `Cleared ${removed} oldest email dedup entries`);
}

/**
 * Handle cleanup of expired entries
 * @returns {number} Number of cleaned entries
 */
function handleCleanup() {
  const startTime = Date.now();
  const ageLimit = ttl;
  let removedCount = 0;

  if (useLRU) {
    removedCount = processedEmails.cleanup(ageLimit);
  } else {
    const cutoffTime = Date.now() - ageLimit;
    for (const [key, timestamp] of processedEmails.entries()) {
      if (timestamp < cutoffTime) {
        processedEmails.delete(key);
        removedCount++;
      }
    }
  }

  const signalingRemoved = signalingEmails.cleanup(signalingTtl);
  const duration = Date.now() - startTime;
  
  sendLog('info', `Cleanup completed, removed ${removedCount} expired entries, duration ${duration}ms`);
  
  return removedCount;
}

/**
 * Handle getting cache statistics
 * @returns {Object} Statistics
 */
function handleGetStats() {
  const stats = {
    strategy: cacheStrategy,
    processedEmails: useLRU ? processedEmails.getStats() : {
      size: processedEmails.size,
      maxSize: maxSize,
      ttl: ttl
    },
    signalingEmails: signalingEmails.getStats()
  };
  sendLog('info', `Get stats: strategy=${stats.strategy}, processed emails=${stats.processedEmails.size || 0}`);
  return stats;
}

// Listen to main thread messages
parentPort.on('message', (message) => {
  const { id, type, data } = message;
  
  try {
    sendLog('info', `Receive task: ${type}, ID=${id}`);
    
    let result;
    switch (type) {
      case 'BATCH_IS_PROCESSED':
        result = handleBatchIsProcessed(data.emails);
        break;
        
      case 'BATCH_MARK_AS_PROCESSED':
        result = handleBatchMarkAsProcessed(data.emails);
        break;
        
      case 'CLEANUP':
        result = handleCleanup();
        break;
        
      case 'GET_STATS':
        result = handleGetStats();
        break;
        
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    
    // Send success result back to main thread
    parentPort.postMessage({
      id,
      success: true,
      data: result
    });
    
  } catch (error) {
    sendLog('error', `Task processing failed ID=${id}: ${error.message}`);
    // Send error result back to main thread
    parentPort.postMessage({
      id,
      success: false,
      error: error.message
    });
  }
});

// Send initialization success message
sendLog('info', 'Email dedup Worker initialized (no circular dependencies)');
parentPort.postMessage({
  type: 'INITIALIZED'
});
