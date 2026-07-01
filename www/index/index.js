// Main entry file - integrate all modular components

// Import modular components
import { initApp } from './app-init.js';
import { startPolling, stopPolling, startStatusSync, stopStatusSync, loginEmail, handleFetchEmailsRequest, handleDeleteEmailsBySenderAndSubject, handleDeleteEmailsByUid, setPollingInterval, isConnectionActive } from '../services/imap-service.js';
import { activateChatWebcom, createChatWebcom, checkAndAttemptWebRTCReset, handleWorkerAction, checkAndAddContact } from '../webrtc/manager.js';
import { renderConfigs, updateAvatar, toggleConfigForm, fillConfigForm, autoFillConfig, resetConfigForm, saveEmailConfig, handleAvatarUpload } from '../services/config-manager.js';
import { showStatus, clearStatus, updateUIAfterLogin, reloadWebcoms, notifyConnectionStatusChange, updateContactAvatar, handleShowConfigSelectionPrompt } from './ui-manager.js';
import { sendMessageToWebcomWithRetry } from '../utils/index.js';
import { initCoreWorkers, workerManager, stopBusinessWorkers } from '../services/worker-system.js';
import { getMyEmail } from '../utils/common.js';
import { playDoubleTone, playNotificationBeep } from '../utils/notification-sound.js';

// ========== Global state variables ==========

// Currently selected config
window.selectedConfig = null;
// IMAP connection status
window.isImapConnected = false;
// IDLE support status
window.supportsIdle = false;
// Whether in edit mode
window.isModifyMode = false;
// Currently edited config ID
window.currentModifyConfigId = null;
// Currently active chat webcom
window.activeChatWebcom = null;
// Active data channel connections (email -> status)
window.activeConnections = new Map();
// Store last email time for each contact (email -> timestamp)
window.lastEmailTimes = new Map();
// Store last load time for each webcom (email -> timestamp)
window.webcomLastLoadTimes = new Map();

// Reconnect cooldown record (timestamp)
window.lastReconnectTime = 0;
// Minimum reconnect interval (ms)
window.minReconnectInterval = 5000; // 5 seconds

// Email fetch concurrency lock
window.isFetching = false;

// Whether the user is logged in (used to control component loading)
window.isUserLoggedIn = false;

// Email polling interval (ms)
window.pollingInterval = 6000; // Default 6 seconds
// Polling timer ID (used in fallback mode)
window.pollTimerId = null;
// Connection status sync timer ID
window.statusSyncTimer = null;

// Web Workers references
window.emailDistributor = null;
window.deleteQueueWorker = null;
window.pollingScheduler = null;
window.signalingWorker = null;

// ========== Global utility references ==========
window.workerManager = workerManager;
window.stopBusinessWorkers = stopBusinessWorkers;

// ========== Expose functions to window object ==========

// Core feature functions
window.startPolling = startPolling;
window.stopPolling = stopPolling;
window.startStatusSync = startStatusSync;
window.stopStatusSync = stopStatusSync;
window.loginEmail = loginEmail;
window.handleFetchEmailsRequest = handleFetchEmailsRequest;
window.handleDeleteEmailsBySenderAndSubject = handleDeleteEmailsBySenderAndSubject;
window.handleDeleteEmailsByUid = handleDeleteEmailsByUid;
window.setPollingInterval = setPollingInterval;
window.isConnectionActive = isConnectionActive;

// WebRTC-related functions
window.activateChatWebcom = activateChatWebcom;
window.createChatWebcom = createChatWebcom;
window.checkAndAttemptWebRTCReset = checkAndAttemptWebRTCReset;
window.handleWorkerAction = handleWorkerAction;
window.checkAndAddContact = checkAndAddContact;

// Config management functions
window.renderConfigs = renderConfigs;
window.updateAvatar = updateAvatar;
window.toggleConfigForm = toggleConfigForm;
window.fillConfigForm = fillConfigForm;
window.autoFillConfig = autoFillConfig;
window.resetConfigForm = resetConfigForm;
window.saveEmailConfig = saveEmailConfig;
window.handleAvatarUpload = handleAvatarUpload;

// UI management functions
window.showStatus = showStatus;
window.clearStatus = clearStatus;
window.updateUIAfterLogin = updateUIAfterLogin;
window.reloadWebcoms = reloadWebcoms;
window.notifyConnectionStatusChange = notifyConnectionStatusChange;
window.updateContactAvatar = updateContactAvatar;
window.handleShowConfigSelectionPrompt = handleShowConfigSelectionPrompt;

// WebRTC signaling handling functions
window.handleWebRTCSignal = (data) => {
    const targetEmail = data.data?.from || data.sender;
    const webcomId = `chat_${targetEmail}`;
    let chatWebcom = document.getElementById(webcomId);

    if (!chatWebcom) {
        const myEmail = getMyEmail();
        chatWebcom = window.createChatWebcom(targetEmail, false, myEmail);
    }

    if (typeof chatWebcom?.sendSignal === 'function') {
        chatWebcom.sendSignal(data.event, data.data);
    } else {
        console.error('[debug] chatWebcom Does not exist or sendSignal not a function:', chatWebcom);
    }
};

// Utility functions
window.sendMessageToWebcomWithRetry = sendMessageToWebcomWithRetry;

// Get currently selected config (for webcom page use)
function getSelectedConfig() {
    return window.selectedConfig;
}

// Expose functions to window object for webcom page calls
window.getSelectedConfig = getSelectedConfig;

// ========== Initialize app ==========

// Initialize core Web Workers (IMAP service worker only, needed before login)
initCoreWorkers();

// Initialize application
initApp();

// ========== Title bar unread badge management ==========
let _unreadBadgeTimer = null;
const _unreadBadgeRefreshInterval = 30000; // Refresh every 30 seconds

/**
 * Render the title bar unread count red dot
 */
function renderTitlebarUnreadBadge(count) {
    const badge = document.getElementById('titlebar-unread-badge');
    if (!badge) return;

    if (count <= 0) {
        badge.style.display = 'none';
        badge.textContent = '0';
    } else {
        badge.style.display = 'flex';
        badge.textContent = count > 99 ? '99+' : count.toString();
    }
}

/**
 * Hide the title bar unread count red dot
 */
function hideTitlebarUnreadBadge() {
    const badge = document.getElementById('titlebar-unread-badge');
    if (badge) {
        badge.style.display = 'none';
        badge.textContent = '0';
    }
}

/**
 * Update the title bar unread email count
 */
async function updateTitlebarUnreadBadge() {
    try {
        const myEmail = getMyEmail();
        if (!myEmail) {
            hideTitlebarUnreadBadge();
            return;
        }

        // Get unread email count from the recv table (total unread new emails across all contacts)
        let unreadCount = 0;
        const api = window.electronAPI;
        if (api && api.getRecvUnreadCount) {
            const result = await api.getRecvUnreadCount({ myEmail });
            unreadCount = result?.total || 0;
        }

        renderTitlebarUnreadBadge(unreadCount);
    } catch (error) {
        console.error('[TitlebarBadge] Failed to get unread email count:', error);
    }
}

/**
 * Start scheduled refresh of title bar unread count
 */
function startTitlebarUnreadBadgeRefresh() {
    // Clear existing timer
    stopTitlebarUnreadBadgeRefresh();

    // Refresh immediately once
    updateTitlebarUnreadBadge();

    // Set scheduled refresh
    _unreadBadgeTimer = setInterval(() => {
        updateTitlebarUnreadBadge();
    }, _unreadBadgeRefreshInterval);

    console.log('[TitlebarBadge] Unread count scheduled refresh started');
}

/**
 * Stop scheduled refresh of title bar unread count
 */
function stopTitlebarUnreadBadgeRefresh() {
    if (_unreadBadgeTimer) {
        clearInterval(_unreadBadgeTimer);
        _unreadBadgeTimer = null;
        console.log('[TitlebarBadge] Unread count auto-refresh stopped');
    }
}

// Expose to window object
window.renderTitlebarUnreadBadge = renderTitlebarUnreadBadge;
window.updateTitlebarUnreadBadge = updateTitlebarUnreadBadge;
window.startTitlebarUnreadBadgeRefresh = startTitlebarUnreadBadgeRefresh;
window.stopTitlebarUnreadBadgeRefresh = stopTitlebarUnreadBadgeRefresh;

// ========== Custom title bar controls ==========
function initChatMessageNotifications() {
    /**
     * Handle new chat message notification
     * Triggers: red badge update, tray flashing, voice prompt
     */
    if (window.electronAPI && typeof window.electronAPI.onNewChatMessages === 'function') {
        window.electronAPI.onNewChatMessages(async (event, data) => {
            try {
                console.log('[ChatMessage] Received new chat message notification:', data);
                
                const { username, newCount, senders, timestamp } = data;
                
                // 1. Update title bar red badge immediately (query real unread total from database to avoid overriding accumulated count)
                if (newCount > 0) {
                    console.log(`[ChatMessage] received ${newCount} new messages，Refresh badge`);
                    updateTitlebarUnreadBadge();
                }
                
                // 2. Trigger tray flashing (consistent with WebRTC new messages)
                if (window.electronAPI && typeof window.electronAPI.startTrayFlash === 'function') {
                    try {
                        window.electronAPI.startTrayFlash();
                        console.log('[ChatMessage] Tray flash triggered');
                    } catch (error) {
                        console.warn('[ChatMessage] Tray flash failed:', error.message);
                    }
                }
                
                // 3. Play notification sound (reuse the same WebRTC new.mp3)
                try {
                    const port = window.httpServerPort || (window.electronAPI?.getHttpServerPort ? (await window.electronAPI.getHttpServerPort()).port : 8080);
                    const audio = new Audio(`http://127.0.0.1:${port}/assets/new.mp3`);
                    audio.play().catch(err => {
                        console.warn('[ChatMessage] Play new.mp3 failed，Fallback to synthetic audio:', err);
                        playDoubleTone();
                    });
                } catch (error) {
                    console.warn('[ChatMessage] Notification sound playback failed:', error.message);
                    playDoubleTone();
                }
                
                // 4. Update contact list (reuse WebRTC new message event chain)
                //    Event flow: window event → app-init.js → mailink-sender → contact-list
                //    Identical to WebRTC's chat-message.js → manager.js → window → app-init.js
                if (senders && senders.length > 0) {
                    try {
                        for (const sender of senders) {
                            // Update contact last message (consistent with update-contact-last-message in WebRTC _notifyUnreadIncrement)
                            window.dispatchEvent(new CustomEvent('update-contact-last-message', {
                                detail: { email: sender }
                            }));
                            // Increase contact unread count, passing the number of messages from this sender
                            const senderCount = (data.senderCounts && data.senderCounts[sender]) || 1;
                            window.dispatchEvent(new CustomEvent('increment-unread-count', {
                                detail: { email: sender, count: senderCount }
                            }));
                        }
                        console.log(`[ChatMessage] Notified ${senders.length} contacts updated: ${senders.join(', ')}`);
                        
                        // Refresh contact list (ensure new contacts are displayed and the red badge updates correctly)
                        document.dispatchEvent(new CustomEvent('refreshContacts'));
                    } catch (error) {
                        console.warn('[ChatMessage] Failed to refresh contact list:', error.message);
                    }
                }

                // 5. If the contact corresponding to the current chat window has new messages, refresh the chat history
                //    WebRTC new messages call displayMessage directly without refresh, but email messages need to be reloaded from DB
                if (senders && senders.length > 0 && window.activeChatWebcom) {
                    try {
                        const activeEmail = window.activeChatWebcom.getAttribute('contact-email')
                            || window.activeChatWebcom.id?.replace('chat_', '');
                        if (activeEmail && senders.some(s => s.trim().toLowerCase() === activeEmail.trim().toLowerCase())) {
                            if (typeof window.activeChatWebcom.loadHistoryMessages === 'function') {
                                window.activeChatWebcom.loadHistoryMessages(activeEmail);
                                console.log(`[ChatMessage] Chat window refreshed: ${activeEmail}`);
                            }
                        }
                    } catch (error) {
                        console.warn('[ChatMessage] Failed to refresh chat window:', error.message);
                    }
                }
                
                // 6. Trigger custom event for other modules to listen
                window.dispatchEvent(new CustomEvent('chatMessagesReceived', {
                    detail: { username, newCount, senders, timestamp }
                }));
                
            } catch (error) {
                console.error('[ChatMessage] Exception handling chat message notification:', error);
            }
        });
        
        console.log('[ChatMessage] Chat message notification listener initialized');
    }
    
    // Listen for chat message content updates (e.g., after mailink_picture image download completes)
    if (window.electronAPI && typeof window.electronAPI.onChatMessageContentUpdated === 'function') {
        window.electronAPI.onChatMessageContentUpdated(async (event, data) => {
            try {
                const { username, msgid, content } = data;
                console.log(`[ChatMessage] Received message content update: msgid=${msgid}`);

                // If the current chat window is showing this message, update the display
                if (window.activeChatWebcom) {
                    try {
                        const chatComponent = window.activeChatWebcom;
                        // Find message element and update content
                        const msgContainer = chatComponent.shadowRoot?.querySelector(`[data-msg-id="${msgid}"]`) ||
                                            chatComponent.shadowRoot?.querySelector(`#msg-container-${msgid}`);
                        if (msgContainer) {
                            // [FIX] Find and update the .message-text element, not .message-content
                            // .message-content is a flex container and affects internal layout
                            const msgText = msgContainer.querySelector('.message-text');
                            if (msgText) {
                                msgText.innerHTML = content;
                                console.log(`[ChatMessage] Message content updated: msgid=${msgid}`);
                            } else {
                                // Fallback: if no .message-text, update .message-content
                                const contentEl = msgContainer.querySelector('.message-content') || msgContainer;
                                if (contentEl) {
                                    contentEl.innerHTML = content;
                                    console.log(`[ChatMessage] Message content updated(Degraded): msgid=${msgid}`);
                                }
                            }

                            // [New] Check if it is an email image message update; if so, bind image load complete event
                            const emailImageMessage = msgContainer.querySelector('.email-image-message');
                            if (emailImageMessage) {
                                const emailEmid = emailImageMessage.dataset.emid;
                                const emailSubjectLine = emailImageMessage.querySelector('.email-subject-line');
                                
                                if (emailEmid && emailSubjectLine) {
                                    // Check if currently unread (blue)
                                    const isUnread = emailSubjectLine.classList.contains('email-msg-unread') ||
                                                    emailSubjectLine.style.color === 'rgb(24, 144, 255)' ||
                                                    emailSubjectLine.style.color === '#1890ff';
                                    
                                    if (isUnread) {
                                        const emailImage = emailImageMessage.querySelector('img');
                                        if (emailImage) {
                                            console.log(`[ChatMessage] Bind email image load event after message content update: msgid=${msgid}, emid=${emailEmid}`);
                                            
                                            const onImageLoad = () => {
                                                console.log(`[ChatMessage] Email image loaded, Auto mark as read: emid=${emailEmid}`);
                                                
                                                // Update UI style
                                                emailSubjectLine.style.color = '#333';
                                                emailSubjectLine.classList.remove('email-msg-unread');
                                                emailSubjectLine.classList.add('email-msg-read');
                                                
                                                // Trigger mark as read (via chatComponent's uiRenderer method)
                                                if (chatComponent.uiRenderer && chatComponent.uiRenderer._markEmailMessageRead) {
                                                    chatComponent.uiRenderer._markEmailMessageRead(emailEmid);
                                                }
                                            };
                                            
                                            // Check if image has finished loading
                                            if (emailImage.complete && emailImage.naturalWidth > 0) {
                                                console.log(`[ChatMessage] Email image already loaded, mark as read immediately: emid=${emailEmid}`);
                                                onImageLoad();
                                            } else {
                                                emailImage.addEventListener('load', onImageLoad, { once: true });
                                                emailImage.addEventListener('error', () => {
                                                    console.log(`[ChatMessage] Email image load failed, Still marked as read: emid=${emailEmid}`);
                                                    onImageLoad();
                                                }, { once: true });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.warn(`[ChatMessage] Failed to update message display: ${error.message}`);
                    }
                }
            } catch (error) {
                console.error('[ChatMessage] Exception handling message content update:', error);
            }
        });

        console.log('[ChatMessage] Message content update listener initialized');
    }
}

function initCustomTitlebar() {
    const minimizeBtn = document.querySelector('.titlebar-btn.minimize');
    const maximizeBtn = document.querySelector('.titlebar-btn.maximize');
    const closeBtn = document.querySelector('.titlebar-btn.close');
    const logoutBtn = document.querySelector('.titlebar-btn.logout');
    const debugBtn = document.querySelector('.titlebar-btn.debug');

    console.log('[Titlebar] Button lookup result:', {
        minimize: !!minimizeBtn,
        maximize: !!maximizeBtn,
        close: !!closeBtn,
        logout: !!logoutBtn,
        debug: !!debugBtn,
        electronAPI: !!window.electronAPI,
        windowControl: !!window.electronAPI?.windowControl
    });

    minimizeBtn?.addEventListener('click', () => {
        console.log('[Titlebar] Minimize button clicked');
        window.electronAPI?.windowControl('minimize');
    });

    maximizeBtn?.addEventListener('click', () => {
        console.log('[Titlebar] Maximize button clicked');
        window.electronAPI?.windowControl('maximize');
    });

    closeBtn?.addEventListener('click', () => {
        console.log('[Titlebar] Close button clicked');
        window.electronAPI?.windowControl('close');
    });

    debugBtn?.addEventListener('click', () => {
        console.log('[Titlebar] Debug button clicked');
        if (window.electronAPI?.toggleDevTools) {
            window.electronAPI.toggleDevTools();
        } else {
            console.warn('toggleDevTools API not available');
        }
    });

    logoutBtn?.addEventListener('click', async () => {
        const logoutConfirmMsg = window.i18n?.t ? window.i18n.t('dialog.logoutConfirm') : 'Are you sure you want to log out？';
        if (confirm(logoutConfirmMsg)) {
            try {
                // Disconnect IMAP first to proactively notify the server to release resources
                if (window.selectedConfig && window.electronAPI?.disconnectImap) {
                    console.log('Disconnecting IMAP connection...');
                    await window.electronAPI.disconnectImap(window.selectedConfig);
                    console.log('IMAP connection disconnected');
                }
            } catch (error) {
                console.warn('Failed to disconnect IMAP:', error.message);
                // Continue logout process，Does not affect logout
            }

            // Reset tray icon to default
            try {
                if (window.electronAPI?.resetTrayIconToDefault) {
                    await window.electronAPI.resetTrayIconToDefault();
                    console.log('Tray icon reset to default');
                }
            } catch (error) {
                console.warn('Failed to reset tray icon:', error.message);
            }

            // Stop business workers
            if (window.stopBusinessWorkers) {
                window.stopBusinessWorkers();
            }

            // Stop badge refresh
            stopTitlebarUnreadBadgeRefresh();

            // Clear login state
            sessionStorage.removeItem('mymail');
            localStorage.removeItem('config');

            // Refresh page
            window.location.reload();
        }
    });

    // Double-click title bar to maximize/restore
    const dragRegion = document.querySelector('.titlebar-drag-region');
    dragRegion?.addEventListener('dblclick', () => {
        window.electronAPI?.windowControl('maximize');
    });

    // Cache current NAT type for update on language switch
    let currentNatType = null;

    // Listen to NAT type detection event and update title bar display
    window.addEventListener('nat-type-detected', (event) => {
        const natType = event.detail?.natType;
        const titlebarNat = document.getElementById('titlebarNat');
        if (titlebarNat && natType && natType !== window.i18n?.t('chat.unknownNat')) {
            currentNatType = natType;
            titlebarNat.textContent = `🔀 ${natType}`;
        }
    });

    // Listen to language switch event and update NAT type display
    window.addEventListener('lang-changed', () => {
        if (currentNatType) {
            const titlebarNat = document.getElementById('titlebarNat');
            if (titlebarNat) {
                const unknownText = window.i18n?.t('chat.unknownNat') || 'Unknown';
                if (currentNatType !== unknownText) {
                    titlebarNat.textContent = `🔀 ${currentNatType}`;
                }
            }
        }
    });

    // Listen to unread count update event (from inbox panel)
    window.addEventListener('recvUnreadCountUpdated', (e) => {
        const myEmail = getMyEmail();
        if (e.detail && e.detail.myEmail === myEmail) {
            renderTitlebarUnreadBadge(e.detail.unreadCount);
        }
    });

    // Listen to recv table email update event (from mailsender)
    window.addEventListener('recvEmailsUpdated', (e) => {
        const myEmail = getMyEmail();
        if (e.detail && e.detail.username === myEmail) {
            // Update badge immediately
            updateTitlebarUnreadBadge();
        }
    });

    // Click badge to open inbox panel - use event delegation
    document.addEventListener('click', (e) => {
        const badge = e.target.closest('#titlebar-unread-badge');
        if (badge && badge.style.display !== 'none') {
            e.stopPropagation();
            e.preventDefault();
            console.log('📬 Badge clicked，Open inbox panel');
            const inboxPanel = document.getElementById('inboxPanel');
            if (inboxPanel) {
                // If panel is minimized, restore first
                if (inboxPanel._isMinimized) {
                    inboxPanel._restorePosition();
                    inboxPanel._isMinimized = false;
                    const panel = inboxPanel._shadow?.querySelector('.inbox-panel');
                    if (panel) {
                        panel.classList.remove('minimized');
                    }
                }
                if (typeof inboxPanel.show === 'function') {
                    inboxPanel.show();
                }
            }
        }
    });

    // Set badge style (even if not currently shown)
    const titlebarBadge = document.getElementById('titlebar-unread-badge');
    if (titlebarBadge) {
        titlebarBadge.style.cursor = 'pointer';
        titlebarBadge.title = window.i18n?.t ? window.i18n.t('titlebar.viewInbox') : 'Click to view inbox';
    }
}

function safeInitTitlebar() {
    try {
        console.log('[Titlebar] Start initializing custom titlebar, readyState:', document.readyState);
        initCustomTitlebar();
        initChatMessageNotifications();
        console.log('[Titlebar] Custom titlebar initialization completed');
    } catch (error) {
        console.error('[Titlebar] Custom titlebar initialization failed:', error);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInitTitlebar);
} else {
    safeInitTitlebar();
}
