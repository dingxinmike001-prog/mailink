// IMAP Service Worker
// Handle all IMAP-related async operations

// Signaling email prefix constant (keep in sync with shared/config/signaling-constants.js)
const SIGNALING_EMAIL_PREFIX = 'WebRTC-SIGNAL-';

console.log('IMAP Service Worker initialized');

// Send logs to the main process
function sendLogToMain(level, message, error) {
  self.postMessage({
    type: 'WORKER_LOG',
    payload: {
      level,
      message,
      error: error ? error.message || error.toString() : undefined,
      timestamp: new Date().toISOString()
    }
  });
}

// Listen to messages from the main thread
self.addEventListener('message', (event) => {
  const { type, payload } = event.data;

  console.log('Worker received message:', type, payload);

  // Call the corresponding handler based on message type
  switch (type) {
    case 'FETCH_EMAILS_REQUEST':
      handleFetchEmailsRequest(event);
      break;
    case 'SYNC_CONNECTION_STATUS':
      syncConnectionStatus(event);
      break;
    case 'EXECUTE_IMAP_RECONNECT':
      executeImapReconnect(event);
      break;
    case 'CHECK_AND_CREATE_DATABASE':
      checkAndCreateDatabase(event);
      break;
    case 'RESET_DATABASE':
      handleResetDatabase(event);
      break;
    case 'DELETE_EMAILS_BY_SENDER_AND_SUBJECT':
      handleDeleteEmailsBySenderAndSubject(event);
      break;
    case 'DELETE_EMAILS_BY_UID':
      handleDeleteEmailsByUid(event);
      break;
    case 'PING':
      // Health check response
      event.ports[0]?.postMessage({ type: 'PONG', success: true });
      break;
    case 'HEALTH_CHECK':
      // Health check message to confirm Worker is ready
      // No processing needed; receiving the message makes the main thread mark it as ready
      break;
    default:
      console.warn('Unknown message type:', type);
      event.ports[0]?.postMessage({
        success: false,
        error: `Unknown message type: ${type}`
      });
  }
});

// Email fetching and processing
async function handleFetchEmailsRequest(event) {
  try {
    const { config, minutes, onlySignaling } = event.data.payload || {};

    if (!config) {
      throw new Error('IMAP config is required for fetching emails');
    }

    const username = config.username;
    console.log(`Fetching emails for ${username}, minutes: ${minutes}, onlySignaling: ${onlySignaling}`);

    // A browser-compatible IMAP client library is needed here
    // Create the basic framework first; integrate a concrete IMAP implementation later

    // 1. Connect to IMAP server
    // 2. Search for emails matching the criteria
    // 3. Fetch and parse emails
    // 4. Process emails (store in IndexedDB, etc.)
    // 5. Return results

    // Simulate the email fetching process
    const mockEmails = [
      {
        uid: 1,
        subject: SIGNALING_EMAIL_PREFIX + 'test',
        from: 'test@example.com',
        date: new Date(),
        text: 'Test signaling email',
        messageId: 'test-123'
      }
    ];

    // Store emails in IndexedDB
    if (mockEmails.length > 0) {
      await storeEmailsToIndexedDB(username, mockEmails);
    }

    event.ports[0]?.postMessage({
      success: true,
      data: mockEmails
    });
  } catch (error) {
    console.error('Error fetching emails:', error);
    event.ports[0]?.postMessage({
      success: false,
      error: error.message
    });
  }
}

// Store emails in IndexedDB
async function storeEmailsToIndexedDB(username, emails) {
  try {
    const dbName = `${username}_emails`;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(['recv'], 'readwrite');
      const store = transaction.objectStore('recv');

      let storedCount = 0;

      emails.forEach(email => {
        // Add creation time with nanosecond precision
        const nowMs = Date.now();
        const perfNow = performance.now();
        // Convert to nanosecond timestamp: (ms timestamp * 1e9) + (high-precision fractional ms * 1e6)
        const nanoseconds = BigInt(nowMs) * BigInt(1000000000) + BigInt(Math.floor(perfNow * 1000000));
        const emailWithCreateTime = {
          ...email,
          createtime: nanoseconds.toString()
        };

        const request = store.add(emailWithCreateTime);
        request.onsuccess = () => {
          storedCount++;
        };
        request.onerror = (e) => {
          console.error('Error storing email:', e.target.error);
        };
      });

      transaction.oncomplete = () => {
        db.close();
        console.log(`Stored ${storedCount} emails to IndexedDB`);
        resolve(storedCount);
      };
      transaction.onerror = (e) => {
        db.close();
        reject(e.target.error);
      };
    });
  } catch (error) {
    console.error('Error storing emails to IndexedDB:', error);
    throw error;
  }
}

// Store connection status and reconnection records
const connectionStatusMap = new Map();
const reconnectHistory = new Map(); // username -> { lastReconnectTime, retryCount }

// Reconnection configuration constants
const MIN_RECONNECT_INTERVAL = 30000; // 30-second cooldown
const MAX_VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY = 1000; // 1-second verification delay

// Generic function to request the main thread to execute an Electron API
async function requestMainAction(type, payload) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      channel.port1.close();
      resolve(event.data);
    };
    // Send a message with the isActionRequest flag so the main thread knows it is an instruction to execute and reply to
    self.postMessage({ type, payload, isActionRequest: true }, [channel.port2]);
  });
}

// Connection status synchronization
async function syncConnectionStatus(event) {
  try {
    const { username } = event.data.payload || {};

    if (!username) {
      throw new Error('Username is required for syncing connection status');
    }

    // Get current connection status; initialize to disconnected if it does not exist
    const currentStatus = connectionStatusMap.get(username) || {
      connected: false,
      status: 'disconnected',
      supportsIdle: false,
      idleEnabled: false,
      lastActivity: Date.now()
    };

    event.ports[0]?.postMessage({
      success: true,
      data: currentStatus
    });
  } catch (error) {
    console.error('Error syncing connection status:', error);
    event.ports[0]?.postMessage({
      success: false,
      error: error.message
    });
  }
}

// Update connection status
function updateConnectionStatus(username, statusUpdates) {
  const currentStatus = connectionStatusMap.get(username) || {
    connected: false,
    status: 'disconnected',
    supportsIdle: false,
    idleEnabled: false,
    lastActivity: Date.now()
  };

  const newStatus = {
    ...currentStatus,
    ...statusUpdates,
    lastActivity: Date.now()
  };

  connectionStatusMap.set(username, newStatus);
  return newStatus;
}

// IMAP reconnection logic: includes cooldown mechanism and complex reconnection attempt sequence (moved from imap-service.js)
async function executeImapReconnect(event) {
  const { config } = event.data.payload || {};
  const replyPort = event.ports[0];

  try {
    if (!config) {
      throw new Error('IMAP config is required for reconnecting');
    }

    const username = config.username;
    const now = Date.now();

    // 1. Check the reconnection cooldown
    const history = reconnectHistory.get(username) || { lastReconnectTime: 0, retryCount: 0 };
    const timeSinceLast = now - history.lastReconnectTime;

    if (timeSinceLast < MIN_RECONNECT_INTERVAL) {
      console.log(`[Worker] In reconnect cooling period, skipping reconnect attempt (${timeSinceLast}ms < ${MIN_RECONNECT_INTERVAL}ms)`);
      replyPort?.postMessage({
        success: false,
        error: `In cooling period: ${Math.ceil((MIN_RECONNECT_INTERVAL - timeSinceLast) / 1000)}s remaining`
      });
      return;
    }

    console.log(`[Worker] Starting reconnect sequence for ${username}...`);
    reconnectHistory.set(username, { ...history, lastReconnectTime: now });

    // Update status to reconnecting
    updateConnectionStatus(username, { status: 'reconnecting', connected: false });

    // 2. Perform disconnect (request main thread execution)
    console.log('[Worker] Requesting main thread to disconnect existing IMAP connection...');
    await requestMainAction('DISCONNECT_IMAP', { config });

    // 3. Perform re-login (request main thread execution)
    console.log('[Worker] Requesting main thread to perform re-login...');
    const loginResult = await requestMainAction('LOGIN_IMAP', { config });

    if (!loginResult.success) {
      throw new Error(loginResult.error || 'Login failed during reconnect');
    }

    // 4. Verify connection status multiple times (mirroring logic in imap-service.js)
    let reconnectSuccess = false;
    for (let i = 1; i <= MAX_VERIFY_ATTEMPTS; i++) {
      console.log(`[Worker] Reconnect verification attempt ${i}/${MAX_VERIFY_ATTEMPTS}...`);

      // Wait for the verification delay
      await new Promise(resolve => setTimeout(resolve, VERIFY_DELAY));

      // Verify connection status (request main thread to synchronize status)
      const statusResult = await requestMainAction('GET_IMAP_STATUS', { username });

      if (statusResult.success && statusResult.data && statusResult.data.connected) {
        reconnectSuccess = true;
        break;
      }

      console.log(`[Worker] Verification attempt ${i} failed, connection status still disconnected`);
    }

    if (reconnectSuccess) {
      console.log(`[Worker] ${username} reconnected successfully`);
      updateConnectionStatus(username, { connected: true, status: 'connected' });
      replyPort?.postMessage({
        success: true,
        data: { reconnected: true, message: 'Successfully reconnected and verified' }
      });
    } else {
      console.error(`[Worker] ${username} reconnect sequence completed, but multiple verifications still show disconnected`);
      updateConnectionStatus(username, { connected: false, status: 'disconnected' });
      replyPort?.postMessage({
        success: false,
        error: 'Reconnection executed but verification failed'
      });
    }

  } catch (error) {
    console.error('[Worker] IMAP reconnect sequence execution failed:', error);
    const username = config?.username;
    if (username) {
      updateConnectionStatus(username, { connected: false, status: 'disconnected' });
    }
    replyPort?.postMessage({
      success: false,
      error: error.message
    });
  }
}

// Database check and creation (with retry mechanism)
async function checkAndCreateDatabase(event) {
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[DB] Attempt ${attempt}/${maxRetries} to check/create database`);
      sendLogToMain('info', `[DB] Attempt ${attempt}/${maxRetries} to check/create database`);

      const result = await tryCheckAndCreateDatabase(event);

      console.log(`[DB] Database check/create successful`);
      sendLogToMain('info', '[DB] Database check/create successful');
      event.ports[0]?.postMessage({
        success: true,
        data: result
      });
      return;

    } catch (error) {
      console.warn(`[DB] Attempt ${attempt} failed:`, error.message);
      sendLogToMain('warn', `[DB] Attempt ${attempt} failed`, error);
      lastError = error;

      if (attempt < maxRetries) {
        const delay = attempt * 1000; // Increment the delay
        console.log(`[DB] Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  console.error('[DB] All retries failed:', lastError);
  sendLogToMain('error', '[DB] All retries failed', lastError);
  event.ports[0]?.postMessage({
    success: false,
    error: lastError.message,
    details: 'Giving up after multiple database operation failures, please try restarting the app or clearing storage space'
  });
}

// Actual database check and creation logic
async function tryCheckAndCreateDatabase(event) {
  const { username } = event.data.payload || {};
  if (!username) {
    throw new Error('Username is required for database creation');
  }

  const dbName = `${username}_emails`;
  const dbVersion = 1;

  console.log(`[DB] Opening database: ${dbName}`);

  // Try to open the database
  let db;
  try {
    const openResult = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        console.log(`[DB] Database upgrade/create: ${dbName}`);

        // Create the emails table
        if (!db.objectStoreNames.contains('recv')) {
          const recvStore = db.createObjectStore('recv', {
            keyPath: 'id',
            autoIncrement: true
          });
          recvStore.createIndex('subject', 'subject', { unique: false });
          recvStore.createIndex('from', 'from', { unique: false });
          recvStore.createIndex('date', 'date', { unique: false });
          recvStore.createIndex('createtime', 'createtime', { unique: false });
          console.log(`[DB] Creating recv object store`);
        }
      };

      request.onsuccess = (e) => {
        console.log(`[DB] Database opened successfully: ${dbName}`);
        resolve(e.target.result);
      };
      request.onerror = (e) => {
        console.error(`[DB] Database open failed:`, e.target.error);
        sendLogToMain('error', '[DB] Database open failed', e.target.error);
        reject(e.target.error);
      };
      request.onblocked = (e) => {
        console.warn(`[DB] Database blocked:`, e);
        sendLogToMain('warn', '[DB] Database blocked', e);
      };
    });
    db = openResult;
  } catch (openError) {
    // If opening fails, try to delete the corrupted database and recreate it
    console.warn('[DB] Failed to open database, trying to delete and recreate:', openError.message);
    sendLogToMain('warn', '[DB] Failed to open database, trying to delete and recreate', openError);

    // Add a delay to ensure the previous connection is closed
    await new Promise(resolve => setTimeout(resolve, 500));

    await new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase(dbName);
      deleteRequest.onsuccess = () => {
        console.log(`[DB] Database deleted successfully: ${dbName}`);
        resolve();
      };
      deleteRequest.onerror = () => {
        console.error(`[DB] Database delete failed:`, deleteRequest.error);
        sendLogToMain('error', '[DB] Database delete failed', deleteRequest.error);
        reject(deleteRequest.error);
      };
      deleteRequest.onblocked = () => {
        console.warn(`[DB] Database deletion blocked: ${dbName}`);
        sendLogToMain('warn', `[DB] Database deletion blocked: ${dbName}`);
        // Do not reject; keep trying
        resolve();
      };
    });

    // Add a delay to ensure the deletion is complete
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log(`[DB] Reopening database: ${dbName}`);

    // Reopen the database
    const newDbResult = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        console.log(`[DB] Recreating database: ${dbName}`);

        if (!db.objectStoreNames.contains('recv')) {
          const recvStore = db.createObjectStore('recv', {
            keyPath: 'id',
            autoIncrement: true
          });
          recvStore.createIndex('subject', 'subject', { unique: false });
          recvStore.createIndex('from', 'from', { unique: false });
          recvStore.createIndex('date', 'date', { unique: false });
          recvStore.createIndex('createtime', 'createtime', { unique: false });
          console.log(`[DB] Recreating recv object store`);
        }
      };

      request.onsuccess = (e) => {
        console.log(`[DB] Database reopened successfully: ${dbName}`);
        resolve(e.target.result);
      };
      request.onerror = (e) => {
        console.error(`[DB] Database reopen failed:`, e.target.error);
        reject(e.target.error);
      };
    });
    db = newDbResult;
  }

  // Add a delay to ensure database operations are complete
  await new Promise(resolve => setTimeout(resolve, 100));

  db.close();
  console.log(`[DB] Database closed: ${dbName}`);

  return {
    databaseCreated: true,
    databaseName: dbName,
    message: 'Database checked and created successfully'
  };
}

// Reset database (delete and recreate)
async function handleResetDatabase(event) {
  try {
    const { username } = event.data.payload || {};
    if (!username) {
      throw new Error('Username is required for database reset');
    }

    const dbName = `${username}_emails`;

    // Delete the database
    await new Promise((resolve, reject) => {
      const deleteRequest = indexedDB.deleteDatabase(dbName);
      deleteRequest.onsuccess = () => {
        console.log('Database deleted successfully:', dbName);
        resolve();
      };
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onblocked = () => {
        console.warn('Database deletion blocked, but will proceed');
        resolve();
      };
    });

    // Recreate the database
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('recv')) {
          const recvStore = db.createObjectStore('recv', {
            keyPath: 'id',
            autoIncrement: true
          });
          recvStore.createIndex('subject', 'subject', { unique: false });
          recvStore.createIndex('from', 'from', { unique: false });
          recvStore.createIndex('date', 'date', { unique: false });
          recvStore.createIndex('createtime', 'createtime', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        e.target.result.close();
        resolve();
      };
      request.onerror = (e) => reject(e.target.error);
    });

    event.ports[0]?.postMessage({
      success: true,
      data: {
        databaseReset: true,
        databaseName: dbName,
        message: 'Database reset successfully'
      }
    });
  } catch (error) {
    console.error('Error resetting database:', error);
    event.ports[0]?.postMessage({
      success: false,
      error: error.message
    });
  }
}

// Email deletion logic - by sender and subject
async function handleDeleteEmailsBySenderAndSubject(event) {
  try {
    const { config, sender, subjectPrefix, options } = event.data.payload || {};

    if (!config) {
      throw new Error('IMAP config is required for deleting emails');
    }

    if (!subjectPrefix) {
      throw new Error('Subject prefix is required for deleting emails by sender and subject');
    }

    const username = config.username;
    console.log(`Deleting emails by sender/subject for ${username}, sender: ${sender}, subjectPrefix: ${subjectPrefix}`);

    // Implement the actual email deletion logic by sender and subject here
    // 1. Connect to IMAP server
    // 2. Search for matching emails
    // 3. Delete matching emails
    // 4. Update local database

    // Simulate delete operation
    const deletedCount = 1;
    console.log(`Deleted ${deletedCount} emails by sender/subject for ${username}`);

    event.ports[0]?.postMessage({
      success: true,
      data: {
        deleted: deletedCount,
        message: `Successfully deleted ${deletedCount} emails by sender/subject`
      }
    });
  } catch (error) {
    console.error('Error deleting emails by sender/subject:', error);
    event.ports[0]?.postMessage({
      success: false,
      error: error.message
    });
  }
}

// Email deletion logic - by UID
async function handleDeleteEmailsByUid(event) {
  try {
    const { config, uids } = event.data.payload || {};

    if (!config) {
      throw new Error('IMAP config is required for deleting emails');
    }

    if (!uids || (Array.isArray(uids) && uids.length === 0)) {
      throw new Error('UIDs are required for deleting emails by UID');
    }

    // Ensure uids is an array
    const uidArray = Array.isArray(uids) ? uids : [uids];
    const username = config.username;

    console.log(`Deleting emails by UID for ${username}, uids: ${uidArray}`);

    // Implement the actual email deletion logic by UID here
    // 1. Connect to IMAP server
    // 2. Perform deletion for each UID
    // 3. Execute the expunge operation
    // 4. Update local database

    // Simulate delete operation
    const deletedCount = uidArray.length;
    console.log(`Deleted ${deletedCount} emails by UID for ${username}`);

    // Delete the corresponding email from IndexedDB
    await deleteEmailsFromIndexedDB(username, uidArray);

    event.ports[0]?.postMessage({
      success: true,
      data: {
        deleted: deletedCount,
        message: `Successfully deleted ${deletedCount} emails by UID`
      }
    });
  } catch (error) {
    console.error('Error deleting emails by UID:', error);
    event.ports[0]?.postMessage({
      success: false,
      error: error.message
    });
  }
}

// Delete emails from IndexedDB
async function deleteEmailsFromIndexedDB(username, uids) {
  try {
    const dbName = `${username}_emails`;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => reject(e.target.error);
    });

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(['recv'], 'readwrite');
      const store = transaction.objectStore('recv');

      let deletedCount = 0;

      uids.forEach(uid => {
        const request = store.delete(uid);
        request.onsuccess = () => {
          deletedCount++;
        };
        request.onerror = (e) => {
          console.error(`Error deleting email ${uid} from IndexedDB:`, e.target.error);
        };
      });

      transaction.oncomplete = () => {
        db.close();
        console.log(`Deleted ${deletedCount} emails from IndexedDB`);
        resolve(deletedCount);
      };
      transaction.onerror = (e) => {
        db.close();
        reject(e.target.error);
      };
    });
  } catch (error) {
    console.error('Error deleting emails from IndexedDB:', error);
    throw error;
  }
}

// Listen for Worker termination events
self.addEventListener('terminate', () => {
  console.log('IMAP Service Worker terminated');
});
