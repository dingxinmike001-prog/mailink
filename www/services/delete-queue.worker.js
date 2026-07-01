/**
 * Delete Queue Worker
 * Responsibility: Manage email deletion queue in a background thread
 * - Batch process deletion requests to reduce frequent IPC calls
 * - Intelligently merge multiple deletion requests from the same sender
 * - Delay execution to allow request merging
 * - Synchronous deletion: ensure deletion succeeds before continuing
 */

// Signaling email prefix constant (keep in sync with shared/config/signaling-constants.js)
const SIGNALING_EMAIL_PREFIX = 'WebRTC-SIGNAL-';

let deleteQueue = new Map(); // sender -> Map(subjectPrefix -> options)
let flushTimer = null;
const FLUSH_DELAY = 1000; // Deletion requests within 1 second are merged
const MAX_BATCH_SIZE = 50; // Maximum batch size per processing run to avoid excessive concurrent requests
let currentBatchId = 0; // Used to identify the current processing batch for synchronous deletion
let pendingBatches = []; // Pending batch queue
let isProcessingBatch = false; // Flag whether a batch is being processed to ensure synchronous execution

self.onmessage = function (e) {
    const { type, sender, subjectPrefix, options = {}, batchId, result } = e.data;

    if (type === 'queueDelete') {
        queueDeleteRequest(sender, subjectPrefix, options);
    } else if (type === 'immediateDelete') {
        // Execute a single deletion immediately without waiting for merge
        executeImmediateDelete(sender, subjectPrefix, options);
    } else if (type === 'flushNow') {
        // Execute all deletions in the queue immediately
        flushQueue();
    } else if (type === 'clearQueue') {
        // Clear queue without executing
        clearQueue();
    } else if (type === 'getQueueStatus') {
        // Return current queue status
        sendQueueStatus();
    } else if (type === 'startSignalingCleanup') {
        // Start automatic signaling email cleanup (moved from imap-service.js)
        handleSignalingCleanup();
    } else if (type === 'deleteResult') {
        // Received deletion result from main thread, continue processing next batch
        handleDeleteResult(batchId, result);
    }
};

/**
 * Handle automatic signaling email cleanup logic
 */
function handleSignalingCleanup() {
    console.log('[Delete Queue Worker] Starting automatic signaling email cleanup (signaling expired within 2 days)');

    // Get current date and date 2 days ago (format: YYYY-MM-DD)
    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];
    const tomorrowStr = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Build deletion options
    const deleteOptions = {
        since: twoDaysAgoStr,
        before: tomorrowStr
    };

    // List of signaling email prefixes to delete
    const signalingPrefixes = [
        SIGNALING_EMAIL_PREFIX + 'offer-complete-',
        SIGNALING_EMAIL_PREFIX + 'answer-complete-'
    ];

    // Add deletion requests for these prefixes to queue (empty sender string matches all senders)
    for (const prefix of signalingPrefixes) {
        console.log(`[Delete Queue Worker] Auto cleanup enqueued: ${prefix} (${twoDaysAgoStr} to ${tomorrowStr})`);
        queueDeleteRequest('', prefix, deleteOptions);
    }

    // Flush queue immediately and start deletion
    flushQueue();
}

/**
 * Add deletion request to queue
 */
function queueDeleteRequest(sender, subjectPrefix, options = {}) {
    const missingFields = [];
    if (sender == null) missingFields.push('sender');
    if (subjectPrefix == null || subjectPrefix === '') missingFields.push('subjectPrefix');
    if (missingFields.length > 0) {
        console.warn(`[Delete Queue Worker] Invalid delete request: missing ${missingFields.join(' and ')}`);
        return;
    }

    // Add to queue
    if (!deleteQueue.has(sender)) {
        deleteQueue.set(sender, new Map());
    }
    deleteQueue.get(sender).set(subjectPrefix, options);

    console.log(`[Delete Queue Worker] Queue added: ${sender} - ${subjectPrefix}, options: ${JSON.stringify(options)}, current queue size: ${deleteQueue.size}`);

    // Reset timer and delay execution to allow more request merging
    if (flushTimer) {
        clearTimeout(flushTimer);
    }

    flushTimer = setTimeout(() => {
        flushQueue();
    }, FLUSH_DELAY);
}

/**
 * Execute all deletion operations in queue
 */
function flushQueue() {
    if (deleteQueue.size === 0) {
        console.log('[Delete Queue Worker] Queue is empty, no action needed');
        return;
    }

    // Convert to batch array
    const allBatches = [];
    deleteQueue.forEach((prefixMap, sender) => {
        const batch = {
            sender: sender,
            subjectPrefixes: [],
            optionsMap: new Map()
        };

        prefixMap.forEach((options, subjectPrefix) => {
            batch.subjectPrefixes.push(subjectPrefix);
            batch.optionsMap.set(subjectPrefix, options);
        });

        allBatches.push(batch);
    });

    // Limit batch size per processing run
    const batchesToProcess = allBatches.slice(0, MAX_BATCH_SIZE);
    const remainingBatches = allBatches.slice(MAX_BATCH_SIZE);

    console.log(`[Delete Queue Worker] Executing batch delete: ${batchesToProcess.length} batches (${remainingBatches.length} remaining), total ` +
        `${batchesToProcess.reduce((sum, b) => sum + b.subjectPrefixes.length, 0)} requests`);

    // Add batches to pending queue
    pendingBatches.push(...batchesToProcess);

    // If no batch is being processed, start processing
    if (!isProcessingBatch) {
        processNextBatch();
    }

    // If there are remaining batches, rebuild queue and set timer
    if (remainingBatches.length > 0) {
        // Clear current queue
        deleteQueue.clear();

        // Rebuild queue
        remainingBatches.forEach(batch => {
            const prefixMap = new Map();
            batch.subjectPrefixes.forEach(subjectPrefix => {
                prefixMap.set(subjectPrefix, batch.optionsMap.get(subjectPrefix));
            });
            deleteQueue.set(batch.sender, prefixMap);
        });

        // Set timer to handle remaining batches
        flushTimer = setTimeout(() => {
            flushQueue();
        }, FLUSH_DELAY);

        console.log(`[Delete Queue Worker] ${remainingBatches.length} remaining batches will be processed after ${FLUSH_DELAY}ms`);
    } else {
        // Clear queue
        deleteQueue.clear();
        flushTimer = null;
    }
}

/**
 * Handle next batch of deletion requests
 */
function processNextBatch() {
    if (pendingBatches.length === 0) {
        isProcessingBatch = false;
        return;
    }

    isProcessingBatch = true;
    const batch = pendingBatches.shift();
    const batchId = ++currentBatchId;

    console.log(`[Delete Queue Worker] Processing batch ${batchId}: ${batch.sender} - ${batch.subjectPrefixes.join(', ')}`);

    // Send batch to main thread for execution, including batchId for identification
    self.postMessage({
        type: 'executeBatch',
        batchId: batchId,
        batches: [batch]
    });
}

/**
 * Handle deletion result returned from main thread
 */
function handleDeleteResult(batchId, result) {
    console.log(`[Delete Queue Worker] Batch ${batchId} deletion result:`, result);

    // Continue processing next batch
    processNextBatch();
}

/**
 * Clear queue
 */
function clearQueue() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    deleteQueue.clear();
    pendingBatches = [];
    isProcessingBatch = false;
    console.log('[Delete Queue Worker] Queue cleared');

    self.postMessage({
        type: 'queueCleared'
    });
}

/**
 * Execute single deletion immediately without waiting for merge
 */
function executeImmediateDelete(sender, subjectPrefix, options = {}) {
    const missingFields = [];
    if (sender == null) missingFields.push('sender');
    if (subjectPrefix == null || subjectPrefix === '') missingFields.push('subjectPrefix');
    if (missingFields.length > 0) {
        console.warn(`[Delete Queue Worker] Invalid immediate delete request: missing ${missingFields.join(' and ')}`);
        return;
    }

    console.log(`[Delete Queue Worker] Immediate delete: ${sender} - ${subjectPrefix}, options: ${JSON.stringify(options)}`);

    // Send deletion request to main thread immediately without waiting for merge
    const batchId = ++currentBatchId;
    pendingBatches.unshift({
        sender: sender,
        subjectPrefixes: [subjectPrefix],
        optionsMap: new Map([[subjectPrefix, options]])
    });

    // If no batch is being processed, start processing
    if (!isProcessingBatch) {
        processNextBatch();
    }
}

/**
 * Send queue status
 */
function sendQueueStatus() {
    const status = {
        queueSize: deleteQueue.size,
        pending: flushTimer !== null,
        batches: [],
        pendingBatches: pendingBatches.length,
        isProcessingBatch: isProcessingBatch
    };

    deleteQueue.forEach((prefixes, sender) => {
        status.batches.push({
            sender: sender,
            count: prefixes.size
        });
    });

    self.postMessage({
        type: 'queueStatus',
        status: status
    });
}

// Worker initialization log
console.log('[Delete Queue Worker] Initialized and ready with synchronous delete mechanism');
