// Apply initialization module
import { startPolling, handleFetchEmailsRequest, loginEmail } from '../services/imap-service.js';
import { createChatWebcom, activateChatWebcom, checkAndAttemptWebRTCReset } from '../webrtc/manager.js';
import { renderConfigs, toggleConfigForm, fillConfigForm, autoFillConfig, resetConfigForm, saveEmailConfig, updateAvatar } from '../services/config-manager.js';
import { showStatus, updateUIAfterLogin, reloadWebcoms, updateContactAvatar, handleShowConfigSelectionPrompt, setupMailrecverCallbacks } from './ui-manager.js';
import { sendMessageToWebcomWithRetry, getMyEmail } from '../utils/index.js';
import { workerManager } from '../services/worker-system.js';

// Helper function: get current user's email (using unified utility function)
function getMyEmailLocal() {
    return getMyEmail();
}

// Execute after page load
export function initApp() {
    const initCallback = async () => {
        try {
            await initializeApp();
        } catch (error) {
            handleInitializationError(error);
        }

        try {
            await loadAndRenderConfigs();
        } catch (error) {
            console.error('[AppInit] Failed to load config list:', error);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCallback);
    } else {
        initCallback();
    }
}

// Initialize application
async function initializeApp() {
    // Thoroughly clear all login states to prevent auto-login on app startup
    // Delete known keys directly to avoid iterating all storage
    const sessionKeysToRemove = ['mymail', 'lastContact'];
    const localKeysToRemove = ['mymail'];
    
    // Clear known login-related keys from sessionStorage
    sessionKeysToRemove.forEach(key => {
        try {
            sessionStorage.removeItem(key);
        } catch (e) {
            // Ignore error
        }
    });
    
    // Clear known login-related keys from localStorage
    localKeysToRemove.forEach(key => {
        try {
            localStorage.removeItem(key);
        } catch (e) {
            // Ignore error
        }
    });
    
    // Use requestIdleCallback to clean up other possible related keys when idle
    const scheduleCleanup = (typeof window !== 'undefined' && window.requestIdleCallback) 
        ? window.requestIdleCallback 
        : (cb) => setTimeout(cb, 100);
    
    scheduleCleanup(() => {
        try {
            // Clean up keys starting with mymail_ in sessionStorage
            for (let i = sessionStorage.length - 1; i >= 0; i--) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith('mymail_')) {
                    sessionStorage.removeItem(key);
                }
            }
            
            // Clean up keys starting with mymail_ in localStorage
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key && key.startsWith('mymail_')) {
                    localStorage.removeItem(key);
                }
            }
        } catch (e) {
            console.warn('Failed to clean storage:', e);
        }
    });
    
    // Reset global variables
    window.selectedConfig = null;
    window.isImapConnected = false;
    window.isUserLoggedIn = false;
    window.currentMyEmail = null;
    console.log('✅ Previous login state thoroughly cleared');

    // Initialize title bar icons
    await initializeTitlebarIcon();

    bindButtonEvents();
    bindEmailTypeEvents();
    bindUsernameInputEvent();
    bindWindowMessageListener();
    bindMailinkSenderEvents();
    bindMailinkRecverEvents();
    initLangSelect();
}

// Load and render configuration
async function loadAndRenderConfigs() {
    const emailConfigs = await window.electronAPI.loadEmailConfigsFromDB();
    window.renderConfigs(emailConfigs);
}

// Initialize title bar icons
async function initializeTitlebarIcon() {
    try {
        // Get the HTTP server port
        let port = window.httpServerPort;
        if (!port && window.electronAPI?.getHttpServerPort) {
            const result = await window.electronAPI.getHttpServerPort();
            port = result?.port || 8080;
        }
        port = port || 8080;

        // Set icon path - use the correct /assets/ path
        const titlebarIcon = document.getElementById('titlebarIcon');
        if (titlebarIcon) {
            titlebarIcon.src = `http://127.0.0.1:${port}/assets/icon.ico`;
            titlebarIcon.style.display = 'block';
            console.log('[Titlebar] Icon loaded:', titlebarIcon.src);
        }
    } catch (error) {
        console.error('[Titlebar] Failed to load icon:', error);
        // Hide the icon if loading fails
        const titlebarIcon = document.getElementById('titlebarIcon');
        if (titlebarIcon) {
            titlebarIcon.style.display = 'none';
        }
    }
}

// Bind button events
function bindButtonEvents() {
    const loginBtn = document.getElementById('loginBtn');
    const addConfigBtn = document.getElementById('addConfigBtn');
    const editConfigBtn = document.getElementById('editConfigBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const emailConfigForm = document.getElementById('emailConfigForm');

    loginBtn.addEventListener('click', window.loginEmail);
    addConfigBtn.addEventListener('click', handleAddConfigClick);
    if (editConfigBtn) {
        editConfigBtn.addEventListener('click', handleEditConfigClick);
    }
    cancelBtn.addEventListener('click', window.resetConfigForm);
    emailConfigForm.addEventListener('submit', window.saveEmailConfig);

    // Bind avatar upload event
    const avatarPreview = document.getElementById('avatar-preview');
    const avatarUpload = document.getElementById('avatar-upload');
    if (avatarPreview && avatarUpload) {
        avatarPreview.addEventListener('click', () => avatarUpload.click());
        avatarUpload.addEventListener('change', window.handleAvatarUpload);
    }
}

// Handle add account button click
function handleAddConfigClick() {
    // Enter add mode
    window.toggleConfigForm(false);
}

// Handle edit account button click
function handleEditConfigClick() {
    const editConfigBtn = document.getElementById('editConfigBtn');
    // Close the form if it is already shown
    const configForm = document.getElementById('configForm');
    if (configForm && configForm.style.display === 'block') {
        window.resetConfigForm();
        return;
    }

    // Enter edit mode
    if (window.selectedConfig) {
        window.toggleConfigForm(true);
        window.fillConfigForm(window.selectedConfig);
    }
}

// Bind email type events
function bindEmailTypeEvents() {
    const emailType = document.getElementById('emailType');

    // When the user clicks the dropdown selector (when expanded), immediately show all mail server config fields
    emailType.addEventListener('click', () => window.autoFillConfig(emailType.value));

    // Auto-fill config when the user selects an email type
    emailType.addEventListener('change', (e) => window.autoFillConfig(e.target.value));
}

// Bind username input event for auto-generating avatar
function bindUsernameInputEvent() {
    const username = document.getElementById('username');

    // Listen to input changes
    username.addEventListener('input', window.updateAvatar);
    // Listen to blur event (ensure the final value is processed)
    username.addEventListener('blur', window.updateAvatar);
}

// Bind window message listener
function bindWindowMessageListener() {
    window.addEventListener('message', async (event) => {
        handleWindowMessage(event);
    });

    window.addEventListener('contactSelected', (event) => {
        handleContactSelectedEvent(event);
    });

    window.addEventListener('deleteChatWebcom', (event) => {
        handleDeleteChatWebcom(event);
    });

    window.addEventListener('datachannel-status', (event) => {
        const { email, status } = event.detail;
        handleDataChannelStatus({ data: { email, status } });
    });

    window.addEventListener('avatar-updated', (event) => {
        const { email, avatar } = event.detail;
        handleAvatarUpdated({ data: { email, avatar } });
    });

    window.addEventListener('update-contact-last-message', (event) => {
        const { email, message } = event.detail;
        handleUpdateContactLastMessage({ data: { email, message } });
    });

    window.addEventListener('increment-unread-count', (event) => {
        const { email, msgId, count } = event.detail;
        handleIncrementUnreadCount({ data: { email, msgId, count } });
    });

    window.addEventListener('clear-unread-badge', (event) => {
        const { email } = event.detail;
        handleClearUnreadBadge({ data: { email } });
    });

    // [New] Listen to toggle inbox panel message
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'toggleInboxPanel') {
            console.log('📥 Received toggle inbox panel message');
            const inboxPanel = document.getElementById('inboxPanel');
            if (inboxPanel && typeof inboxPanel.toggle === 'function') {
                inboxPanel.toggle();
            }
        }
        // [New] Listen to open inbox panel message
        if (event.data && event.data.type === 'openInboxPanel') {
            console.log('📥 Received open inbox panel message');
            const inboxPanel = document.getElementById('inboxPanel');
            if (inboxPanel) {
                // If panel is minimized, restore first
                if (inboxPanel._isMinimized) {
                    console.log('📥 Inbox panel is minimized, restore first');
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

    if (window.electronAPI && window.electronAPI.onNewMail) {
        window.electronAPI.onNewMail((event, data) => {
            console.log('📬 Received new mail IDLE notification:', data, '-IDLE');

            if (window.selectedConfig && window.selectedConfig.username === data.username) {
                console.log('🔄 IDLE notification triggered email fetch, minutes: 2 -IDLE');
                window.handleFetchEmailsRequest(2, false, 'IDLE');
            }
        });
        console.log('✅ New mail IDLE notification listener bound');
    }
}

// Handle window messages
async function handleWindowMessage(event) {
    switch (event.data.type) {
        case 'updateContactAvatar':
            handleUpdateContactAvatar(event);
            break;
        case 'fetchEmails':
            console.log('📥 Received fetchEmails message, minutes:', event.data.minutes, '-poll');
            handleFetchEmailsEvent(event);
            break;
        case 'deleteEmailsBySenderAndSubject':
            handleDeleteEmailsEvent(event);
            break;
        case 'setPollingInterval':
            handleSetPollingIntervalEvent(event);
            break;
        case 'triggerSendOffer':
            handleTriggerSendOfferEvent(event);
            break;
        case 'activityReconnect':
            handleActivityReconnectEvent(event);
            break;
        case 'contactSelected':
            handleContactSelectedEvent(event);
            break;
        case 'showConfigSelectionPrompt':
            handleShowConfigSelectionPrompt(event);
            break;
        case 'forwardLog':
            if (window.activeChatWebcom && window.activeChatWebcom._initialized && typeof window.activeChatWebcom.forwardLog === 'function') {
                window.activeChatWebcom.forwardLog(event.data.logData);
            }
            break;
        case 'connectionStatusChange':
            console.log('🔄 Received connection status change message:', event.data.isConnected);
            break;
        case 'discoverEmailConfirmed':
            console.log('✅ Received discover email confirmation message, target email:', event.data.email);
            const sendmailElement = document.querySelector('mailink-sender');
            if (sendmailElement) {
                sendmailElement.dispatchEvent(new CustomEvent('discoverEmailConfirmed', {
                    detail: { email: event.data.email }
                }));
            }
            break;
        case 'deleteChatWebcom':
            handleDeleteChatWebcom(event);
            break;
        case 'maximizeChatWebcom': {
            // Handle request to activate and enlarge chat webcom (used when video/voice call connects)
            // Find the corresponding webcom via event.source
            const webcoms = document.querySelectorAll('mailink-chat');
            for (let webcom of webcoms) {
                if (webcom.contentWindow === event.source) {
                    const chatElement = webcom.closest('mailink-chat') || webcom;
                    window.activateChatWebcom(chatElement);
                    console.log('✅ Responded to maximizeChatWebcom request, activated webcom:', chatElement.id);
                    break;
                }
            }
            break;
        }
    }
}

// Handle data channel status message
function handleDataChannelStatus(event) {
    const { email, status } = event.data;
    if (status === 'connected') {
        window.activeConnections.set(email, 'connected');
        console.log(`🔗 Data channel established: ${email}`);
    } else if (status === 'disconnected') {
        window.activeConnections.delete(email);
        console.log(`🔗 Data channel closed: ${email}`);
    }

    // Update sessionStorage for the signaling worker
    sessionStorage.setItem('activeConnections', JSON.stringify(Array.from(window.activeConnections.entries())));
}

// Handle avatar update message
function handleAvatarUpdated(event) {
    // Handle avatar update
    const { email, avatar } = event.data;
    window.updateContactAvatar(email, avatar);
}

// Handle update contact avatar message
function handleUpdateContactAvatar(event) {
    const sendmailElement = document.querySelector('mailink-sender');
    if (sendmailElement) {
        sendmailElement.dispatchEvent(new CustomEvent('updateContactAvatar', {
            detail: {
                email: event.data.email,
                avatar: event.data.avatar
            }
        }));
        console.log(`📤 Forwarded updateContactAvatar message to mailink-sender, email: ${event.data.email}`);
    }
}

// Handle update contact last message
function handleUpdateContactLastMessage(event) {
    const logMsg = `📥 Sync request: email=${event.data.email}, content preview=${event.data.message?.substring(0, 20)}...`;
    console.log(logMsg);

    if (window.lastEmailTimes && event.data.email) {
        window.lastEmailTimes.set(event.data.email, Date.now());
    }

    if (window.activeChatWebcom && window.activeChatWebcom._initialized && typeof window.activeChatWebcom.forwardLog === 'function') {
        window.activeChatWebcom.forwardLog({ content: logMsg, timestamp: Date.now(), type: 'info' });
    }

    const sendmailElement = document.querySelector('mailink-sender');
    if (sendmailElement) {
        sendmailElement.dispatchEvent(new CustomEvent('updateContactLastMessage', {
            detail: { email: event.data.email }
        }));
        console.log(`📤 Forwarded updateContactLastMessage message to mailink-sender, email: ${event.data.email}`);
    }
}

// Handle unread message count increase
function handleIncrementUnreadCount(event) {
    const { email, msgId, count } = event.data;
    console.log(`📥 Unread count increased: email=${email}, msgId=${msgId}, count=${count}`);

    const sendmailElement = document.querySelector('mailink-sender');
    if (sendmailElement) {
        sendmailElement.dispatchEvent(new CustomEvent('incrementUnreadCount', {
            detail: { email, msgId, count }
        }));
        console.log(`📤 Forwarded incrementUnreadCount message to mailink-sender, email: ${email}, msgId: ${msgId}, count: ${count}`);
    }
}

// Handle clear unread badge
function handleClearUnreadBadge(event) {
    const { email } = event.data;
    console.log(`📥 Clear unread badge: email=${email}`);

    const sendmailElement = document.querySelector('mailink-sender');
    if (sendmailElement) {
        sendmailElement.dispatchEvent(new CustomEvent('clearUnreadBadge', {
            detail: { email }
        }));
        console.log(`📤 Forwarded clearUnreadBadge message to mailink-sender, email: ${email}`);
    }
}

// Handle fetch email event
function handleFetchEmailsEvent(event) {
    console.log('🔄 Start handling fetchEmails event, preparing to execute email fetch request -poll');

    // Change to trigger polling worker tick message
    if (window.pollingScheduler) {
        window.workerManager.postMessage('pollingScheduler', { type: 'tick' });
    } else if (window.isConnectionActive()) {
        // Fallback: handle directly
        window.handleFetchEmailsRequest(event.data.minutes, false, 'poll');
        window.showStatus('<div class="loading"><div class="spinner"></div><p>loading...</p></div>', 'info');
    }
}

// Handle delete email event
function handleDeleteEmailsEvent(event) {
    window.handleDeleteEmailsBySenderAndSubject(event.data.sender, event.data.subjectPrefix);
}

// Handle set polling interval event
function handleSetPollingIntervalEvent(event) {
    window.setPollingInterval(event.data.interval);
}

// Handle trigger send offer event
function handleTriggerSendOfferEvent(event) {
    console.log('🔔 Received triggerSendOffer message, toEmail: ' + event.data.toEmail);
    const targetEmail = event.data.toEmail;
    const webcomId = `chat_${targetEmail}`;
    let chatWebcom = document.getElementById(webcomId);

    console.log('🔍 Looking for chat webcom, ID: ' + webcomId);

    // Ensure webcom exists
    if (!chatWebcom) {
        console.log('❌ Chat webcom not found, preparing to create new one');
        chatWebcom = window.createChatWebcom(targetEmail, false, getMyEmail());
        console.log('✅ New chat webcom created, ID: ' + webcomId);
    } else {
        // If webcom already exists, perform position/size operation
        window.activateChatWebcom(chatWebcom);
    }

    // Send send_offer message regardless of whether webcom exists
    if (chatWebcom && typeof chatWebcom.sendOffer === 'function') {
        chatWebcom.sendOffer(targetEmail);
        console.log('📤 sendOffer API called');
    } else {
        console.error(`❌ chatWebcom or sendOffer method does not exist`);
    }
}

// Handle contact selection event
function handleContactSelectedEvent(event) {
    const targetEmail = event.detail?.email || event.data?.email;
    if (!targetEmail) {
        console.warn('⚠️ handleContactSelectedEvent: unable to get contact email');
        return;
    }

    const webcomId = `chat_${targetEmail}`;
    let chatWebcom = document.getElementById(webcomId);

    // If no chat webcom exists for this email, create a new one and send the message
    if (!chatWebcom) {
        chatWebcom = window.createChatWebcom(targetEmail, true, getMyEmail());

        // Use new API call - wait for component initialization to complete
        if (chatWebcom && typeof chatWebcom.selectContact === 'function') {
            // Call directly if component is initialized; otherwise wait for the ready event
            if (chatWebcom._initialized) {
                chatWebcom.selectContact(targetEmail);
                console.log('📋 selectContact API called');
            } else {
                chatWebcom.addEventListener('ready', () => {
                    chatWebcom.selectContact(targetEmail);
                    console.log('📋 Called selectContact API after component initialization completed');
                }, { once: true });
            }
        } else {
            console.error(`❌ chatWebcom or selectContact method does not exist`);
        }
    } else {
        // If webcom already exists, check connection status and email time
        window.activateChatWebcom(chatWebcom);

        // Attempt conditional connection reset
        window.checkAndAttemptWebRTCReset(chatWebcom, targetEmail);
    }
}

// Handle activity-triggered reconnect request
function handleActivityReconnectEvent(event) {
    const targetEmail = event.data.email;
    if (!targetEmail) return;

    console.log(`🖱️ Received activity reconnect request: ${targetEmail}`);

    const webcomId = `chat_${targetEmail}`;
    const chatWebcom = document.getElementById(webcomId);

    if (chatWebcom) {
        // Use the same conditional logic to check whether reset is needed
        window.checkAndAttemptWebRTCReset(chatWebcom, targetEmail);
    }
}

// Handle delete chat webcom request
function handleDeleteChatWebcom(event) {
    const email = event.detail?.email || event.data?.email;
    if (!email) {
        console.warn('⚠️ handleDeleteChatWebcom: unable to get contact email');
        return;
    }
    console.log(`📤 Received delete chat webcom request, email: ${email}`);

    // Find the corresponding chat webcom
    const webcomId = `chat_${email}`;
    const chatWebcom = document.getElementById(webcomId);

    if (chatWebcom) {
        // Delete webcom
        const webcomWrapper = chatWebcom.closest('.webcom-wrapper');
        if (webcomWrapper) {
            webcomWrapper.remove();
        } else {
            chatWebcom.remove();
        }

        // Remove the corresponding record from the webcomLastLoadTimes Map
        window.webcomLastLoadTimes.delete(email);

        // If the deleted webcom is the currently active one, update the activeChatWebcom variable
        // Use ID comparison instead of reference comparison for robustness
        if (window.activeChatWebcom && window.activeChatWebcom.id === webcomId) {
            window.activeChatWebcom = null;
        }

        console.log(`✅ Chat webcom deleted, email: ${email}`);
    } else {
        console.warn(`⚠️ Chat webcom not found, email: ${email}`);
    }
}

// Handle initialization error
function handleInitializationError(error) {
    console.error('Config load failed:', error);
    window.showStatus(`Config load failed: ${error.message}`, 'error');
}

// Bind mailink-sender CustomEvent events
function bindMailinkSenderEvents() {
    const mailinkSender = document.getElementById('mailsender');
    if (!mailinkSender) {
        console.warn('mailink-sender element not found');
        return;
    }

    mailinkSender.addEventListener('log', (event) => {
        const { content, timestamp, type } = event.detail;
        
        const validTypes = ['log', 'info', 'warn', 'error'];
        const consoleType = validTypes.includes(type) ? type : 'log';
        console[consoleType](content);

        if (window.activeChatWebcom && window.activeChatWebcom._initialized && typeof window.activeChatWebcom.forwardLog === 'function') {
            window.activeChatWebcom.forwardLog({ content, timestamp, type });
        }
    });

    mailinkSender.addEventListener('showConfigSelectionPrompt', () => {
        window.handleShowConfigSelectionPrompt();
    });
}

// Bind mailink-recver CustomEvent events and callbacks
function bindMailinkRecverEvents() {
    const mailrecver = document.getElementById('mailrecver');
    if (!mailrecver) {
        console.warn('mailink-recver element not found');
        return;
    }

    setupMailrecverCallbacks();

    mailrecver.addEventListener('connectionStatusChange', (event) => {
        console.log('🔄 Received mailink-recver connection status change:', event.detail.isConnected);
    });
}

async function initLangSelect() {
    const langSelect = document.getElementById('langSelect');
    if (!langSelect) return;

    if (window.i18n?.renderLangSelect) {
        await window.i18n.renderLangSelect(langSelect);
    }

    langSelect.addEventListener('change', async (e) => {
        if (window.i18n?.setLang) {
            await window.i18n.setLang(e.target.value);
        }
    });
}
