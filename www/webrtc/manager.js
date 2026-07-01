// WebRTC management module
import { sendMessageToWebcomWithRetry, getMyEmail } from '../utils/index.js';
import { MailinkChat } from './chat-component/index.js';

const CHAT_ELEMENT_TAG = 'mailink-chat';

if (!customElements.get(CHAT_ELEMENT_TAG)) {
    customElements.define(CHAT_ELEMENT_TAG, MailinkChat);
}

// Helper function: get current user's email (using unified utility function)
function getMyEmailLocal() {
    return getMyEmail();
}

// Get the WebRTC management Worker
export function getWebRTCWorker() {
    // Get the WebRTC Worker from workerManager
    return window.workerManager.getWorker('webRTCWorker');
}

// Send a message to the WebRTC management Worker
export function sendToWebRTCWorker(message) {
    // Send the message using workerManager
    return window.workerManager.postMessage('webRTCWorker', message);
}

// Ensure performSoftResetAndReconnect is available globally
window.performSoftResetAndReconnect = performSoftResetAndReconnect;
window.checkAndAddContact = checkAndAddContact;


// Activate the chat webcom
export function activateChatWebcom(chatWebcom) {
    // If this webcom is already active, return directly to avoid redundant operations and messages
    if (window.activeChatWebcom === chatWebcom) {
        return;
    }

    // Get all current chat webcom wrappers
    const allWebcomWrappers = document.querySelectorAll('.webcom-wrapper:not(:first-child)');

    // Remove all active states
    allWebcomWrappers.forEach(wrapper => {
        wrapper.classList.remove('active');
        wrapper.style.left = `${wrapper.offsetLeft}px`;
    });

    // Activate the current webcom
    const webcomWrapper = chatWebcom.parentElement.parentElement;
    webcomWrapper.classList.add('active');

    // Update the active state
    window.activeChatWebcom = chatWebcom;

    // Ensure the webcom-container uses flex layout to properly display the active webcom
    const webcomContainer = document.querySelector('.webcom-container');
    if (webcomContainer) {
        webcomContainer.style.display = 'flex';
    }

    // Send a message to the sendmail webcom to notify it to update the contact card status
    // Extract the email address from the webcom id (format: chat_email@example.com)
    const webcomId = chatWebcom.id;
    if (webcomId && webcomId.startsWith('chat_')) {
        const targetEmail = webcomId.replace('chat_', '');
        const sendmailWebcom = document.querySelector('mailink-sender');
        if (sendmailWebcom && typeof sendmailWebcom.handleWebcomActivated === 'function') {
            sendmailWebcom.handleWebcomActivated(targetEmail);
            console.log(`📤 Notifying sendmail page to update contact ${targetEmail} activation status`);
        }
    }
}

// Dynamically create a chat webcom
export function createChatWebcom(targetEmail, shouldActivate = false, myEmail = null) {
    const webcomId = `chat_${targetEmail}`;
    const webcomWrapper = document.createElement('div');
    webcomWrapper.className = 'webcom-wrapper';

    const webcomContent = document.createElement('div');
    webcomContent.className = 'webcom-content';

    const chatWebcom = document.createElement(CHAT_ELEMENT_TAG);
    chatWebcom.setAttribute('title', `${window.i18n?.t('chat.chatTitle') || 'Chat'} - ${targetEmail}`);
    chatWebcom.setAttribute('contact-email', targetEmail);
    chatWebcom.setAttribute('my-email', myEmail || '');
    chatWebcom.id = webcomId;

    // Add click event to activate the current webcom
    chatWebcom.addEventListener('click', () => {
        activateChatWebcom(chatWebcom);
    });

    // --- Web Components Event Adapters (Step 3) ---
    // Adapt Web Components events to the parent window handling logic
    
    // 1. Contact last message update
    chatWebcom.addEventListener('update-contact-last-message', (e) => {
        const { email, message } = e.detail;
        window.dispatchEvent(new CustomEvent('update-contact-last-message', {
            detail: { email, message },
            bubbles: true,
            composed: true
        }));
    });

    // 1.5 Unread message count increase
    chatWebcom.addEventListener('increment-unread-count', (e) => {
        const { email, msgId, count } = e.detail || {};
        window.dispatchEvent(new CustomEvent('increment-unread-count', {
            detail: { email, msgId, count },
            bubbles: true,
            composed: true
        }));
    });

    // 1.6 Clear unread badge
    chatWebcom.addEventListener('clear-unread-badge', (e) => {
        const { email } = e.detail;
        window.dispatchEvent(new CustomEvent('clear-unread-badge', {
            detail: { email },
            bubbles: true,
            composed: true
        }));
    });

    // 2. Data channel status update
    chatWebcom.addEventListener('datachannel-status', (e) => {
        const { email, status } = e.detail;
        window.dispatchEvent(new CustomEvent('datachannel-status', {
            detail: { email, status },
            bubbles: true,
            composed: true
        }));
    });

    // 3. Avatar update
    chatWebcom.addEventListener('avatar-updated', (e) => {
        const { email, avatar } = e.detail;
        window.dispatchEvent(new CustomEvent('avatar-updated', {
            detail: { email, avatar },
            bubbles: true,
            composed: true
        }));
    });

    // 4. Connection failed - trigger automatic reconnection
    chatWebcom.addEventListener('connection-failed', async (e) => {
        console.warn(`[${e.detail.email}] Connection failed: ${e.detail.reason}`);

        // Note: connection-failed means connection failure; reconnection should be performed regardless of whether the window is active
        // Timeout and other non-failure scenarios are judged internally by each component for protection

        console.log(`🔍 [${e.detail.email}] Connection failed, triggering emergency email fetch (parallel mode)...`);
        // Use parallel workers to fetch signaling emails and regular emails simultaneously
        if (window.electronAPI && typeof window.electronAPI.fetchEmailsParallel === 'function') {
            try {
                const result = await window.electronAPI.fetchEmailsParallel(window.selectedConfig, 2);
                console.log(`✅ [${e.detail.email}] Parallel email fetch completed:`, {
                    signaling: result.signalingEmails?.length || 0,
                    normal: result.normalEmails?.length || 0,
                    duration: result.duration + 'ms'
                });
            } catch (fetchErr) {
                console.error(`❌ [${e.detail.email}] Parallel email fetch failed:`, fetchErr);
                // Fall back to the original method
                if (typeof window.electronAPI.fetchEmails === 'function') {
                    window.electronAPI.fetchEmails(window.selectedConfig, 2, true);
                }
            }
        } else if (window.electronAPI && typeof window.electronAPI.fetchEmails === 'function') {
            // Fallback: use the original method
            window.electronAPI.fetchEmails(window.selectedConfig, 2, true);
        }

        console.log(`🔄 [${e.detail.email}] Triggering auto-reconnect...`);
        setTimeout(() => {
            try {
                if (chatWebcom.contentWindow && chatWebcom.contentWindow.chatWebcom) {
                    chatWebcom.contentWindow.chatWebcom.handleReconnect();
                }
            } catch (err) {
                console.error(`[${e.detail.email}] Reconnect failed:`, err);
            }
        }, 3000);
    });

    // 5. Title update - NAT type display
    chatWebcom.addEventListener('title-updated', (e) => {
        const { title } = e.detail;
        chatWebcom.setAttribute('title', title);
    });

    // ---------------------------------------------

    webcomContent.appendChild(chatWebcom);
    webcomWrapper.appendChild(webcomContent);

    // Add to the webcom container
    const webcomContainer = document.querySelector('.webcom-container');
    if (webcomContainer) {
        // Ensure the webcom container is visible
        webcomContainer.style.display = 'flex';
        webcomContainer.classList.add('visible');
        webcomContainer.appendChild(webcomWrapper);
        console.log('✅ Chat webcom added to container, webcomContainer visibility:', webcomContainer.style.display);

        // Decide whether to activate the current webcom based on the shouldActivate parameter
        // Only activate when shouldActivate is true, or when there is no valid active webcom
        // Check whether activeChatWebcom is valid (exists and is still in the DOM)
        const isActiveWebcomValid = window.activeChatWebcom && window.activeChatWebcom.isConnected;
        if (shouldActivate || !isActiveWebcomValid) {
            activateChatWebcom(chatWebcom);
        }
    } else {
        console.error('❌ webcom container not found');
    }

    // Record the last load time of the webcom
    const now = Date.now();
    window.webcomLastLoadTimes.set(targetEmail, now);

    console.log('✅ Created chat webcom, ID:', webcomId, 'src:', chatWebcom.src, 'load time:', new Date(now), 'activate: ', shouldActivate || !window.activeChatWebcom);
    return chatWebcom;
}

// Check conditions and attempt to reset the WebRTC connection (reused logic)
export function checkAndAttemptWebRTCReset(chatWebcom, targetEmail) {
    // Check connection status and last email time
    // Adapt to Web Components: directly access the webRTCConnectionStatus property
    const connectionStatus = chatWebcom.webRTCConnectionStatus;
    const lastEmailTime = window.lastEmailTimes.get(targetEmail);
    const webcomLoadTime = window.webcomLastLoadTimes.get(targetEmail) || Date.now();
    // If no emails have been received, use the webcom's last load time as the initial value
    const effectiveLastEmailTime = lastEmailTime !== undefined ? lastEmailTime : webcomLoadTime;
    const now = Date.now();

    // If the connection state is not connected and the last email time exceeds 60 seconds, perform a soft reset and reconnect
    if (connectionStatus !== 'connected' && (now - effectiveLastEmailTime > 60000)) {
        console.log(`♻️ Triggering soft reset: ${targetEmail}, connection: ${connectionStatus}, last email time: ${new Date(effectiveLastEmailTime)}`);

        // Record the current time as the last load time
        window.webcomLastLoadTimes.set(targetEmail, now);

        // Perform soft reset and reconnection
        performSoftResetAndReconnect(chatWebcom, targetEmail);
    }
}

// Execute soft reset and reconnection logic (reused code)
// Important: operate on the chatWebcom corresponding to the target contact, not the currently active chatWebcom
export function performSoftResetAndReconnect(webcom, email) {
    // Find or create the chatWebcom corresponding to the target contact
    const targetWebcomId = `chat_${email}`;
    let targetWebcom = document.getElementById(targetWebcomId);

    if (!targetWebcom) {
        console.log(`♻️ [${email}] Target chatWebcom does not exist, creating new`);
        targetWebcom = createChatWebcom(email, true, getMyEmailLocal());
    } else {
        // Ensure the target chatWebcom is activated
        activateChatWebcom(targetWebcom);
    }

    // Perform operations using the target chatWebcom (not the passed-in webcom)
    const activeWebcom = targetWebcom;

    if (typeof activeWebcom.resetConnection !== 'function') {
        console.warn(`[${email}] webcom.resetConnection is not a function`);
        return;
    }

    // 1. Send soft reset command
    activeWebcom.resetConnection();
    console.log(`♻️ [${email}] Soft reset command sent`);

    // 2. Reinitiate the connection immediately
    // 3. Send contactSelected to ensure context
    activeWebcom.selectContact(email);
    console.log(`📋 [${email}] contactSelected command sent`);

    // 4. Trigger WebRTC Offer
    activeWebcom.sendOffer(email);
    console.log(`📤 [${email}] WebRTC Offer triggered`);
}

// Handle operation commands returned by the Worker
export function handleWorkerAction(action, senderEmail) {
    switch (action.type) {
        case 'SET_STORAGE':
            localStorage.setItem(action.key, action.value);
            break;
        case 'CACHE_SENDER':
            localStorage.setItem(action.key, action.value);
            break;
        case 'SHOW_P2P_CHAT': {
            // Display or create the corresponding chat webcom
            const webcomId = `chat_${senderEmail}`;
            let chatWebcom = document.getElementById(webcomId);

            // If no chat webcom exists for this email, create a new one
            if (!chatWebcom) {
                chatWebcom = createChatWebcom(senderEmail, false, getMyEmail());
            } else {
                // Only auto-activate when there is currently no valid active chat (do not interrupt the user's current chat)
                const isActiveWebcomValid = window.activeChatWebcom && window.activeChatWebcom.isConnected;
                if (!isActiveWebcomValid) {
                    activateChatWebcom(chatWebcom);
                }
            }

            if (chatWebcom) {
                chatWebcom.style.display = 'block';
            }
            break;
        }
        case 'LOAD_HISTORY_MESSAGES': {
            // Extract sender email from signal
            const targetEmail = action.from;
            const webcomId = `chat_${targetEmail}`;
            let chatWebcom = document.getElementById(webcomId);

            // If no chat webcom exists for this email, create a new one
            if (!chatWebcom) {
                chatWebcom = createChatWebcom(targetEmail, false, getMyEmail());
            } else {
                // Auto-activate only when there is currently no valid active chat
                const isActiveWebcomValid = window.activeChatWebcom && window.activeChatWebcom.isConnected;
                if (!isActiveWebcomValid) {
                    activateChatWebcom(chatWebcom);
                }
            }

            // Trigger historical message loading
            if (chatWebcom) {
                chatWebcom.loadHistoryMessages(targetEmail);
            }
            break;
        }
        case 'DELETE_EMAIL':
            window.handleDeleteEmailsBySenderAndSubject(action.sender, action.subjectPrefix, action.immediate);
            break;
        case 'DELETE_EMAIL_BY_UID':
            window.handleDeleteEmailsByUid(action.emailUids, action.immediate);
            break;
        case 'LOG':
            console.log('[Worker]', action.message);
            break;
        case 'UPDATE_CONTACT': {
            // Update contact information
            console.log(`[handleWorkerAction] UPDATE_CONTACT called:`, action);
            const currentEmail = window.selectedConfig?.username;
            const myEmailKey = `mymail_${currentEmail.replace(/@/g, '_at_')}`;
            const myEmail = sessionStorage.getItem(myEmailKey) || currentEmail || '';
            if (myEmail) {
                // First check whether the contact already exists
                window.electronAPI.getContacts(myEmail).then(async contacts => {
                    const existingContact = contacts.find(contact => contact.username === action.sender);
                    const contactExists = !!existingContact;
                    
                    if (contactExists) {
                        // Contact already exists, update the name
                        console.log(`Updating contact name: ${action.sender} -> ${action.senderName}`);
                    } else {
                        // Contact does not exist, add a new contact
                        console.log(`Adding new contact: ${action.senderName} <${action.sender}>`);
                    }
                    
                    // Build contact data
                    const contactData = {
                        rmkname: action.senderName,
                        nickname: action.senderName,
                        username: action.sender
                    };
                    
                    // Process avatar data (only update when the contact has no avatar)
                    if (action.avatarData) {
                        // Check whether the contact already has an avatar
                        if (existingContact && existingContact.avatar) {
                            console.log(`[handleWorkerAction] Contact already has avatar, skipping update: ${action.sender}`);
                        } else {
                            console.log(`[handleWorkerAction] Processing avatar data:`, action.avatarData);
                            try {
                                let avatarBase64 = null;
                                const { content, mimeType } = action.avatarData;
                                
                                console.log(`[handleWorkerAction] Avatar content type: ${typeof content}, mimeType: ${mimeType}`);
                                
                                // If content is ArrayBuffer or Uint8Array, convert it to Base64
                                if (content) {
                                    if (content instanceof ArrayBuffer || content instanceof Uint8Array || 
                                        (typeof content === 'object' && content.type === 'Buffer')) {
                                        // Handle Buffer-type data
                                        console.log(`[handleWorkerAction] Processing Buffer-type avatar data`);
                                        const buffer = content.data ? new Uint8Array(content.data) : new Uint8Array(content);
                                        const binary = buffer.reduce((acc, byte) => acc + String.fromCharCode(byte), '');
                                        avatarBase64 = btoa(binary);
                                    } else if (typeof content === 'string') {
                                        // If it is already a base64 string
                                        console.log(`[handleWorkerAction] Processing string-type avatar data, length: ${content.length}`);
                                        if (content.startsWith('data:')) {
                                            avatarBase64 = content.split(',')[1];
                                        } else {
                                            avatarBase64 = content;
                                        }
                                    }
                                }
                                
                                if (avatarBase64) {
                                    contactData.avatar = `data:${mimeType};base64,${avatarBase64}`;
                                    console.log(`🖼️ Processed contact avatar: ${action.sender}, type: ${mimeType}, base64 length: ${avatarBase64.length}`);
                                } else {
                                    console.warn(`[handleWorkerAction] Failed to extract avatar base64 data`);
                                }
                            } catch (err) {
                                console.error('Failed to process avatar data:', err);
                            }
                        }
                    } else {
                        console.log(`[handleWorkerAction] No avatar data`);
                    }
                    
                    // Use the addContact function, which should support updating existing contacts
                    window.electronAPI.addContact(myEmail, contactData).then(() => {
                        // Show contact add/update success notification
                        const message = contactExists
                            ? (window.i18n?.t('chat.contactUpdateSuccess') || 'Contact updated: {name}').replace('{name}', action.senderName)
                            : (window.i18n?.t('chat.contactAddSuccess') || 'Contact added: {name}').replace('{name}', action.senderName);
                        window.showStatus(message, 'success');

                        // Refresh contact list in sendmail.html
                        const sendmailWebcom = document.querySelector('mailink-sender');
                        if (sendmailWebcom && typeof sendmailWebcom.refreshContacts === 'function') {
                            sendmailWebcom.refreshContacts();
                        }
                        
                        // Trigger avatar update event (if an avatar exists)
                        if (contactData.avatar) {
                            window.dispatchEvent(new CustomEvent('avatar-updated', {
                                detail: {
                                    email: action.sender,
                                    avatar: contactData.avatar
                                }
                            }));
                            
                            // Notify the sendmail component to update the contact avatar
                            // Get the contact-list in the shadowRoot via sendmailWebcom
                            if (sendmailWebcom && sendmailWebcom.shadowRoot) {
                                const contactList = sendmailWebcom.shadowRoot.getElementById('contact-list');
                                if (contactList && typeof contactList._updateContactAvatar === 'function') {
                                    contactList._updateContactAvatar(action.sender, contactData.avatar);
                                    console.log(`🖼️ Updated contact list avatar: ${action.sender}`);
                                }
                            }
                            
                            // Notify the contact list in the iframe via postMessage
                            const mailrecver = document.getElementById('mailrecver');
                            if (mailrecver && mailrecver.contentWindow) {
                                mailrecver.contentWindow.postMessage({
                                    type: 'updateContactAvatar',
                                    email: action.sender,
                                    avatar: contactData.avatar
                                }, '*');
                            }
                        }
                    }).catch(err => {
                        console.error('Failed to update contact:', err);
                    });
                }).catch(err => {
                    console.error('Failed to get contact list:', err);
                });
            }
            break;
        }
        case 'FORWARD_TO_WEBRTC': {
            // Extract the target mailbox from signaling data
            const targetEmail = action.data.from || action.sender;
            const webcomId = `chat_${targetEmail}`;
            let chatWebcom = document.getElementById(webcomId);

            // Update the last email time for this contact
            window.lastEmailTimes.set(targetEmail, Date.now());

            console.log('🔍 Processing FORWARD_TO_WEBRTC action, target email: ' + targetEmail + ', event: ' + action.event);

            // If no chat webcom exists for this email, create a new one
            if (!chatWebcom) {
                console.log('❌ Chat webcom not found, preparing to create new');
                chatWebcom = createChatWebcom(targetEmail, false, getMyEmail());
                console.log('✅ Created new chat webcom, ID: ' + webcomId);
            } else {
                // Auto-activate only when there is currently no valid active chat
                const isActiveWebcomValid = window.activeChatWebcom && window.activeChatWebcom.isConnected;
                if (!isActiveWebcomValid) {
                    activateChatWebcom(chatWebcom);
                }
            }

            // Send WebRTC signals regardless of whether the webcom exists
            if (chatWebcom) {
                chatWebcom.sendSignal(action.event, action.data);
                console.log('📤 Forwarded WEBRTC_SIGNAL via API:', action.event);
            }
            break;
        }
        case 'FORWARD_TO_CHAT': {
            // Extract the target mailbox from signaling data
            const targetEmail = action.data.from || action.sender;
            const webcomId = `chat_${targetEmail}`;
            let chatWebcom = document.getElementById(webcomId);

            console.log('🔍 Processing FORWARD_TO_CHAT action, target email: ' + targetEmail + ', event: ' + action.event);

            // If no chat webcom exists for this email, create a new one
            if (!chatWebcom) {
                console.log('❌ Chat webcom not found, preparing to create new');
                chatWebcom = createChatWebcom(targetEmail, false, getMyEmail());
                console.log('✅ Created new chat webcom, ID: ' + webcomId);
            } else {
                // Auto-activate only when there is currently no valid active chat
                const isActiveWebcomValid = window.activeChatWebcom && window.activeChatWebcom.isConnected;
                if (!isActiveWebcomValid) {
                    activateChatWebcom(chatWebcom);
                }
            }

            // Send chat messages regardless of whether the webcom exists
            if (chatWebcom) {
                chatWebcom.sendSignal(action.event, action.data);
                console.log('📤 Forwarded CHAT_MESSAGE via API:', action.event);
            }
            break;
        }
        case 'ADD_CONTACT': {
            // Add contact (auto-added from signaling email, status=0 means acquaintance)
            const targetEmail = action.sender;
            const status = action.status || 0;
            
            console.log(`[handleWorkerAction] ADD_CONTACT called: ${targetEmail}, status=${status}`);
            
            const currentEmail = window.selectedConfig?.username;
            const myEmail = window.currentMyEmail || currentEmail || '';
            
            if (!myEmail) {
                console.error('[ADD_CONTACT] Current user email not found');
                break;
            }
            
            // Restriction: cannot add yourself
            const normalizedMyEmail = myEmail.trim().toLowerCase();
            const normalizedTargetEmail = targetEmail.trim().toLowerCase();
            if (normalizedTargetEmail === normalizedMyEmail) {
                console.debug(`[ADD_CONTACT] Cannot add self as contact: ${targetEmail}`);
                break;
            }
            
            // Get the current contact list
            window.electronAPI.getContacts(myEmail).then(async contacts => {
                // Check if contact already exists
                const existingContact = contacts.find(contact => 
                    contact.username.toLowerCase() === normalizedTargetEmail
                );
                
                if (existingContact) {
                    console.log(`[ADD_CONTACT] Contact already exists: ${targetEmail}`);
                    return;
                }
                
                // Auto-generate contact name (use the part before @)
                const contactName = targetEmail.split('@')[0];
                
                // Add contact, status=0 means acquaintance (auto-added via signaling email)
                await window.electronAPI.addContact(myEmail, {
                    rmkname: contactName,
                    nickname: contactName,
                    username: targetEmail,
                    status: status
                });

                console.log(`[ADD_CONTACT] Auto-added contact successfully: ${contactName} <${targetEmail}>, status=${status} (acquaintance)`);
                window.showStatus((window.i18n?.t('chat.newContact') || 'New contact: {name}').replace('{name}', contactName), 'success');
                
                // Refresh contact list in sendmail.html
                const sendmailWebcom = document.querySelector('mailink-sender');
                if (sendmailWebcom && typeof sendmailWebcom.refreshContacts === 'function') {
                    sendmailWebcom.refreshContacts();
                }
            }).catch(err => {
                console.error('[ADD_CONTACT] Failed to add contact:', err);
            });
            break;
        }
    }
}

// Check and add contact
export async function checkAndAddContact(fromEmail) {
    try {
        const currentEmail = window.selectedConfig?.username;
        const myEmail = window.currentMyEmail || currentEmail || '';
        if (!myEmail) {
            console.error('Current user email not found');
            return;
        }

        // Restriction: cannot add the currently logged-in IMAP account email address as a contact
        const normalizedMyEmail = myEmail.trim().toLowerCase();
        const normalizedFromEmail = fromEmail.trim().toLowerCase();
        if (normalizedFromEmail === normalizedMyEmail) {
            console.debug(`[checkAndAddContact] Cannot add self as contact: ${fromEmail}`);
            return;
        }

        // Get the current contact list
        const contacts = await window.electronAPI.getContacts(myEmail);

        // Check if contact already exists
        const contactExists = contacts.some(contact => contact.username === fromEmail);

        if (!contactExists) {
            // Auto-generate contact name (use the part before @)
            const contactName = fromEmail.split('@')[0];

            // Add contact (set auto-added contact status to 0 - valid)
            await window.electronAPI.addContact(myEmail, {
                rmkname: contactName,
                nickname: contactName,
                username: fromEmail,
                status: 0
            });

            console.log(`Auto-added contact successfully: ${contactName} <${fromEmail}>`);
            window.showStatus((window.i18n?.t('chat.contactAddSuccess') || 'Contact added: {name}').replace('{name}', contactName), 'success');

            // Refresh contact list in sendmail.html
            const sendmailWebcom = document.querySelector('mailink-sender');
            if (sendmailWebcom && typeof sendmailWebcom.refreshContacts === 'function') {
                sendmailWebcom.refreshContacts();
            }
            
            // Automatically trigger WebRTC signaling email sending
            console.log(`📧 [Auto Signaling] Auto-added contact from signaling email, triggering auto signaling: ${fromEmail}`);
            
            // Set the new contact flag so the first signaling email attaches an avatar (using the new persistence mechanism)
            if (window.newContactStorage && window.newContactStorage.markAsNewContact) {
                window.newContactStorage.markAsNewContact(fromEmail, 'autoAddedFromSignal');
            } else {
                // Backward compatibility
                if (!window._newContactMap) {
                    window._newContactMap = new Map();
                }
                window._newContactMap.set(fromEmail, true);
            }
            console.log(`🆕 [Auto Signaling] Marked as new contact (auto-added from signaling email): ${fromEmail}`);
            
            // Role determination: smaller email lexicographically is Sender
            const isSender = myEmail.trim().toLowerCase() < fromEmail.trim().toLowerCase();
            
            // Dispatch the automatic signaling event
            window.dispatchEvent(new CustomEvent('autoTriggerSignaling', {
                detail: {
                    type: isSender ? 'sendOffer' : 'sendDiscover',
                    targetEmail: fromEmail,
                    myEmail: myEmail,
                    source: 'autoAddedFromSignal',
                    isNewContact: true
                }
            }));
        }
    } catch (error) {
        console.warn('Failed to check and add contact:', error);
    }
}

// ============================================
// Automatic signaling email trigger handling
// ============================================

// Configuration constants
const AUTO_SIGNALING_CONFIG = {
    ENABLED_KEY: 'mailink_auto_signaling_enabled',
    COOLDOWN_KEY: 'mailink_auto_signaling_last_time',
    COOLDOWN_MS: 30000, // 30secondswithinnot duplicatetriggersamecontactAuto signaling
    DEFAULT_ENABLED: true // Automatic signaling is enabled by default
};

/**
 * Get automatic signaling configuration
 */
function getAutoSignalingConfig() {
    const enabled = localStorage.getItem(AUTO_SIGNALING_CONFIG.ENABLED_KEY);
    return {
        enabled: enabled === null ? AUTO_SIGNALING_CONFIG.DEFAULT_ENABLED : enabled === 'true'
    };
}

/**
 * Set automatic signaling enabled state
 */
function setAutoSignalingEnabled(enabled) {
    localStorage.setItem(AUTO_SIGNALING_CONFIG.ENABLED_KEY, String(enabled));
    console.log(`[Auto Signaling] Auto signaling feature ${enabled ? 'enabled' : 'disabled'}`);
}

/**
 * Check whether automatic signaling should be triggered (duplicate prevention mechanism)
 */
function shouldTriggerAutoSignaling(targetEmail) {
    const config = getAutoSignalingConfig();
    if (!config.enabled) {
        console.log('[Auto Signaling] Auto signaling feature disabled, skipping trigger');
        return false;
    }
    
    const lastTimeKey = `${AUTO_SIGNALING_CONFIG.COOLDOWN_KEY}_${targetEmail}`;
    const lastTime = parseInt(localStorage.getItem(lastTimeKey) || '0');
    const now = Date.now();
    
    if (now - lastTime < AUTO_SIGNALING_CONFIG.COOLDOWN_MS) {
        console.log(`[Auto Signaling] Too soon since last trigger (${now - lastTime}ms), skipping duplicate trigger`);
        return false;
    }
    
    // Update the last trigger time
    localStorage.setItem(lastTimeKey, String(now));
    return true;
}

// Expose configuration functions globally for external calls
window.getAutoSignalingConfig = getAutoSignalingConfig;
window.setAutoSignalingEnabled = setAutoSignalingEnabled;

/**
 * Handle automatic signaling email trigger events
 * When a new contact is added, automatically send Discover or trigger Offer based on role
 */
window.addEventListener('autoTriggerSignaling', async (event) => {
    const { type, targetEmail, myEmail, source, addfriend, readme } = event.detail || {};

    if (!targetEmail || !myEmail) {
        console.warn('[Auto Signaling] Missing required email information');
        return;
    }

    // Check whether it should be triggered
    if (!shouldTriggerAutoSignaling(targetEmail)) {
        return;
    }

    console.log(`📧 [Auto Signaling] Received auto-trigger request: type=${type}, target=${targetEmail}, source=${source}`);
    
    // Check whether the corresponding chat webcom already exists
    const webcomId = `chat_${targetEmail}`;
    let chatWebcom = document.getElementById(webcomId);
    
    // If it does not exist, create a new chat webcom
    if (!chatWebcom) {
        console.log(`[Auto Signaling] Creating new chat webcom: ${webcomId}`);
        chatWebcom = createChatWebcom(targetEmail, false, myEmail);
        
        // Wait for the webcom initialization to complete
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    if (!chatWebcom) {
        console.error('[Auto Signaling] Unable to create or get chat webcom');
        return;
    }
    
    try {
        switch (type) {
            case 'sendOffer':
                // Sender role: directly trigger sending an Offer
                console.log(`📤 [Auto Signaling] Sender role, triggering Offer send to ${targetEmail}`);
                
                // First select the contact (set the target email context)
                if (typeof chatWebcom.selectContact === 'function') {
                    chatWebcom.selectContact(targetEmail);
                }
                
                // Trigger Offer sending after a delay
                setTimeout(() => {
                    if (typeof chatWebcom.sendOffer === 'function') {
                        chatWebcom.sendOffer(targetEmail, { readme });
                        console.log(`✅ [Auto Signaling] Offer send triggered`);
                    } else {
                        console.warn('[Auto Signaling] sendOffer method not available');
                    }
                }, 1000);
                break;
                
            case 'sendDiscover':
                // Receiver role: send a Discover signaling email
                console.log(`📤 [Auto Signaling] Receiver role, sending Discover to ${targetEmail}`);
                
                // First select the contact
                if (typeof chatWebcom.selectContact === 'function') {
                    chatWebcom.selectContact(targetEmail);
                }
                
                // Send the Discover email via the parent window
                setTimeout(() => {
                    // Use postMessage to notify the sendmail component to send the Discover email
                    window.postMessage({
                        type: 'sendAutoDiscoverEmail',
                        toEmail: targetEmail,
                        myEmail: myEmail
                    }, '*');
                    console.log(`✅ [Auto Signaling] Discover email send request dispatched`);
                }, 800);
                break;
                
            default:
                console.warn(`[Auto Signaling] Unknown signal type: ${type}`);
        }
    } catch (error) {
        console.error('[Auto Signaling] Failed to process auto signaling:', error);
    }
});

/**
 * Listen for automatic Discover email send requests from sendmail
 */
window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'sendAutoDiscoverEmail') {
        const { toEmail, myEmail } = event.data;
        console.log(`📧 [Auto Signaling] Received Discover email send request: ${myEmail} -> ${toEmail}`);
        
        // Here you can send the Discover email directly via electronAPI
        // Or trigger the sendmail component's email sending logic
        _sendDiscoverEmailDirectly(toEmail, myEmail);
    }
});

/**
 * Send a Discover signaling email directly
 * Used by the Receiver role to automatically notify the Sender
 */
async function _sendDiscoverEmailDirectly(toEmail, myEmail) {
    try {
        const config = window.getSelectedConfig?.();
        if (!config) {
            console.warn('[Auto Signaling] Unable to get email config');
            return;
        }
        
        const senderName = myEmail.split('@')[0];
        const subject = `${SIGNALING_EMAIL_PREFIX}discover-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Get user avatar and add to attachments (only sent in first Discover email to new contact)
        let attachments = [];
        let avatarAttachment = null;
        let shouldAttachAvatar = false;
        
        // Check if it is a new contact (using the new persistent storage mechanism)
        // Prefer newContactStorage; fall back to _newContactMap if not available
        if (window.newContactStorage && window.newContactStorage.isNewContact) {
            shouldAttachAvatar = window.newContactStorage.isNewContact(toEmail);
        } else {
            // Backward compatibility
            shouldAttachAvatar = window._newContactMap && window._newContactMap.get(toEmail);
        }
        
        if (shouldAttachAvatar) {
            try {
                const myAvatarData = _getMyAvatarData();
                if (myAvatarData) {
                    const avatarExt = _getFileExtension(myAvatarData.mimeType);
                    const avatarFilename = `myavatar_${_generateRandomId()}.${avatarExt}`;
                    const avatarCid = `avatar_${Date.now()}_${_generateRandomId()}`;
                    
                    // Convert avatar data to base64 string (browser-compatible way)
                    let avatarContent;
                    if (myAvatarData.isBase64) {
                        // Pass base64 data directly (strip data:image/xxx;base64, prefix)
                        avatarContent = myAvatarData.data.split(',')[1];
                    } else {
                        avatarContent = myAvatarData.data;
                    }
                    
                    attachments.push({
                        filename: avatarFilename,
                        content: avatarContent,
                        cid: avatarCid,
                        encoding: 'base64'  // Mark as base64 encoded
                    });
                    
                    avatarAttachment = {
                        filename: avatarFilename,
                        mimeType: myAvatarData.mimeType,
                        size: myAvatarData.size,
                        cid: avatarCid
                    };
                    
                    console.log(`🖼️ [Auto Signaling] Discover email attached avatar: ${avatarFilename} (${myAvatarData.mimeType})`);
                } else {
                    console.log(`⚠️ [Auto Signaling] New contact but unable to get avatar data, skipping avatar attachment`);
                }
            } catch (error) {
                console.warn('[Auto Signaling] Failed to get avatar:', error.message);
            }
        } else {
            console.log(`🖼️ [Auto Signaling] Not a new contact, Discover email will not attach avatar`);
        }
        
        const body = JSON.stringify({
            type: 'discover',
            version: '1.0',
            content: '00000',
            senderName: senderName,
            messageId: `discover-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            unsentMessages: [],
            autoTriggered: true, // Mark as auto-triggered
            avatarAttachment: avatarAttachment
        });
        
        if (window.electronAPI && window.electronAPI.sendemail) {
            await window.electronAPI.sendemail(config, {
                to: toEmail,
                subject: subject,
                text: body,
                attachments: attachments
            });
            console.log(`✅ [Auto Signaling] Discover email sent: ${myEmail} -> ${toEmail}`);
            
            // Confirm avatar has been sent (using the new persistent storage mechanism)
            if (avatarAttachment) {
                if (window.newContactStorage && window.newContactStorage.confirmAvatarSent) {
                    window.newContactStorage.confirmAvatarSent(toEmail, true);
                    console.log(`🗑️ [Auto Signaling] Avatar send confirmed, removing mark: ${toEmail}`);
                } else if (window._newContactMap) {
                    // Backward compatibility
                    window._newContactMap.delete(toEmail);
                    console.log(`🗑️ [Auto Signaling] Removed new contact mark (compatibility mode): ${toEmail}`);
                }
            }
            
            if (window.showStatus) {
                window.showStatus(window.i18n?.t('chat.autoSignalSent') || 'Auto-sent connection request to new contact', 'success');
            }
        } else {
            console.warn('[Auto Signaling] electronAPI.sendemail not available');
        }
    } catch (error) {
        console.error('[Auto Signaling] Failed to send Discover email:', error);
        
        // Send failed, update avatar send status (using the new persistent storage mechanism)
        if (avatarAttachment) {
            if (window.newContactStorage && window.newContactStorage.confirmAvatarSent) {
                window.newContactStorage.confirmAvatarSent(toEmail, false);  // false indicates send failure
                console.log(`⚠️ [Auto Signaling] Discover email send failed, avatar mark retained for retry: ${toEmail}`);
            }
        }
    }
}

/**
 * Get current user's avatar data
 * @returns {Object|null} Avatar data object {data: base64/svg string, mimeType: string, size: number} or null
 */
function _getMyAvatarData() {
    try {
        let avatar = null;
        
        // Priority 1: check user-configured avatar
        if (typeof window.getSelectedConfig === 'function') {
            const selectedConfig = window.getSelectedConfig();
            if (selectedConfig && selectedConfig.avatar) {
                avatar = selectedConfig.avatar;
            }
        }
        
        // Priority 2: check locally stored avatar
        if (!avatar) {
            const storedConfig = localStorage.getItem('userConfig');
            if (storedConfig) {
                const config = JSON.parse(storedConfig);
                if (config.avatar) {
                    avatar = config.avatar;
                }
            }
        }
        
        if (!avatar) {
            return null;
        }
        
        const rawAvatar = String(avatar).trim();
        
        // If it is a Base64 image in data:image format
        if (rawAvatar.startsWith('data:image')) {
            const mimeMatch = rawAvatar.match(/data:([^;]+);base64,/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
            const base64Data = rawAvatar.split(',')[1];
            const size = base64Data ? Math.ceil(base64Data.length * 0.75) : 0;
            
            return {
                data: rawAvatar,
                mimeType: mimeType,
                size: size,
                isBase64: true
            };
        }
        
        // If it is SVG, convert to data:image/svg+xml format
        if (rawAvatar.startsWith('<svg')) {
            const svgData = encodeURIComponent(rawAvatar);
            const dataUrl = `data:image/svg+xml;charset=utf-8,${svgData}`;
            return {
                data: dataUrl,
                mimeType: 'image/svg+xml',
                size: rawAvatar.length,
                isBase64: false
            };
        }
        
        return null;
    } catch (e) {
        console.error('Failed to get avatar data:', e.message);
        return null;
    }
}

/**
 * Generate random ID
 */
function _generateRandomId() {
    return Math.random().toString(36).substring(2, 10);
}

/**
 * Get file extension
 */
function _getFileExtension(mimeType) {
    const mimeToExt = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/svg+xml': 'svg'
    };
    return mimeToExt[mimeType] || 'png';
}
