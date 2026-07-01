# Email Queue System Integration Guide

## Overview

This system implements asynchronous queue-based processing for email parsing, separating email retrieval from parsing to improve system response speed and throughput.

## Core Components

### 1. Email Queue Manager (email-queue-manager.js)
- Manages the Worker pool and task queue
- Supports two-level queues: critical (signaling emails) and normal (regular emails)
- Automatic load balancing and failure recovery

### 2. Email Processing Worker (workers/email-processor.worker.js)
- Parses emails in an independent thread
- Supports batch processing
- Automatically saves to the database

### 3. Email Processing Service (email-processor-service.js)
- Encapsulates queue operations and provides a simple API
- Supports synchronous and asynchronous processing modes

### 4. IMAP IDLE Manager Queue Edition (imap-idle-manager-queue.js)
- Email fetching module integrated with the queue mechanism
- Supports fire-and-forget mode

## Usage

### Option 1: Fire-and-Forget (recommended for large volumes)

```javascript
const { ImapIdleManagerQueue } = require('./imap-idle-manager-queue');

// When new emails arrive, quickly enqueue them without waiting for parsing
async function onNewMails(imap, uids, username) {
  const result = await ImapIdleManagerQueue.fetchAndQueueEmails(
    imap,
    uids,
    { bodies: '', struct: true },
    username
  );
  
  console.log(`${result.queued} emails enqueued, processing in the background...`);
  // Return immediately without waiting for parsing to complete
}
```

### Option 2: Synchronous Parsing (when results are needed immediately)

```javascript
const { getEmailProcessorService } = require('./email-processor-service');

const processor = getEmailProcessorService();
await processor.initialize();

// Parse a single email
const result = await processor.parseEmail(streamBuffer, uid, username, {
  isSignaling: false,
  timeout: 30000
});

console.log('Email parsing completed:', result.emailData);
```

### Option 3: Batch Processing

```javascript
// Parse and save in batches
const emails = [
  { streamBuffer: buffer1, uid: 1001 },
  { streamBuffer: buffer2, uid: 1002 },
  // ...
];

const result = await processor.batchParseAndSave(emails, username);
console.log(`Batch processing completed: success=${result.saved}, failed=${result.failed}`);
```

## Integrating into Existing Code

### Modify imap-fetch.worker.js

In the `fetchEmails` function, replace the email parsing section with queue processing:

```javascript
// Original code: direct parsing
const parsed = await simpleParser(stream);

// New code: use the queue
const { ImapIdleManagerQueue } = require('./imap-idle-manager-queue');
const result = await ImapIdleManagerQueue.fetchAndQueueEmails(
  imap, 
  results, 
  fetchOptions, 
  config.username
);
```

### Modify imap-idle-manager.js

In the `_fetchEmails` method, add queue support:

```javascript
// Add queue import
const { getEmailProcessorService } = require('./email-processor-service');

// Inside _fetchEmails
const processor = getEmailProcessorService();

// Replace the simpleParser call
// Original code:
// const parsed = await simpleParser(readableStream);

// New code:
const result = await processor.parseEmail(streamBuffer, uid, username, {
  isSignaling: parsed.subject?.startsWith('WebRTC-SIGNAL-')
});
const emailData = result.emailData;
```

## Queue Status Monitoring

```javascript
const { ImapIdleManagerQueue } = require('./imap-idle-manager-queue');

// Get queue status
const status = ImapIdleManagerQueue.getQueueStatus();
console.log('Queue status:', {
  running: status.queueStatus.isRunning,
  workerPoolSize: status.queueStatus.poolSize,
  busyWorkers: status.queueStatus.busyWorkers,
  queueLength: status.queueStatus.queueLength,
  processingTasks: status.queueStatus.processingCount
});
```

## Event Listening

```javascript
const processor = getEmailProcessorService();

// Listen for successful email saves
processor.on('emailSaved', (data) => {
  console.log(`Email saved: UID=${data.uid}, ID=${data.emailId}`);
});

// Listen for processing failures
processor.on('emailFailed', (data) => {
  console.error(`Email processing failed: UID=${data.uid}`, data.error);
});

// Listen for batch completion
processor.on('batchCompleted', (data) => {
  console.log(`Batch processing completed: total=${data.total}, success=${data.saved}`);
});
```

## Configuration Options

```javascript
const processor = getEmailProcessorService({
  // Worker pool size (default: number of CPU cores)
  poolSize: 4,
  
  // Maximum queue length
  maxQueueSize: 1000,
  
  // Task timeout in milliseconds
  taskTimeout: 30000,
  
  // Worker file path
  workerPath: path.join(__dirname, 'workers', 'email-processor.worker.js')
});
```

## Performance Comparison

| Scenario | Original Solution | Queue Solution | Improvement |
|----------|-------------------|----------------|-------------|
| Single email parsing | Synchronous blocking | Asynchronous non-blocking | Response speed ↑ |
| 100 emails | Sequential processing | Parallel processing | Throughput ↑↑ |
| Large attachment email | Blocks main thread | Worker processing | Smooth UI ↑ |

## Notes

1. **Database connections**: Workers need independent database connections; main-thread connections cannot be reused
2. **Memory management**: Large attachment emails are processed in Workers to avoid main-thread memory overflow
3. **Error handling**: Queue processing failures are notified via events; listeners must be in place
4. **Graceful shutdown**: Call `shutdown()` before application exit to wait for the queue to complete

## Troubleshooting

### Queue not processing
```javascript
// Check queue status
const status = ImapIdleManagerQueue.getQueueStatus();
console.log(status);
```

### Worker crash
- Check log messages prefixed with `[EmailProcessor#N]`
- Verify the Worker file path is correct
- Confirm the `mailparser` module is installed

### Memory leak
- Limit the maximum queue length with `maxQueueSize`
- Set a reasonable task timeout
- Regularly monitor `processingCount`
