// IMAP service module
import { workerManager, emailDistributor, deleteQueueWorker, pollingScheduler, signalingWorker, imapServiceWorker, initBusinessWorkers } from './worker-system.js';
import { sendEmailsToWebcom, sendFetchErrorToWebcom, notifyConnectionStatusChange } from '../index/ui-manager.js';
import { svgToPngDataUrl, isSvgString } from '../utils/image-utils.js';

// Worker health check
let workerHealthCheckInterval = null;
const WORKER_HEALTH_CHECK_INTERVAL = 30000; // Check every 30 seconds
const WORKER_HEALTH_THRESHOLD = 3; // Restart after 3 consecutive unhealthy checks

const workerHealthStatus = {
    imapFetch: { lastCheck: 0, consecutiveFailures: 0 },
    imapService: { lastCheck: 0, consecutiveFailures: 0 },
    parser: { lastCheck: 0, consecutiveFailures: 0 }
};

// Start Worker health checks
export function startWorkerHealthCheck() {
    if (workerHealthCheckInterval) {
        console.log('Worker health check already running');
        return;
    }
    
    console.log('🔍 Starting Worker health check...');
    workerHealthCheckInterval = setInterval(async () => {
        await performWorkerHealthCheck();
    }, WORKER_HEALTH_CHECK_INTERVAL);
}

// Stop Worker health checks
export function stopWorkerHealthCheck() {
    if (workerHealthCheckInterval) {
        clearInterval(workerHealthCheckInterval);
        workerHealthCheckInterval = null;
        console.log('✅ Worker health check stopped');
    }
}

// Execute Worker health checks
async function performWorkerHealthCheck() {
    const now = Date.now();
    
    // Check the IMAP Fetch Worker
    try {
        if (window.electronAPI && window.selectedConfig) {
            const status = await window.electronAPI.getImapStatus(window.selectedConfig.username);
            if (status && status.connected) {
                workerHealthStatus.imapFetch.lastCheck = now;
                workerHealthStatus.imapFetch.consecutiveFailures = 0;
            } else {
                workerHealthStatus.imapFetch.consecutiveFailures++;
                console.warn(`⚠️ IMAP Fetch Worker unhealthy, consecutive failure count: ${workerHealthStatus.imapFetch.consecutiveFailures}`);
                
                if (workerHealthStatus.imapFetch.consecutiveFailures >= WORKER_HEALTH_THRESHOLD) {
                    console.error('❌ IMAP Fetch Worker unhealthy 3 consecutive times, attempting restart...');
                    handleWorkerCrash();
                    workerHealthStatus.imapFetch.consecutiveFailures = 0;
                }
            }
        }
    } catch (error) {
        workerHealthStatus.imapFetch.consecutiveFailures++;
        console.error('IMAP Fetch Worker health check failed:', error);
    }
    
    // Check the IMAP Service Worker
    if (imapServiceWorker) {
        try {
            // Send a ping message to check whether the Worker responds
            const pong = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Worker ping timeout')), 5000);
                imapServiceWorker.postMessage({ type: 'PING' });
                
                // Set up a one-time listener
                const handler = (event) => {
                    if (event.data && event.data.type === 'PONG') {
                        clearTimeout(timeout);
                        imapServiceWorker.removeEventListener('message', handler);
                        resolve(true);
                    }
                };
                imapServiceWorker.addEventListener('message', handler);
            });
            
            workerHealthStatus.imapService.lastCheck = now;
            workerHealthStatus.imapService.consecutiveFailures = 0;
        } catch (error) {
            workerHealthStatus.imapService.consecutiveFailures++;
            console.warn(`⚠️ IMAP Service Worker unhealthy, consecutive failure count: ${workerHealthStatus.imapService.consecutiveFailures}`);
            
            if (workerHealthStatus.imapService.consecutiveFailures >= WORKER_HEALTH_THRESHOLD) {
                console.error('❌ IMAP Service Worker unhealthy 3 consecutive times, attempting restart...');
                if (window.workerManager) {
                    window.workerManager.stopWorker('imapServiceWorker');
                    setTimeout(() => {
                        window.workerManager.initWorker('imapServiceWorker', 'services/imap-service.worker.js');
                    }, 1000);
                }
                workerHealthStatus.imapService.consecutiveFailures = 0;
            }
        }
    }
    
    // Log the health status summary
    console.log('📊 Worker health @: ', {
        imapFetch: { lastCheck: new Date(workerHealthStatus.imapFetch.lastCheck).toLocaleTimeString(), failures: workerHealthStatus.imapFetch.consecutiveFailures },
        imapService: { lastCheck: new Date(workerHealthStatus.imapService.lastCheck).toLocaleTimeString(), failures: workerHealthStatus.imapService.consecutiveFailures }
    });
}

// Update the title bar icon to the user's avatar
function updateTitlebarAvatar() {
    const avatar = window.selectedConfig?.avatar;
    const titlebarIcon = document.getElementById('titlebarIcon');
    const titlebarAvatar = document.getElementById('titlebarAvatar');
    const titlebarBadge = document.getElementById('titlebar-unread-badge');

    if (!titlebarIcon || !titlebarAvatar) return;

    if (avatar) {
        // If avatar exists, show it and remove the SVG icon from the DOM
        titlebarAvatar.src = avatar;
        titlebarAvatar.style.display = 'block';
        if (titlebarIcon.parentNode) {
            titlebarIcon.parentNode.removeChild(titlebarIcon);
        }
    } else {
        // If no avatar, show the SVG icon and hide the avatar
        titlebarAvatar.style.display = 'none';
        titlebarIcon.style.display = 'block';
    }
}

// Note: the svgToPngDataUrl function is imported from '../utils/image-utils.js'

/**
 * Update the system tray icon to the user's avatar
 */
async function updateTrayIconAvatar() {
    const avatar = window.selectedConfig?.avatar;

    if (!avatar) {
        console.log('[TrayIcon] User has not set avatar, keeping default tray icon');
        return;
    }

    try {
        let avatarData = avatar;

        // If the avatar is in SVG format, convert it to PNG
        if (avatar.startsWith('<svg')) {
            console.log('[TrayIcon] Avatar is SVG format, converting to PNG...');
            const pngDataUrl = await svgToPngDataUrl(avatar);
            if (pngDataUrl) {
                avatarData = pngDataUrl;
                console.log('[TrayIcon] SVG avatar converted successfully');
            } else {
                console.warn('[TrayIcon] SVG avatar conversion failed, keeping default tray icon');
                return;
            }
        }

        // Call the main process to set the tray icon
        if (window.electronAPI && window.electronAPI.setTrayIconToUserAvatar) {
            const result = await window.electronAPI.setTrayIconToUserAvatar(avatarData);
            if (result.success) {
                console.log('[TrayIcon] System tray icon set to user avatar');
            } else {
                console.warn('[TrayIcon] Failed to set tray icon:', result.error);
            }
        }
    } catch (err) {
        console.error('[TrayIcon] Failed to update tray icon:', err);
    }
}

// Generic function for sending messages to the IMAP Service Worker
async function sendToImapWorker(type, payload) {
    return new Promise((resolve, reject) => {
        if (!imapServiceWorker) {
            reject(new Error('IMAP Service Worker not initialized'));
            return;
        }

        const channel = new MessageChannel();

        channel.port1.onmessage = (event) => {
            channel.port1.close();

            if (event.data.success) {
                resolve(event.data.data);
            } else {
                reject(new Error(event.data.error || 'Unknown error'));
            }
        };

        imapServiceWorker.postMessage({ type, payload }, [channel.port2]);
    });
}

// Listen to and handle Action Requests from the IMAP Service Worker
if (imapServiceWorker) {
    imapServiceWorker.addEventListener('message', async (event) => {
        const { type, payload, isActionRequest } = event.data;
        if (!isActionRequest) return;

        const replyPort = event.ports[0];
        console.log(`[Main] Received Worker request: ${type}`, payload);

        try {
            let result;
            switch (type) {
                case 'DISCONNECT_IMAP':
                    await window.electronAPI.disconnectImap(payload.config);
                    result = { success: true };
                    break;
                case 'LOGIN_IMAP':
                    const loginRes = await window.electronAPI.loginImapConnection(payload.config);
                    result = { success: true, data: loginRes };
                    break;
                case 'GET_IMAP_STATUS':
                    const status = await window.electronAPI.getImapStatus(payload.username);
                    result = { success: true, data: status };
                    break;
                default:
                    throw new Error(`Unknown action request: ${type}`);
            }
            replyPort?.postMessage(result);
        } catch (error) {
            console.error(`[Main] Failed to process Worker request (${type}):`, error);
            replyPort?.postMessage({ success: false, error: error.message });
        }
    });
}

// Simplified polling start function
export function startPolling() {
    if (pollingScheduler) {
        // Use a Worker for polling
        workerManager.postMessage('pollingScheduler', {
            type: 'start',
            data: { interval: window.pollingInterval }
        });
    } else {
        // Fallback: use a traditional timer
        console.warn('Polling Scheduler Worker not available, using fallback timer');
        if (window.pollTimerId) {
            clearInterval(window.pollTimerId);
        }
        window.pollTimerId = setInterval(() => {
            // Simplified: fetch emails as long as the IMAP connection is healthy
            if (window.isImapConnected) {
                console.log('⏰ Traditional timer triggered, executing email fetch - poll');
                handleFetchEmailsRequest(2);
            }
        }, window.pollingInterval);
    }
}

// Simplified polling stop function
export function stopPolling() {
    if (pollingScheduler) {
        workerManager.postMessage('pollingScheduler', { type: 'stop' });
    } else if (window.pollTimerId) {
        clearInterval(window.pollTimerId);
        window.pollTimerId = null;
    }
}

// Start connection status sync
export function startStatusSync() {
    if (window.statusSyncTimer) clearInterval(window.statusSyncTimer);
    // Synchronize connection status every 10 seconds
    window.statusSyncTimer = setInterval(syncConnectionStatus, 10000);
}

// Stop connection status sync
export function stopStatusSync() {
    if (window.statusSyncTimer) {
        clearInterval(window.statusSyncTimer);
        window.statusSyncTimer = null;
    }
}

// Log in to the email account
export async function loginEmail() {
    if (!window.selectedConfig) {
        window.showStatus(window.i18n?.t('status.pleaseSelectConfigFirst') || 'Please select an email config first', 'error');
        return;
    }

    try {
        await performEmailLogin();
    } catch (error) {
        handleLoginError(error);
    }
}

// Execute the email login logic
export async function performEmailLogin() {
    showLoginLoadingStatus();

    // Create the database and folders before IMAP login to ensure the schema exists
    // This prevents the "no such table" error when loading the contact list after login
    await checkAndCreateDatabase();

    const result = await testImapConnection();
    await updateConnectionStatus(result);

    window.isUserLoggedIn = true;

    window.updateUIAfterLogin();
    window.reloadWebcoms(true);
    startPolling();

    // Start refreshing the title bar unread badge
    if (window.startTitlebarUnreadBadgeRefresh) {
        window.startTitlebarUnreadBadgeRefresh();
    }

    // Listen for contact recovery completion and refresh the contact list
    setupContactsRestoredListener();
}

/**
 * Set up the contact recovery completion listener
 * Refresh the contact list in the UI after the Worker finishes contact recovery
 */
function setupContactsRestoredListener() {
    // Remove the previous listener first to avoid duplicates
    if (window.electronAPI.offContactsRestored) {
        window.electronAPI.offContactsRestored(handleContactsRestored);
    }
    
    // Add the new listener
    window.electronAPI.onContactsRestored(handleContactsRestored);
    console.log('[IMAP Service] Contact restore completion listener set');
}

/**
 * Handle the contact recovery completion event
 * @param {Object} event - event object
 * @param {Object} data - recovery result data
 */
function handleContactsRestored(event, data) {
    console.log('[IMAP Service] Received contact restore completion event:', data);
    
    if (data && data.added > 0) {
        console.log(`[IMAP Service] Restored ${data.added} contacts, preparing to refresh UI`);
        
        // Refresh the contact list after a short delay to ensure database operations are complete
        setTimeout(() => {
            refreshContactListUI();
        }, 500);
    }
}

/**
 * Refresh the contact list in the UI
 */
function refreshContactListUI() {
    try {
        // Method 1: notify the sendmail page to refresh the contact list via postMessage
        const sendmailWebcom = document.querySelector('mailink-sender');
        if (sendmailWebcom) {
            sendmailWebcom.postMessage({
                type: 'refreshContacts'
            });
            console.log('[IMAP Service] Notified sendmail page to refresh contact list');
        }
        
        // Method 2: also call the global refresh function if the page has one
        if (window.reloadWebcoms && typeof window.reloadWebcoms === 'function') {
            window.reloadWebcoms(true);
            console.log('[IMAP Service] Called reloadWebcoms to refresh contact list');
        }
        
        // Method 3: dispatch a custom event so other components can listen
        window.dispatchEvent(new CustomEvent('contactsUpdated', {
            detail: { source: 'contactBackupRestore' }
        }));
        
    } catch (error) {
        console.error('[IMAP Service] Failed to refresh contact list:', error.message);
    }
}

// Show the login loading state
export function showLoginLoadingStatus() {
    window.showStatus(`<div class="loading"><div class="spinner"></div><p>${window.i18n?.t('status.connectingMailbox') || 'Connecting to mailbox...'}</p></div>`, 'info');
}

// Test the IMAP connection
export async function testImapConnection() {
    // Add a 15-second timeout to prevent indefinite waiting
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error('Connection timeout (15s). Please check your network or configuration.'));
        }, 15000);
    });

    return await Promise.race([
        window.electronAPI.loginImapConnection(window.selectedConfig),
        timeoutPromise
    ]);
}

// Notify all Workers to update myEmail
function notifyWorkersMyEmailUpdated(myEmail) {
    if (!myEmail) {
        console.warn('[IMAP Service] Cannot notify Workers to update myEmail: value is empty');
        return;
    }

    console.log(`[IMAP Service] Notifying all Workers to update myEmail: ${myEmail}`);

    // Notify the Email Distributor Worker
    if (emailDistributor) {
        workerManager.postMessage('emailDistributor', {
            type: 'updateMyEmail',
            myEmail: myEmail
        });
    }

    // Notify the Signaling Worker
    if (signalingWorker) {
        workerManager.postMessage('signalingWorker', {
            type: 'updateMyEmail',
            myEmail: myEmail
        });
    }
}

// Update connection status
export async function updateConnectionStatus(result) {
    window.supportsIdle = result.supportsIdle || false;
    window.isImapConnected = true;
    const myEmail = window.selectedConfig.username;
    window.currentMyEmail = myEmail;
    sessionStorage.setItem('mymail', myEmail);

    // After successful login, restore window size and show developer tools
    try {
        const loginSuccessResult = await window.electronAPI.loginSuccess();
        if (loginSuccessResult.success) {
            console.log('[Login] Window size restored, developer tools opened');
        } else {
            console.warn('[Login] Failed to restore window:', loginSuccessResult.error);
        }
    } catch (error) {
        console.error('[Login] Failed to call loginSuccess:', error);
    }

    // Update the title bar icon to the user's avatar if available
    updateTitlebarAvatar();

    // Update the system tray icon to the user's avatar if available
    updateTrayIconAvatar();

    // Initialize business Workers (after login, myEmail is available now)
    initBusinessWorkers(myEmail);

    // Notify all Workers to update myEmail
    notifyWorkersMyEmailUpdated(myEmail);

    // Notify all created MailinkChat components to update myEmail
    setTimeout(() => {
        const chatWebcoms = document.querySelectorAll('mailink-chat');
        console.log(`[updateConnectionStatus] Updating myEmail for ${chatWebcoms.length} chat components`);
        chatWebcoms.forEach(webcom => {
            if (webcom.setMyEmail && typeof webcom.setMyEmail === 'function') {
                webcom.setMyEmail(myEmail);
            }
        });
    }, 100);

    if (window.supportsIdle) {
        console.log('Server supports IDLE, using IDLE mode + low-frequency polling');
        window.pollingInterval = 6000; // Use a longer polling interval in IDLE mode (6 seconds)
        window.showStatus((window.i18n?.t('status.mailboxConnectedIdle') || 'Mailbox connected successfully! Using IDLE mode to receive emails in real time (fallback polling: {interval}s). Total emails: {total}, unread: {unread}.').replace('{interval}', window.pollingInterval / 1000).replace('{total}', result.inboxInfo.total).replace('{unread}', result.inboxInfo.unread), 'success');
    } else {
        console.log('Server does not support IDLE, using polling mode');
        window.pollingInterval = 1000; // Use a shorter polling interval in non-IDLE mode (1 second)
        window.showStatus((window.i18n?.t('status.mailboxConnectedPolling') || 'Mailbox connected successfully! Using polling mode (interval {interval}s). Total emails: {total}, unread: {unread}.').replace('{interval}', window.pollingInterval / 1000).replace('{total}', result.inboxInfo.total).replace('{unread}', result.inboxInfo.unread), 'success');
    }

    // Update the polling scheduler interval
    if (pollingScheduler) {
        pollingScheduler.postMessage({
            type: 'updateInterval',
            data: { interval: window.pollingInterval }
        });
        console.log(`🔧 Updated polling interval to: ${window.pollingInterval}ms`);
    }

    // Start connection status sync
    startStatusSync();

    // Delete signaling emails with specific prefixes from the last 2 days immediately after login
    deleteRecentSignalingEmails();

    // Warm up the SMTP connection pool for near-instant first send
    console.log('🔥 Warming up SMTP connection pool...');
    window.electronAPI.prewarmSmtp(window.selectedConfig)
        .then(res => console.log('✅ SMTP prewarm result:', res))
        .catch(err => console.warn('⚠️ SMTP prewarm failed:', err));
    
    // Notify the sendmail page to refresh the contact list
    setTimeout(() => {
        const sendmailWebcom = document.querySelector('mailink-sender');
        if (sendmailWebcom) {
            sendmailWebcom.postMessage({
                type: 'refreshContacts'
            });
            console.log(`📤 Notified sendmail page to refresh contact list`);
        }
    }, 500);
}

/**
 * Delete signaling emails with specific prefixes from the last 2 days (logic delegated to deleteQueueWorker)
 */
export async function deleteRecentSignalingEmails() {
    if (deleteQueueWorker) {
        console.log('🔄 Notifying Delete Queue Worker to start signaling cleanup...');
        workerManager.postMessage('deleteQueueWorker', { type: 'startSignalingCleanup' });
    } else {
        console.warn('⚠️ Delete Queue Worker unavailable, cannot start background cleanup');
    }
}

// Check and create the database and folders
export async function checkAndCreateDatabase() {
    try {
        // Call the main process IPC directly to create the database and folders before IMAP login
        const result = await window.electronAPI.checkAndCreateDatabase(window.selectedConfig.username);

        if (result.created) {
            console.log(`[Login] Database and folders created: ${result.filename}`);
            console.log(`[Login] User directories:`, result.directories);
        } else {
            console.log(`[Login] Database already exists: ${result.filename}`);
        }
    } catch (dbError) {
        console.error('[Login] Database creation failed:', dbError);
        // Database creation failure should not block the login flow, but the error should be logged
        window.showStatus(`${window.i18n?.t('status.dbInitFailed') || 'Database initialization failed'}: ${dbError.message}`, 'warning');
        throw dbError; // Throw the error for the login flow to handle
    }
}

// Reset database (delete and recreate)
export async function resetDatabase(emailUsername) {
    try {
        console.log(`Resetting database: ${emailUsername}`);
        const result = await sendToImapWorker('RESET_DATABASE', {
            username: emailUsername
        });

        if (result.databaseReset) {
            console.log(`Database reset: ${result.databaseName}`);
            window.showStatus(window.i18n?.t('status.dbResetSuccess') || 'Database reset successfully, please log in again', 'success');
            return true;
        } else {
            console.error('Database reset failed:', result.error);
            return false;
        }
    } catch (dbError) {
        console.error('Database reset failed:', dbError);
        window.showStatus(`${window.i18n?.t('status.dbResetFailed') || 'Database reset failed'}: ${dbError.message}`, 'error');
        return false;
    }
}

// Handle login errors
export function handleLoginError(error) {
    console.error('Email login failed:', error);
    window.showStatus(`${window.i18n?.t('status.emailLoginFailed') || 'Email login failed'}: ${error.message}`, 'error');
    window.isImapConnected = false;
    window.supportsIdle = false;
}

// Handle webcom email fetch requests
export async function handleFetchEmailsRequest(minutes, onlySignaling = false, source = 'poll') {
    // Smart shunting: automatically adjust the time range based on email type
    const adjustedMinutes = onlySignaling ? Math.min(minutes, 2) : 1440;

    console.log('🔄 Starting handleFetchEmailsRequest', {
        originalMinutes: minutes,
        adjustedMinutes: adjustedMinutes,
        onlySignaling: onlySignaling,
        emailType: onlySignaling ? 'Signaling emails (within 2 minutes)' : 'Normal emails (within 1 day)',
        source: source
    });

    // Check whether there is an ongoing fetch request
    if (window.isFetching) {
        console.warn(`⚠️ Previous email fetch not finished, skipping this ${source} request - continuous pull mode`);
        return;
    }

    // Synchronize connection status
    await syncConnectionStatus();

    // Check if configuration is valid
    console.log(`🔍 Checking config validity -${source}`);
    if (!isConfigValid()) {
        console.error(`❌ Config invalid, cannot execute email fetch -${source}`);
        sendFetchErrorToWebcom(window.i18n?.t('status.pleaseSelectConfigFirst') || 'Please select an email config first');
        return;
    }
    console.log(`✅ Config valid -${source}`);

    // Check if connection is active
    console.log(`🔍 Checking connection status -${source}`);
    if (!isConnectionActive()) {
        console.warn(`❌ Connection not active, trying reconnect via Worker -${source}`);

        try {
            // Reconnection management scheme using the IMAP Service Worker
            await sendToImapWorker('EXECUTE_IMAP_RECONNECT', {
                config: window.selectedConfig
            });
            console.log(`✅ Worker reconnect successful, continuing email fetch -${source}`);
        } catch (reconnectError) {
            console.error(`❌ Worker reconnect failed:`, reconnectError, `-${source}`);
            sendFetchErrorToWebcom(window.i18n?.t('status.connectionLostRetryFailed') || 'Connection lost and reconnect failed, please log in again');
            return;
        }
    }
    console.log(`✅ Connection active -${source}`);

    try {
        window.isFetching = true;
        const fetchStartTime = Date.now();
        console.log(`🔄 Executing email fetch request (${onlySignaling ? 'signaling' : 'normal'} emails, time range: ${adjustedMinutes} minutes) -`, source);
        const emails = await fetchEmailsFromMainProcess(adjustedMinutes, onlySignaling);
        const fetchDuration = Date.now() - fetchStartTime;
        console.log(`📥 Successfully fetched emails:`, emails.length, `-${source}, time: ${fetchDuration}ms`);
        console.log('🔄 Starting email distribution -', source);
        distributeEmails(emails, onlySignaling);
        console.log(`✅ Email fetch and distribution complete -${source}`);

        // Send processing duration to the polling scheduler for dynamic interval calculation
        if (pollingScheduler) {
            workerManager.postMessage('pollingScheduler', {
                type: 'processingTime',
                data: { duration: fetchDuration }
            });
        }
    } catch (error) {
        console.error(`❌ Email fetch failed:`, error, `-${source}`);
        handleEmailFetchError(error);
    } finally {
        window.isFetching = false;
        // Send a completion message to the polling scheduler Worker to trigger the next fetch
        if (pollingScheduler) {
            workerManager.postMessage('pollingScheduler', { type: 'fetchComplete' });
        }
    }
}

// Check whether email fetching should be skipped
export function shouldSkipEmailFetch() {
    // Stop using localStorage for connection status; check the activeConnections Map instead
    // Currently returns false, meaning email fetching is not skipped
    return false;
}

// Check if configuration is valid
export function isConfigValid() {
    return !!window.selectedConfig;
}

// Check if connection is active
export function isConnectionActive() {
    // Stricter connection status check
    return window.isImapConnected &&
        !!window.selectedConfig &&
        typeof window.electronAPI.fetchEmails === 'function';
}

// Synchronize front-end and back-end connection status
export async function syncConnectionStatus() {
    try {
        if (isConfigValid()) {
            const status = await window.electronAPI.getImapStatus(window.selectedConfig.username);
            const oldStatus = window.isImapConnected;
            window.isImapConnected = status && status.connected;

            if (oldStatus !== window.isImapConnected) {
                console.log(`🔄 Connection status changed: ${oldStatus} → ${window.isImapConnected}`);
                // Notify all related components of status changes
                notifyConnectionStatusChange(window.isImapConnected);

                // [P1 Opt - Plan 4] Do not pause polling on disconnect; try reconnecting instead
                // Rationale: high-frequency IMAP polling is more needed during WebRTC reconnection to receive signaling emails
                // Pausing polling causes long receive gaps (115 seconds without emails observed in logs)
                if (!window.isImapConnected) {
                    console.log(`⚠️ [P1 Opt] IMAP connection disconnected, trying auto-reconnect (without pausing polling)...`);
                    // Try to reconnect IMAP automatically
                    try {
                        if (window.electronAPI && window.selectedConfig) {
                            await window.electronAPI.loginImapConnection(window.selectedConfig);
                            window.isImapConnected = true;
                            console.log('✅ IMAP auto-reconnect successful');
                            notifyConnectionStatusChange(true);
                        }
                    } catch (reconnectErr) {
                        console.error('❌ IMAP auto-reconnect failed:', reconnectErr);
                        // Even if reconnection fails, do not pause polling; retry on the next poll
                        if (pollingScheduler) {
                            console.log('ℹ️ Keeping polling running, waiting for next retry...');
                        }
                    }
                } else if (window.isImapConnected && pollingScheduler) {
                    // Ensure polling is running when the connection recovers
                    console.log(`▶️  Connection restored, ensuring polling runs`);
                    workerManager.postMessage('pollingScheduler', { type: 'resume' });
                }
            }

            console.log(`🔄 Connection status sync successful, current @:  ${window.isImapConnected}`);
        }
    } catch (error) {
        console.error('❌ Failed to sync connection status:', error);
        const oldStatus = window.isImapConnected;
        window.isImapConnected = false;

        if (oldStatus !== window.isImapConnected) {
            console.log(`🔄 Connection status changed: ${oldStatus} → ${window.isImapConnected}`);
            notifyConnectionStatusChange(window.isImapConnected);

            // [P1 Opt - Plan 4] Do not pause polling on exceptions either
            console.log(`⚠️ [P1 Opt] Connection status sync exception, keeping polling running for retry`);
        }
    }
}


// Fetch emails from the main process (continuous pull mode)
export async function fetchEmailsFromMainProcess(minutes, onlySignaling, retryCount = 0) {
    const maxRetries = 3;
    const baseDelay = 1000;
    
    console.log('📤 Calling window.electronAPI.fetchEmails, minutes:', minutes, 'onlySignaling:', onlySignaling, `retryCount: ${retryCount}`);

    if (!window.selectedConfig) {
        console.error('❌ Cannot get current email config, skipping email fetch');
        return [];
    }

    // Set timeout based on email type: 30s for signaling emails, 2min for normal emails
    const timeoutMs = onlySignaling ? 30000 : 120000;

    try {
        // Add timeout handling with Promise.race
        const result = await Promise.race([
            window.electronAPI.fetchEmails(window.selectedConfig, minutes, onlySignaling),
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`window.electronAPI.fetchEmails call timed out (${timeoutMs}ms)`));
                }, timeoutMs);
            })
        ]);

        const emails = Array.isArray(result) ? result : [];
        console.log('📥 window.electronAPI.fetchEmails returned successfully, total:', emails.length, 'emails');
        return emails;
    } catch (error) {
        console.error('❌ window.electronAPI.fetchEmails call failed:', error);

        // If a failure caused by connection issues is detected, mark as disconnected; the next poll will auto-trigger Worker reconnection
        if (error.message.includes('timed out') || error.message.includes('disconnected') ||
            error.message.includes('connection lost') || error.message.includes('authentication')) {
            window.isImapConnected = false;
            notifyConnectionStatusChange(false);
        }

        // Worker crash error; retry with exponential backoff
        if ((error.message.includes('Worker exited with code 1') || 
             error.message.includes('exit code 1') ||
             error.message.includes('Worker crashed') ||
             error.message.includes('Worker')) && 
            retryCount < maxRetries) {
            const delay = baseDelay * Math.pow(2, retryCount);
            console.log(`⚠️ Worker exception, retry ${retryCount + 1}/${maxRetries} after ${delay}ms...`);
            
            // Try to trigger Worker recovery
            handleWorkerCrash();
            
            // Retry after waiting
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Resynchronize connection status
            await syncConnectionStatus();
            
            // Retry recursively
            return fetchEmailsFromMainProcess(minutes, onlySignaling, retryCount + 1);
        }

        throw error;
    }
}

// Distribute emails
export function distributeEmails(emails, onlySignaling) {
    if (!Array.isArray(emails)) {
        console.warn('❌ distributeEmails received invalid emails:', emails);
        return;
    }

    const myEmail = window.selectedConfig?.username;

    // Use the Email Distributor Worker to handle email distribution
    if (emailDistributor) {
        workerManager.postMessage('emailDistributor', {
            type: 'distributeEmails',
            emails: emails,
            myEmail: myEmail
        });
    } else {
        // Fallback: distribute directly if the Worker fails to initialize
        console.warn('Email Distributor Worker not available, using fallback');
        sendEmailsToWebcom(emails);
        processSignalingEmails(emails);
    }
}

// Handle signaling emails
export function processSignalingEmails(emails) {
    const myEmail = window.selectedConfig?.username;
    if (signalingWorker) {
        workerManager.postMessage('signalingWorker', {
            type: 'processEmails',
            emails: emails,
            myEmail: myEmail,
            activeConnections: Array.from(window.activeConnections.entries())
        });
    }
}

// Handle email fetch errors
export function handleEmailFetchError(error) {
    console.error('Email fetch failed:', error);
    
    // Detect Worker crash errors
    if (error.message.includes('Worker exited with code 1') || 
        error.message.includes('exit code 1') ||
        error.message.includes('Worker crashed')) {
        console.error('Worker crash detected, attempting recovery...');
        handleWorkerCrash();
    }
    
    // Detect connection-related errors
    if (error.message.includes('timed out') || 
        error.message.includes('disconnected') ||
        error.message.includes('connection lost') || 
        error.message.includes('authentication') ||
        error.message.includes('connection')) {
        console.warn('Connection error detected, marking as disconnected');
        window.isImapConnected = false;
    }
    
    sendFetchErrorToWebcom(error.message);
}

// Handle Worker crashes
let workerCrashRecoveryInProgress = false;
export function handleWorkerCrash() {
    if (workerCrashRecoveryInProgress) {
        console.warn('Worker crash recovery already in progress, skipping duplicate recovery request');
        return;
    }
    
    workerCrashRecoveryInProgress = true;
    console.log('🔄 Starting Worker crash recovery process...');
    
    // 1. Mark the connection as disconnected
    window.isImapConnected = false;
    
    // 2. Ask the Worker system to restart the IMAP Worker
    if (window.workerManager) {
        console.log('🔄 Notifying Worker system to restart IMAP Worker...');
        window.workerManager.postMessage('imapServiceWorker', { type: 'RESTART' });
    }
    
    // 3. Try to re-establish the IMAP connection
    setTimeout(async () => {
        if (window.electronAPI && window.selectedConfig) {
            try {
                console.log('🔄 Attempting to re-establish IMAP connection...');
                await window.electronAPI.loginImapConnection(window.selectedConfig);
                console.log('✅ IMAP connection rebuilt successfully');
            } catch (reconnectError) {
                console.error('❌ IMAP connection rebuild failed:', reconnectError);
            }
        }
        
        workerCrashRecoveryInProgress = false;
        console.log('✅ Worker crash recovery process complete');
    }, 2000);
}

// Handle requests to delete emails from specified senders with subject prefixes
export async function handleDeleteEmailsBySenderAndSubject(sender, subjectPrefix, immediate = false, options = {}) {
    if (!window.selectedConfig) {
        console.error('Cannot get current email config');
        return;
    }

    if (!window.isImapConnected) {
        console.error('Mailbox not connected');
        return;
    }

    // Use Delete Queue Worker to process delete requests
    if (deleteQueueWorker) {
        if (immediate) {
            setTimeout(() => {
                // Delete immediately：Do not wait for merge，Execute directly
                /*workerManager.postMessage('deleteQueueWorker', {
                    type: 'immediateDelete',
                    sender: sender,
                    subjectPrefix: subjectPrefix,
                    options: options
                });*/
            }, 1000 * 60);
        } else {
            // Normal delete: add to queue and wait for merging
            workerManager.postMessage('deleteQueueWorker', {
                type: 'queueDelete',
                sender: sender,
                subjectPrefix: subjectPrefix,
                options: options
            });
        }
    } else {
        // Fallback: delete directly (if Worker initialization fails)
        console.warn('Delete Queue Worker not available, using fallback');
        try {
            const result = await window.electronAPI.searchAndDeleteEmails(window.selectedConfig, sender, subjectPrefix, options);
            console.log(sender + '@' + subjectPrefix + ': email deletion result:', result);
        } catch (error) {
            console.error('Failed to delete emails:', error);
        }
    }
}

// Handle requests to delete emails by UID
export async function handleDeleteEmailsByUid(emailUids, immediate = false) {
    if (!window.selectedConfig) {
        console.error('Cannot get current email config');
        return;
    }

    if (!window.isImapConnected) {
        console.error('Mailbox not connected');
        return;
    }

    // Use Delete Queue Worker to process delete requests
    if (deleteQueueWorker) {
        if (immediate) {
            setTimeout(() => {
                // Delete immediately: do not wait for batching, execute directly
                console.log('Immediate delete by UID scheduled for:', emailUids.length, 'emails');
            }, 1000 * 60);
        } else {
            // Normal delete: add to queue and wait for merging
            console.log('Queue delete by UID for:', emailUids.length, 'emails');
        }
    } else {
        // Fallback: delete directly (if Worker initialization fails)
        console.warn('Delete Queue Worker not available, using fallback for UID deletion');
        try {
            const result = await window.electronAPI.deleteEmailsByUid(window.selectedConfig, emailUids);
            console.log('Email deletion result (UID):', result);
        } catch (error) {
            console.error('Failed to delete emails by UID:', error);
        }
    }
}

// Provide a method to dynamically change the polling interval
export function setPollingInterval(newInterval) {
    // Update the interval value
    window.pollingInterval = newInterval;

    // Stop the current polling
    stopPolling();

    // Restart polling with the new interval
    startPolling();

    console.log(`Polling interval updated to ${newInterval}ms`);
}
