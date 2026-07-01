// Worker system module
import { getMyEmail } from '../utils/common.js';
import { handleWorkerMessage as handleJsonWorkerMessage } from '../utils/json-worker.js';

// Send Worker logs to the main process logging system
function sendWorkerLogToMain(level, workerName, message, error) {
    if (window.electronAPI && window.electronAPI.log) {
        const logMessage = `[Worker-${workerName}] ${message}${error ? ': ' + (error.message || error.toString()) : ''}`;
        window.electronAPI.log(level, logMessage, 'worker');
    }
}

// Web Worker manager class
export class WorkerManager {
    constructor() {
        this.workers = new Map();
        this.workerReadyStates = new Map(); // Track Worker ready state
        this.defaultOptions = {
            onError: (workerName, error) => {
                console.error(`${workerName} Worker error:`, error);
                sendWorkerLogToMain('error', workerName, 'Worker error', error);
            },
            onMessage: null,
            autoRestart: true
        };
    }
    
    // Check if Worker is ready
    isWorkerReady(name) {
        return this.workerReadyStates.get(name) === true;
    }
    
    // Wait for Worker ready (with timeout)
    async waitForWorkerReady(name, timeoutMs = 3000) {
        if (this.isWorkerReady(name)) {
            return true;
        }
        
        return new Promise((resolve) => {
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                if (this.isWorkerReady(name)) {
                    clearInterval(checkInterval);
                    resolve(true);
                } else if (Date.now() - startTime > timeoutMs) {
                    clearInterval(checkInterval);
                    resolve(false);
                }
            }, 50);
        });
    }

    // Initialize the Worker
    initWorker(name, scriptUrl, options = {}) {
        const config = { ...this.defaultOptions, ...options };
        
        // Clear the previous ready state
        this.workerReadyStates.delete(name);

        try {
            const worker = new Worker(scriptUrl);

            worker.onmessage = (e) => {
                // Handle Worker log messages
                if (e.data && e.data.type === 'WORKER_LOG') {
                    const { level, message, error } = e.data.payload;
                    sendWorkerLogToMain(level, name, message, error);
                    return;
                }
                
                // Mark the Worker as ready (after receiving the first message)
                if (!this.workerReadyStates.has(name)) {
                    this.workerReadyStates.set(name, true);
                    console.log(`${name} Worker is ready`);
                }
                
                if (!config.onMessage) return;
                try {
                    config.onMessage(e, worker);
                } catch (error) {
                    config.onError(name, error);
                }
            };

            worker.onerror = (error) => {
                config.onError(name, error);
                
                // Clear the ready state
                this.workerReadyStates.set(name, false);

                // If auto-restart is configured, try to restart the Worker
                if (config.autoRestart) {
                    console.log(`Attempting to restart ${name} Worker...`);
                    setTimeout(() => {
                        this.initWorker(name, scriptUrl, options);
                    }, 1000);
                }
            };

            this.workers.set(name, worker);
            console.log(`${name} Worker initialized successfully`);
            
            // Send a ready-check message to ensure the Worker is marked ready as soon as possible
            setTimeout(() => {
                if (this.workers.has(name)) {
                    try {
                        worker.postMessage({ type: 'HEALTH_CHECK' });
                    } catch (e) {
                        // Ignore error
                    }
                }
            }, 100);
            
            return worker;
        } catch (error) {
            config.onError(name, error);
            this.workerReadyStates.set(name, false);
            return null;
        }
    }

    // Get the Worker
    getWorker(name) {
        return this.workers.get(name);
    }

    // Send a message to the Worker
    postMessage(name, message) {
        const worker = this.getWorker(name);
        if (worker) {
            try {
                worker.postMessage(message);
                return true;
            } catch (error) {
                console.error(`Failed to post message to ${name} Worker:`, error);
                return false;
            }
        }
        return false;
    }

    // Stop the Worker
    stopWorker(name) {
        const worker = this.getWorker(name);
        if (worker) {
            try {
                worker.terminate();
                this.workers.delete(name);
                this.workerReadyStates.delete(name);
                console.log(`${name} Worker stopped`);
            } catch (error) {
                console.error(`Failed to stop ${name} Worker:`, error);
            }
        }
    }

    // Stop all Workers
    stopAllWorkers() {
        for (const [name] of this.workers) {
            this.stopWorker(name);
        }
    }
}

// Create Worker manager instance
export const workerManager = new WorkerManager();

// Web Workers references
export let emailDistributor = null;
export let deleteQueueWorker = null;
export let pollingScheduler = null;
export let signalingWorker = null;
export let imapServiceWorker = null;
export let utilsWorker = null;
export let webRTCWorker = null;

// Track whether business Workers have been initialized
let businessWorkersInitialized = false;

// Phase 1: initialize core Workers (called before login)
export function initCoreWorkers() {
    console.log('[WorkerSystem] Initializing core Workers...');
    
    // Initialize the IMAP service Worker (required for login)
    imapServiceWorker = workerManager.initWorker('imapServiceWorker', 'services/imap-service.worker.js', {
        onMessage: function (e) {
            if (!e || !e.data) return;
            const { success, data, error } = e.data;
            console.log('IMAP Service Worker message:', e.data);
            // Global message handling logic can be added here as needed
        }
    });
    
    // Initialize the WebRTC management Worker (must be ready before login, used for ICE candidate filtering)
    webRTCWorker = workerManager.initWorker('webRTCWorker', 'webrtc/manager.worker.js', {
        onMessage: function (e) {
            if (!e || !e.data) return;
            const { type, targetEmail, status, message, attempt, error } = e.data;

            switch (type) {
                case 'CONNECTION_STATUS_CHANGED':
                    // Handle connection state changes
                    console.log(`📡 WebRTC connection status changed: ${targetEmail} -> ${status}`);
                    break;

                case 'DATA_CHANNEL_MESSAGE':
                    // Received data channel message
                    console.log(`📨 Received message: ${targetEmail} -> ${message}`);
                    break;

                case 'RECONNECT_ATTEMPT':
                    // Reconnection attempt
                    console.log(`♻️ Attempting to reconnect: ${targetEmail} (attempt ${attempt})`);
                    break;

                case 'REQUEST_RECONNECT':
                    // Request reconnection
                    console.log(`♻️ Requesting reconnect: ${targetEmail}`);
                    // Recreate the connection
                    const reconnectWebcom = document.getElementById(`chat_${targetEmail}`);
                    if (reconnectWebcom) {
                        // Call the performSoftResetAndReconnect function, ensuring it is globally available
                        if (window.performSoftResetAndReconnect) {
                            window.performSoftResetAndReconnect(reconnectWebcom, targetEmail);
                        }
                    }
                    break;

                case 'CONNECTION_INACTIVE':
                    // Connection inactive for a long time
                    console.warn(`⚠️ Connection inactive for a long time: ${targetEmail}`);
                    break;

                case 'CHECK_AND_ADD_CONTACT':
                    // Check and add contact
                    if (window.checkAndAddContact) {
                        window.checkAndAddContact(e.data.fromEmail);
                    }
                    break;

                case 'WORKER_ERROR':
                    // Handle internal errors sent by the Worker
                    console.error('❌ WebRTC manager Worker internal error:', error);
                    break;

                case 'FORWARD_SEND_DATA':
                    // Forward data send requests
                    console.log(`📤 Forwarding data send request: ${targetEmail}`);
                    break;

                default:
                    console.log('📡 WebRTC Worker message:', e.data);
            }
        },
        onError: function (name, error) {
            // Handle Worker errors
            console.error(`❌ ${name} Worker error:`, error);
        },
        autoRestart: true
    });
    
    // Assign the WebRTC Worker reference to the window object so it is available early
    if (typeof window !== 'undefined') {
        window.webRTCWorker = webRTCWorker;
    }
    
    console.log('[WorkerSystem] Core Workers initialization complete');
}

// Phase 2: initialize business Workers (called after successful login)
export function initBusinessWorkers(myEmail) {
    if (businessWorkersInitialized) {
        console.log('[WorkerSystem] Business Workers already initialized, skipping');
        return;
    }
    
    if (!myEmail) {
        console.warn('[WorkerSystem] Cannot initialize business Workers: myEmail is empty');
        return;
    }
    
    console.log(`[WorkerSystem] Initializing business Workers, myEmail: ${myEmail}`);
    
    // 1. Initialize the Email Distributor Worker
    emailDistributor = workerManager.initWorker('emailDistributor', 'services/email-distributor.worker.js', {
        onMessage: function (e) {
            if (!e.data) return;
            const { type, signalingEmails, displayEmails, stats } = e.data;

            if (type === 'distributed') {
                console.log(`Email distribution complete: total ${stats?.total || 0}, signaling ${stats?.signaling || 0}, display ${stats?.display || 0}`);

                // Send optimized display data to the mailink-recver component
                const mailrecver = document.getElementById('mailrecver');
                if (mailrecver && typeof mailrecver.postMessage === 'function') {
                    mailrecver.postMessage({
                        type: 'emailsData',
                        emails: displayEmails
                    });
                } else if (mailrecver && mailrecver.contentWindow) {
                    mailrecver.contentWindow.postMessage({
                        type: 'emailsData',
                        emails: displayEmails
                    }, '*');
                }
            } else if (type === 'signalingEmailsFallback') {
                // Fallback: forward signaling emails to the signaling worker via the main thread
                console.log(`[WorkerSystem] Received fallback signaling emails, total ${signalingEmails?.length || 0}`);
                
                if (signalingWorker && signalingEmails && signalingEmails.length > 0) {
                    workerManager.postMessage('signalingWorker', {
                        type: 'processEmails',
                        emails: signalingEmails,
                        myEmail: getMyEmail(),
                        activeConnections: Array.from(window.activeConnections.entries())
                    });
                    console.log(`[WorkerSystem] Forwarded ${signalingEmails.length} signaling emails to signaling worker via main thread`);
                } else if (!signalingWorker) {
                    console.warn('[WorkerSystem] signalingWorker not initialized, cannot forward signaling emails');
                }
            } else if (type === 'error') {
                console.error('Email Distributor Worker error:', e.data.message);
            }
        }
    });

    // 2. Initialize the deletion queue Worker
    deleteQueueWorker = workerManager.initWorker('deleteQueueWorker', 'services/delete-queue.worker.js', {
        onMessage: async function (e) {
            if (!e || !e.data) return;
            const { type, batchId, batches } = e.data;

            if (type === 'executeBatch') {
                console.log(`Executing batch delete: ${batches.length} batches`);
                let result = null;

                try {
                    // Call delete for each subject prefix separately (can be improved if the backend supports batch deletion)
                    for (const batch of batches) {
                        for (const subjectPrefix of batch.subjectPrefixes) {
                            // Get the options for the current subject prefix
                            const options = batch.optionsMap ? batch.optionsMap.get(subjectPrefix) : {};
                            // Execute the deletion operation with retry mechanism
                            const { deleteEmailWithRetry } = await import('../utils/index.js');
                            result = await deleteEmailWithRetry(
                                window.selectedConfig,
                                batch.sender,
                                subjectPrefix,
                                options
                            );
                            console.log(`Delete complete: ${batch.sender} - ${subjectPrefix}`, result);
                        }
                    }
                } catch (error) {
                    console.error('Batch delete failed:', error);
                    result = { error: error.message };
                } finally {
                    // Send the deletion result back to the Worker to ensure the synchronous deletion mechanism works correctly
                    if (batchId) {
                        console.log(`Sending delete result to Worker, batch ID: ${batchId}`);
                        workerManager.postMessage('deleteQueueWorker', {
                            type: 'deleteResult',
                            batchId: batchId,
                            result: result
                        });
                    }
                }
            }
        }
    });

    // 3. Initialize the polling scheduler Worker
    pollingScheduler = workerManager.initWorker('pollingScheduler', 'services/polling-scheduler.worker.js', {
        onMessage: function (e) {
            if (!e || !e.data) return;
            const { type } = e.data;

            if (type === 'tick') {
                // Timer triggered; fetch emails after checking conditions
                if (window.isImapConnected) {
                    // [Fix] Decide whether to fetch only signaling emails based on signaling mode
                    const isSignalingMode = e.data.signalingMode || false;
                    console.log('⏰ Polling timer triggered, executing email fetch - poll', { signalingMode: isSignalingMode });
                    window.handleFetchEmailsRequest(2, isSignalingMode);
                }
            } else if (type === 'started') {
                console.log(`Polling started, mode: ${e.data.mode}, interval: ${e.data.interval}ms`);
            } else if (type === 'stopped') {
                console.log(`Polling stopped, executed ${e.data.finalTickCount} time(s)`);
            } else if (type === 'scheduleInfo') {
                // Debug info: dynamic interval calculation result
                if (e.data.signalingMode) {
                    console.log(`📡 Signaling mode enabled, high-frequency polling: ${e.data.interval}ms`);
                }
            }
        }
    });

    // Listen for signaling status change notifications from the main process (for signaling mode linkage)
    if (window.electronAPI?.onSignalingStateChanged) {
        window.electronAPI.onSignalingStateChanged((event, data) => {
            if (pollingScheduler) {
                pollingScheduler.postMessage({
                    type: 'signalingState',
                    data: data
                });
            }
        });
    }

    // 4. Initialize the signaling handler Worker
    signalingWorker = workerManager.initWorker('signalingWorker', 'webrtc/signaling.worker.js', {
        onMessage: function (e) {
            if (!e || !e.data) return;
            const { type, results } = e.data;

            if (type === 'SIGNALS_PROCESSED') {
                if (results && results.length > 0) {
                    console.log(`Worker processed ${results.length} signals`);

                    results.forEach(signal => {
                        if (!signal || typeof signal !== 'object') return;
                        
                        // Extract sender email from signal
                        const senderEmail = signal.from;
                        
                        // Check whether there is an UPDATE_CONTACT action containing avatar data
                        const hasUpdateContactWithAvatar = signal.actions && signal.actions.some(
                            action => action.type === 'UPDATE_CONTACT' && action.avatarData
                        );
                        
                        // Only call checkAndAddContact when there is no UPDATE_CONTACT with avatar
                        // This avoids duplicate contacts while ensuring avatar data is handled correctly
                        if (!hasUpdateContactWithAvatar) {
                            window.checkAndAddContact(signal.from);
                        } else {
                            console.log(`[WorkerSystem] Skipping checkAndAddContact, using UPDATE_CONTACT to handle contact and avatar: ${signal.from}`);
                        }

                        // Execute the operation instructions returned by the Worker
                        if (signal.actions && Array.isArray(signal.actions)) {
                            console.log(`[WorkerSystem] Executing ${signal.actions.length} actions:`, signal.actions.map(a => a.type));
                            signal.actions.forEach(action => {
                                console.log(`[WorkerSystem] Executing action: ${action.type}`, action);
                                window.handleWorkerAction(action, senderEmail);
                            });
                        }
                    });
                }
            }
        }
    });
    
    // Send updateMyEmail immediately after creation so the signalingWorker has the correct myEmail
    if (signalingWorker) {
        workerManager.postMessage('signalingWorker', {
            type: 'updateMyEmail',
            myEmail: myEmail
        });
        console.log(`[WorkerSystem] Sent updateMyEmail to signalingWorker: ${myEmail}`);
    }

    // 5. Initialize the utility function Worker
    utilsWorker = workerManager.initWorker('utilsWorker', 'services/utils.worker.js', {
        onMessage: function (e) {
            if (!e || !e.data) return;
            const { type, taskId, success, result, error } = e.data;
            
            // Handle JSON Worker messages first
            handleJsonWorkerMessage(e);
            
            // Utility function Worker result handling, passed to the caller via the event system
            if (type === 'result') {
                console.log('Utils Worker result:', { taskId, success, result });
                // More complex result handling logic can be added here
            }
        }
    });

    // 6. WebRTC management Worker was already initialized in initCoreWorkers()

    // 7. Establish a direct communication channel between emailDistributor and signalingWorker
    setupWorkerChannels();
    
    // 8. Assign Worker references to the window object for use by other modules
    // Fix: ensure variables like window.pollingScheduler point to the correct Worker instance
    if (typeof window !== 'undefined') {
        window.emailDistributor = emailDistributor;
        window.deleteQueueWorker = deleteQueueWorker;
        window.pollingScheduler = pollingScheduler;
        window.signalingWorker = signalingWorker;
        window.imapServiceWorker = imapServiceWorker;
        window.utilsWorker = utilsWorker;
        window.webRTCWorker = webRTCWorker;
        console.log('[WorkerSystem] Worker references assigned to window object');
    }
    
    // Start the Worker health check timer
    startWorkerHealthCheck();
    
    businessWorkersInitialized = true;
    console.log('[WorkerSystem] Business Workers initialization complete');
}

// Establish inter-Worker communication channels
function setupWorkerChannels() {
    if (emailDistributor && signalingWorker) {
        console.log('🔗 Establishing direct channel between EmailDistributor and SignalingWorker...');
        const signalingChannel = new MessageChannel();

        // Send one port to EmailDistributor
        emailDistributor.postMessage({
            type: 'init_signaling_port'
        }, [signalingChannel.port1]);

        // Send the other port to SignalingWorker
        signalingWorker.postMessage({
            type: 'init_signaling_port'
        }, [signalingChannel.port2]);
        
        console.log('✅ Direct channel established');
    }
}

// Reset business Worker initialization state (for re-login after logout)
export function resetBusinessWorkersState() {
    businessWorkersInitialized = false;
    console.log('[WorkerSystem] Business Workers initialization state reset');
}

// Stop all business Workers (used during logout)
export function stopBusinessWorkers() {
    console.log('[WorkerSystem] Stopping business Workers...');
    
    // Stop health checks
    stopWorkerHealthCheck();
    
    // Stop each business Worker
    if (emailDistributor) {
        workerManager.stopWorker('emailDistributor');
        emailDistributor = null;
    }
    if (deleteQueueWorker) {
        workerManager.stopWorker('deleteQueueWorker');
        deleteQueueWorker = null;
    }
    if (pollingScheduler) {
        workerManager.stopWorker('pollingScheduler');
        pollingScheduler = null;
    }
    if (signalingWorker) {
        workerManager.stopWorker('signalingWorker');
        signalingWorker = null;
    }
    if (utilsWorker) {
        workerManager.stopWorker('utilsWorker');
        utilsWorker = null;
    }
    // webRTCWorker is a core Worker and is not stopped here
    
    // Reset the initialization state
    businessWorkersInitialized = false;
    
    console.log('[WorkerSystem] Business Workers stopped');
}

// Worker health check timer
let healthCheckTimer = null;

function startWorkerHealthCheck() {
    // Check Worker status every 30 seconds
    healthCheckTimer = setInterval(() => {
        checkWorkerHealth();
    }, 30000);
}

function checkWorkerHealth() {
    const webRTCLogger = window._webp2pWebRTCLogger;
    
    console.log('[WorkerSystem] Starting Worker health check...');
    
    // Check emailDistributor
    if (emailDistributor) {
        const emailDistributorStatus = {
            exists: true,
            state: emailDistributor.state // running, transitioning, etc.
        };
        console.log('[WorkerSystem] emailDistributor @: ', emailDistributorStatus);
        
        // Try to send test message
        try {
            emailDistributor.postMessage({
                type: 'healthCheck',
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('[WorkerSystem] emailDistributor exception:', error);
            webRTCLogger.error('emailDistributor Worker exception: ' + error.message);
        }
    } else {
        console.warn('[WorkerSystem] emailDistributor does not exist');
    }
    
    // Check signalingWorker
    if (signalingWorker) {
        const signalingWorkerStatus = {
            exists: true,
            state: signalingWorker.state
        };
        console.log('[WorkerSystem] signalingWorker @: ', signalingWorkerStatus);
        
        // Try to send test message
        try {
            signalingWorker.postMessage({
                type: 'healthCheck',
                timestamp: Date.now()
            });
        } catch (error) {
            console.error('[WorkerSystem] signalingWorker exception:', error);
            webRTCLogger.error('signalingWorker exception: ' + error.message);
        }
    } else {
        console.warn('[WorkerSystem] signalingWorker does not exist');
    }
    
    console.log('[WorkerSystem] Worker health check complete');
}

// Stop Worker health checks
export function stopWorkerHealthCheck() {
    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
        healthCheckTimer = null;
        console.log('[WorkerSystem] Worker health check stopped');
    }
}
