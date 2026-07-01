import { sendLogToParent, generateWebRTCSignalSubject, deler } from './utils.js';
import { showStatus, htmlToPlainText } from './ui.js';
import { DISCOVER_RETRY_CONFIG, DISCOVER_REPLY_RETRY_CONFIG, DISCOVER_DEDUP_CONFIG, DISCOVER_MESSAGE_ID_CONFIG, MIN_TRIGGER_INTERVAL } from './constants.js';
import { isValidEmail, updateMessageStatus } from '../../utils/index.js';
import { SIGNALING_EMAIL_PREFIX } from '../../../shared/config/signaling-constants.js';
import { getUnsentMessagesForEmail, getLastUnsentTextMessage, extractFileNameFromContent } from '../../utils/message-utils.js';

export const discoverEmailStatus = new Map();
const discoverSendLocks = new Map();
const discoverPendingQueue = new Map();
let discoverSendDebounceTimer = null;
let discoverLastSendTime = 0;
let lastTriggerSendOfferTime = 0;
let globalDiscoverSending = false;
let globalDiscoverSendQueue = [];

function getCurrentMyEmail() {
    return window.selectedConfig?.username || '';
}

/**
 * Get current user's avatar data
 * @returns {Object|null} Avatar data object {data: base64/svg string, mimeType: string, size: number} or null
 */
function getMyAvatarData() {
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
        sendLogToParent(`Failed to get avatar data: ${e.message}`, 'error');
        return null;
    }
}

/**
 * Generate random ID
 */
function generateRandomId() {
    return Math.random().toString(36).substring(2, 10);
}

/**
 * Get file extension
 */
function getFileExtension(mimeType) {
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

function generateUniqueMessageId() {
    DISCOVER_MESSAGE_ID_CONFIG.counter = (DISCOVER_MESSAGE_ID_CONFIG.counter + 1) % 1000000;
    const timestamp = Date.now();
    const counterStr = DISCOVER_MESSAGE_ID_CONFIG.counter.toString(36).padStart(4, '0');
    const random = Math.random().toString(36).substring(2, 6);
    return `discover-${timestamp}-${random}-${counterStr}`;
}

function checkAndAddToPendingQueue(to, subject, data) {
    const key = `${to}_${subject}`;
    const now = Date.now();
    const existing = discoverPendingQueue.get(key);
    
    if (existing) {
        if (now - existing.timestamp < DISCOVER_DEDUP_CONFIG.debounceDelay * 3) {
            sendLogToParent(`⏭️  Found duplicateDiscoverSend request，Merged: ${to}`);
            return false;
        }
    }
    
    discoverPendingQueue.set(key, { timestamp: now, data });
    return true;
}

async function processPendingDiscoverEmails() {
    const now = Date.now();
    discoverSendDebounceTimer = null;
    
    if (now - discoverLastSendTime < DISCOVER_DEDUP_CONFIG.debounceDelay) {
        return;
    }
    
    const pendingEntries = Array.from(discoverPendingQueue.entries());
    discoverPendingQueue.clear();
    
    for (const [key, entry] of pendingEntries) {
        const [to, subject] = key.split('_');
        
        // Add role validation
        const myEmail = getCurrentMyEmail();
        if (myEmail && to && myEmail < to) {
            sendLogToParent(`optimize: I am Sender (${myEmail} < ${to})，skip discover email，generate directly Offer`);
            sendLogToParent('📤 ready to sendtriggerSendOffermessage，toEmail: ' + to);
            window.parent.postMessage({
                type: 'triggerSendOffer',
                toEmail: to
            }, '*');
            sendLogToParent('✅ triggerSendOffermessage sent');
            continue; // Skip this iteration
        }
        
        try {
            await sendDiscoverEmailWithRetryInternal(entry.data.config, {
                to: to,
                subject: subject,
                text: entry.data.text,
                attachments: entry.data.attachments
            });
            discoverLastSendTime = Date.now();
        } catch (error) {
            sendLogToParent(`❌ sendDiscoverMail failed: ${error.message}`, 'error');
        }
    }
}

export async function sendemail(event) {
    if (event) event.preventDefault();

    if (!document.getElementById('subject').value) {
        generateWebRTCSignalSubject();
    }

    let selectedCard = document.querySelector('.contact-card.selected');
    let to = selectedCard ? selectedCard.dataset.value : '';

    if (!to && typeof window.currentSelectedContactEmail !== 'undefined') {
        to = window.currentSelectedContactEmail;
    }

    const subject = document.getElementById('subject').value;
    let body = document.getElementById('body').value;

    if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {
        const discoverKey = `discover_${to}_${subject}`;
        const now = Date.now();
        
        if (globalDiscoverSending) {
            const existingInQueue = globalDiscoverSendQueue.find(item => 
                item.key === discoverKey && (now - item.timestamp < 3000)
            );
            if (existingInQueue) {
                sendLogToParent(`⏭️  Discover Mail already in send queue，Skip duplicate request: ${to}`);
                return;
            }
            globalDiscoverSendQueue.push({ key: discoverKey, timestamp: now });
            sendLogToParent(`📋 Discover Mail added to send queue: ${to}，Current queue length: ${globalDiscoverSendQueue.length}`);
            return;
        }
        
        globalDiscoverSending = true;
        const myEmail = getCurrentMyEmail();
        let senderName = myEmail.split('@')[0];
        try {
            const currentConfig = window.parent.getSelectedConfig();
            if (currentConfig && currentConfig.name) {
                senderName = currentConfig.name.split(' (')[0];
            }
        } catch (e) {
            sendLogToParent('failed to get config name，use default name: ' + senderName);
        }
        const unsentMessages = await getUnsentMessagesForEmail(to);

        // Removed Discover email image attachment feature; images are now transmitted via WebRTC data channel
        const attachments = [];

        // Get the last unsent plain-text message to carry in the signaling email
        const lastTextMsg = await getLastUnsentTextMessage(to);
        const carryTextMessage = lastTextMsg ? {
            id: lastTextMsg.id,
            content: lastTextMsg.content,
            timestamp: lastTextMsg.timestamp
        } : null;
        
        if (carryTextMessage) {
            sendLogToParent(`📋 Discover Mail carries text message: ${carryTextMessage.id}`);
        }

        // Get user avatar and add to attachments (only sent in first Discover email to new contact)
        let avatarAttachment = null;
        let shouldAttachAvatar = false;
        
        // Check if it is a new contact (using the new persistent storage mechanism)
        // Prefer newContactStorage; fall back to _newContactMap if not available
        if (window.newContactStorage && window.newContactStorage.isNewContact) {
            shouldAttachAvatar = window.newContactStorage.isNewContact(to);
        } else {
            // Backward compatibility
            shouldAttachAvatar = window._newContactMap && window._newContactMap.get(to);
        }
        
        if (shouldAttachAvatar) {
            const myAvatarData = getMyAvatarData();
            if (myAvatarData) {
                const avatarExt = getFileExtension(myAvatarData.mimeType);
                const avatarFilename = `myavatar_${generateRandomId()}.${avatarExt}`;
                const avatarCid = `avatar_${Date.now()}_${generateRandomId()}`;
                
                // Convert avatar data to base64 string (browser-compatible way)
                let avatarContent;
                if (myAvatarData.isBase64) {
                    // Pass base64 data directly (strip data:image/xxx;base64, prefix)
                    avatarContent = myAvatarData.data.split(',')[1];
                } else {
                    // SVG or other formats, use directly
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
                
                sendLogToParent(`🖼️ Discover Mail attaches avatar: ${avatarFilename} (${myAvatarData.mimeType})`);
            } else {
                sendLogToParent(`⚠️ Is new contact but unable to get avatar data，Skip attaching avatar`);
            }
        } else {
            sendLogToParent(`🖼️ Not a new contact，Discover Mail does not attach avatar`);
        }

        body = {
            body: JSON.stringify({
                type: 'discover',
                version: '1.0',
                content: '00000',
                senderName: senderName,
                messageId: generateUniqueMessageId(),
                unsentMessages: unsentMessages,
                carryTextMessage: carryTextMessage,
                avatarAttachment: avatarAttachment
            }),
            attachments: attachments
        };
    }

    deler(to);

    if (!to) {
        showStatus(window.i18n?.t ? window.i18n.t('errors.pleaseSelectValidFriend') : 'please select a valid contact', 'error');
        return;
    }

    if (!isValidEmail(to)) {
        showStatus(window.i18n?.t ? window.i18n.t('errors.pleaseEnterValidEmail') : 'please enter a valid email address', 'error');
        return;
    }

    if (!subject) {
        showStatus(window.i18n?.t ? window.i18n.t('errors.pleaseFillSubject') : 'please enter email subject', 'error');
        return;
    }

    try {
        if (!window.parent.electronAPI || typeof window.parent.electronAPI.sendemail !== 'function') {
            throw new Error('Electron API not available');
        }

        const config = window.parent.getSelectedConfig();

        sendLogToParent('Current config: ' + JSON.stringify(config));

        if (!config) {
            const errorMsg = window.i18n?.t ? window.i18n.t('errors.pleaseSelectAndLoginConfig') : 'please select and log in to an email config first';
            sendLogToParent('❌ failed to send：' + errorMsg, 'error');
            showStatus(errorMsg, 'error');
            window.parent.postMessage({
                type: 'showConfigSelectionPrompt'
            }, '*');
            throw new Error(errorMsg);
        }

        let result;
        if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {
            // body is now an object containing { body, attachments }
            result = await sendDiscoverEmailWithRetry(config, { 
                to, 
                subject, 
                text: body.body, 
                attachments: body.attachments 
            });
        } else {
            result = await window.parent.electronAPI.sendemail(config, {
                to: to,
                subject: subject,
                text: typeof body === 'object' ? body.body : body,
                attachments: typeof body === 'object' ? body.attachments : []
            });
        }

        sendLogToParent('sent successfully', 'success');

        // Update status of unsent messages
        if (subject.startsWith(SIGNALING_EMAIL_PREFIX) && typeof body === 'object' && body.body) {
            try {
                const parsedBody = JSON.parse(body.body);
                if (parsedBody.unsentMessages && parsedBody.unsentMessages.length > 0) {
                    const msgIds = parsedBody.unsentMessages.map(m => m.id);
                    sendLogToParent(`📝 Updating ${msgIds.length} message(s) status updated to delivered...`);
                    
                    if (window.parent && window.parent.electronAPI && window.parent.electronAPI.updateChatMessageStatus) {
                        for (const id of msgIds) {
                            await window.parent.electronAPI.updateChatMessageStatus(id, 100);
                        }
                        sendLogToParent('✅ Message status updated successfully');
                    }
                }
            } catch (e) {
                sendLogToParent('failed to update message status: ' + e.message);
            }
        }

        if (!subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {
            let preview = htmlToPlainText(body);
            if (!preview) {
                preview = '[Image mail]';
            }

            try {
                if (window.parent && window.parent.electronAPI && window.parent.electronAPI.saveChatMessage) {
                    const myEmail = config.username || getCurrentMyEmail() || '';
                    if (myEmail && to) {
                        await window.parent.electronAPI.saveChatMessage({
                            fromer: myEmail,
                            toer: to,
                            content: preview,
                            type: 1,
                            status: 100,
                            msgid: ''
                        });
                    }
                }
            } catch (e) {
                sendLogToParent('Failed to save mail to chat history: ' + e.message);
            }

            window.parent.postMessage({
                type: 'updateContactLastMessage',
                email: to,
                message: preview
            }, '*');
        }

        document.getElementById('subject').value = '';
        document.getElementById('body').value = '';

        sendLogToParent('Email sent successfully: ' + JSON.stringify(result));
        
        if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {
            // Delay releasing the lock to ensure all pending requests complete
            setTimeout(() => {
                globalDiscoverSending = false;
                sendLogToParent('🔓 Discover Mail send completed，delayed release of global lock');
                
                // Process requests in queue
                if (globalDiscoverSendQueue.length > 0) {
                    sendLogToParent(`📋 Check pending requests in queue，Remaining: ${globalDiscoverSendQueue.length}`);
                    globalDiscoverSendQueue = globalDiscoverSendQueue.filter(
                        item => Date.now() - item.timestamp < 10000 // Keep requests within 10 seconds
                    );
                    
                    if (globalDiscoverSendQueue.length > 0) {
                        sendLogToParent(`📋 Queue still has ${globalDiscoverSendQueue.length} pending request(s)`);
                        // Auto queue processing logic can be added here
                    }
                }
            }, 5000); // Release lock after 5 seconds
        }
    } catch (error) {
        sendLogToParent('Email send failed: ' + error, 'error');
        sendLogToParent('failed to send email: ' + error.message, 'error');
        
        if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {
            // Also delay releasing lock on failure
            setTimeout(() => {
                globalDiscoverSending = false;
                sendLogToParent('🔓 Discover failed to send email，delayed release of global lock');
            }, 5000);
        }
    }
}

/**
 * Get unsent messages for a specific contact (migrated to message-utils.js)
 * Keep this function for compatibility; internally uses the new utility function
 * @param {string} toEmail - Recipient email
 * @returns {Promise<Array>} Unsent message array
 */
export async function getUnsentMessagesForEmail(toEmail) {
    // Use the new utility function while keeping the original interface compatible
    return await getUnsentMessagesForEmail(toEmail, {
        maxRetries: 2,
        retryDelay: 1000,
        logger: sendLogToParent
    });
}

export async function sendDiscoverEmailWithRetry(config, emailData) {
    const { to, subject, text, attachments } = emailData;
    
    const lockKey = `${to}_${subject}`;
    const now = Date.now();
    
    const existingLock = discoverSendLocks.get(lockKey);
    if (existingLock) {
        if (now - existingLock.timestamp < DISCOVER_DEDUP_CONFIG.lockTimeout) {
            sendLogToParent(`⏭️  skip duplicate send: Same already existsdiscoverMail is sending (${to})`);
            return { duplicate: true, message: 'Duplicate send skipped' };
        }
        discoverSendLocks.delete(lockKey);
    }
    
    const canQueue = checkAndAddToPendingQueue(to, subject, { config, text, attachments });
    if (!canQueue) {
        return { duplicate: true, message: 'Request merged with existing pending' };
    }
    
    if (discoverSendDebounceTimer) {
        clearTimeout(discoverSendDebounceTimer);
    }
    
    discoverSendDebounceTimer = setTimeout(() => {
        processPendingDiscoverEmails();
    }, DISCOVER_DEDUP_CONFIG.debounceDelay);
    
    return { queued: true, message: 'Request queued for sending' };
}

async function sendDiscoverEmailWithRetryInternal(config, emailData) {
    const { to, subject, text, attachments } = emailData;
    let retryCount = 0;
    let lastError = null;

    const lockKey = `${to}_${subject}`;
    const now = Date.now();
    
    const existingLock = discoverSendLocks.get(lockKey);
    if (existingLock) {
        if (now - existingLock.timestamp < DISCOVER_DEDUP_CONFIG.lockTimeout) {
            sendLogToParent(`⏭️  skip duplicate send: Lock still valid (${to})`);
            return { duplicate: true, message: 'Lock still active' };
        }
        discoverSendLocks.delete(lockKey);
    }
    
    discoverSendLocks.set(lockKey, { timestamp: now, state: 'sending' });

    try {
        const currentStatus = discoverEmailStatus.get(to);
        discoverEmailStatus.set(to, {
            status: 'sending',
            retryCount: 0,
            discoverRetryCount: currentStatus?.discoverRetryCount || 0,
            lastSendTime: now,
            messageId: JSON.parse(text).messageId,
            replyTimeout: now + DISCOVER_REPLY_RETRY_CONFIG.replyTimeout
        });

    const sendWithTimeout = async () => {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Send timeout (${DISCOVER_RETRY_CONFIG.timeout}ms)`));
            }, DISCOVER_RETRY_CONFIG.timeout);
        });

        const sendPromise = window.parent.electronAPI.sendemail(config, {
            to: to,
            subject: subject,
            text: text,
            attachments: attachments || []
        });

        return Promise.race([sendPromise, timeoutPromise]);
    };

    while (retryCount <= DISCOVER_RETRY_CONFIG.maxRetries) {
        try {
            sendLogToParent(`📤 senddiscoveremail (No. ${retryCount + 1}/${DISCOVER_RETRY_CONFIG.maxRetries + 1} times): to ${to}`);

            const result = await sendWithTimeout();

            const currentStatus = discoverEmailStatus.get(to);
            discoverEmailStatus.set(to, {
                status: 'sent',
                retryCount: retryCount,
                discoverRetryCount: currentStatus?.discoverRetryCount || 0,
                lastSendTime: Date.now(),
                messageId: JSON.parse(text).messageId,
                replyTimeout: Date.now() + DISCOVER_REPLY_RETRY_CONFIG.replyTimeout
            });

            sendLogToParent(`✅ discoveremail sent successfully (No. ${retryCount + 1} times): to ${to}`, 'success');

            // Confirm avatar has been sent (using the new persistent storage mechanism)
            try {
                const parsedBody = JSON.parse(text);
                if (parsedBody.avatarAttachment) {
                    if (window.newContactStorage && window.newContactStorage.confirmAvatarSent) {
                        window.newContactStorage.confirmAvatarSent(to, true);
                        sendLogToParent(`🗑️ Avatar send success confirmed，remove mark: ${to}`);
                    } else if (window._newContactMap) {
                        // Backward compatibility
                        window._newContactMap.delete(to);
                        sendLogToParent(`🗑️ New contact flag removed(compatibility mode): ${to}`);
                    }
                }
            } catch (e) {
                sendLogToParent('failed to confirm avatar send status: ' + e.message);
            }

            try {
                const parsedBody = JSON.parse(text);
                if (parsedBody.unsentMessages && parsedBody.unsentMessages.length > 0) {
                    const myEmail = (config && (config.username || config.user)) || getCurrentMyEmail() || '';
                    if (myEmail) {
                        let chatWindow = null;

                        if (window.parent.activeChatWebcom && window.parent.activeChatWebcom.contentWindow) {
                            chatWindow = window.parent.activeChatWebcom.contentWindow;
                        }

                        if (!chatWindow && window.parent.document && to) {
                            const webcomId = 'chat_' + to;
                            const chatWebcom = window.parent.document.getElementById(webcomId);
                            if (chatWebcom && chatWebcom.contentWindow) {
                                chatWindow = chatWebcom.contentWindow;
                            }
                        }

                        for (const msg of parsedBody.unsentMessages) {
                            if (!msg || !msg.content) continue;

                            const mimeMatch = msg.content.match(/data-mime-type="([^"]+)"/);
                            const isImage = mimeMatch && mimeMatch[1] && mimeMatch[1].startsWith('image/');
                            if (!isImage) continue;

                            const idMatch = msg.content.match(/id="file-status-([^"]+)"/);
                            const transferId = idMatch ? idMatch[1] : null;

                            const msgId = transferId || msg.id;

                            // Use unified state management function
                            await updateMessageStatus(msgId, 100, {
                                fromer: myEmail,
                                retry: true,
                                maxRetries: 2
                            });

                            if (transferId && chatWindow) {
                                if (chatWindow.markMessageAsConfirmed) {
                                    await chatWindow.markMessageAsConfirmed(transferId);
                                } else if (chatWindow._webp2pUI && chatWindow._webp2pUI.markMessageAsConfirmed) {
                                    await chatWindow._webp2pUI.markMessageAsConfirmed(transferId);
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                sendLogToParent('viadiscoverFailed to update image message status: ' + e.message);
            }

            discoverSendLocks.delete(lockKey);
            return result;
        } catch (error) {
            lastError = error;
            retryCount++;

            sendLogToParent(`❌ discoverfailed to send email (No. ${retryCount} times): ${error.message}`, 'error');

            const currentStatus = discoverEmailStatus.get(to);
            if (currentStatus) {
                discoverEmailStatus.set(to, {
                    ...currentStatus,
                    retryCount: retryCount,
                    lastSendTime: Date.now()
                });
            }

            if (retryCount <= DISCOVER_RETRY_CONFIG.maxRetries) {
                sendLogToParent(`⏱️  ${DISCOVER_RETRY_CONFIG.retryDelay}ms Retry after...`);
                await new Promise(resolve => setTimeout(resolve, DISCOVER_RETRY_CONFIG.retryDelay));
            }
        }
    } finally {
        discoverSendLocks.delete(lockKey);
    }

    discoverEmailStatus.set(to, {
        status: 'failed',
        retryCount: retryCount,
        lastSendTime: Date.now(),
        error: lastError.message,
        messageId: JSON.parse(text).messageId
    });

    // Send failed, update avatar send status (using the new persistent storage mechanism)
    try {
        const parsedBody = JSON.parse(text);
        if (parsedBody.avatarAttachment) {
            if (window.newContactStorage && window.newContactStorage.confirmAvatarSent) {
                window.newContactStorage.confirmAvatarSent(to, false);  // false indicates send failure
                sendLogToParent(`⚠️ Discoverfailed to send email，Avatar flag retained for retry: ${to}`);
            }
        }
    } catch (e) {
        sendLogToParent('Failed to process avatar send failure status: ' + e.message);
    }

    sendLogToParent(`❌ discoverfailed to send email，maximum retry count reached (${DISCOVER_RETRY_CONFIG.maxRetries}times): ${lastError.message}`, 'error');
    throw lastError;
}

export function checkDiscoverReplyTimeout() {
    const now = Date.now();

    for (const [email, status] of discoverEmailStatus.entries()) {
        if (status.status === 'sent' && now > status.replyTimeout) {
            handleDiscoverReplyTimeout(email, status);
        }
    }

    setTimeout(checkDiscoverReplyTimeout, 1000);
}

export async function handleDiscoverReplyTimeout(email, status) {
    if (status.discoverRetryCount >= DISCOVER_REPLY_RETRY_CONFIG.maxDiscoverRetries) {
        sendLogToParent(`❌ discoveremail reply timeout，maximum retry count reached (${DISCOVER_REPLY_RETRY_CONFIG.maxDiscoverRetries}times): to ${email}`, 'error');
        discoverEmailStatus.set(email, {
            ...status,
            status: 'failed',
            error: `Discover reply timeout after ${DISCOVER_REPLY_RETRY_CONFIG.maxDiscoverRetries} retries`
        });
        return;
    }

    sendLogToParent(`⏱️ discoveremail reply timeout (${DISCOVER_REPLY_RETRY_CONFIG.replyTimeout}ms)，Prepare to resend (No. ${status.discoverRetryCount + 1} times): to ${email}`);

    discoverEmailStatus.set(email, {
        ...status,
        discoverRetryCount: status.discoverRetryCount + 1,
        status: 'sending',
        lastSendTime: Date.now(),
        replyTimeout: Date.now() + DISCOVER_REPLY_RETRY_CONFIG.replyTimeout
    });

    await new Promise(resolve => setTimeout(resolve, DISCOVER_REPLY_RETRY_CONFIG.discoverRetryDelay));

    generateWebRTCSignalSubject();

    const subject = document.getElementById('subject').value;
    let body = document.getElementById('body').value;

    const myEmail = getCurrentMyEmail();
    
    if (!myEmail) {
        sendLogToParent('❌ cannot get current user email，Unable to process discover Mail timeout', 'error');
        return;
    }
    
    const isPolite = myEmail > email;
    
    if (!isPolite) {
        sendLogToParent(`⚠️ Role intercepted: I am Sender (${myEmail} < ${email})，Should not resend discover email，Switch to trigger Sender Process send Offer`);
        discoverEmailStatus.set(email, {
            ...status,
            status: 'converted_to_sender',
            convertedTime: Date.now()
        });
        window.parent.postMessage({
            type: 'triggerSendOffer',
            toEmail: email
        }, '*');
        return;
    }
    
    sendLogToParent(`✅ Role validation passed: I am Receiver (${myEmail} > ${email})，Resend allowed discover`);
    
    let senderName = myEmail.split('@')[0];
    try {
        const currentConfig = window.parent.getSelectedConfig();
        if (currentConfig && currentConfig.name) {
            senderName = currentConfig.name.split(' (')[0];
        }
    } catch (e) {
        sendLogToParent('failed to get config name，use default name: ' + senderName);
    }

    const unsentMessages = await getUnsentMessagesForEmail(email);

    // Extract image attachments from unsent messages; logic consistent with first discover send
    const attachments = [];
    if (unsentMessages && unsentMessages.length > 0) {
        unsentMessages.forEach(msg => {
            const match = msg.content.match(/data-copied-path="([^"]+)"/);
            const mimeMatch = msg.content.match(/data-mime-type="([^"]+)"/);
            
            if (match && match[1] && mimeMatch && mimeMatch[1].startsWith('image/')) {
                // Fix: ensure CID is not empty, use msg.id or generate a random CID
                const cid = msg.id ? String(msg.id) : `attachment_${Date.now()}_${generateRandomId()}`;
                attachments.push({
                    filename: msg.content.match(/<div class="file-name">([^<]+)<\/div>/)?.[1] || 'image.png',
                    path: match[1],
                    cid: cid
                });
                sendLogToParent(`📎 Add attachment CID: ${cid}, filename: ${attachments[attachments.length - 1].filename}`);
            }
        });
        if (attachments.length > 0) {
            sendLogToParent(`📋 Discover Retry extract to ${attachments.length} attachment(s)`);
        }
    }

    // Get the last unsent plain-text message to carry in the signaling email
    const lastTextMsg = await getLastUnsentTextMessage(email);
    const carryTextMessage = lastTextMsg ? {
        id: lastTextMsg.id,
        content: lastTextMsg.content,
        timestamp: lastTextMsg.timestamp
    } : null;
    
    if (carryTextMessage) {
        sendLogToParent(`📋 Discover Retry mail carries text message: ${carryTextMessage.id}`);
    }

    body = JSON.stringify({
        type: 'discover',
        version: '1.0',
        content: '00000',
        senderName: senderName,
        messageId: generateUniqueMessageId(),
        unsentMessages: unsentMessages,
        carryTextMessage: carryTextMessage
    });

    const config = window.parent.getSelectedConfig();

    await sendDiscoverEmailWithRetry(config, { to: email, subject: subject, text: body, attachments });
}

export function handleDiscoverEmailConfirmed(email) {
    if (email) {
        const currentStatus = discoverEmailStatus.get(email);
        if (currentStatus) {
            discoverEmailStatus.set(email, {
                ...currentStatus,
                status: 'confirmed',
                confirmedTime: Date.now()
            });
            sendLogToParent(`✅ discoverMail receipt confirmed: ${email}`, 'success');
        }
    }
}

/**
 * Get the last unsent plain text message for a specific contact
 * @param {string} toEmail - Recipient email
 * @returns {Promise<Object|null>} Last unsent text message or null
 */
async function getLastUnsentTextMessage(toEmail) {
    const myEmail = getCurrentMyEmail();
    if (!myEmail || !toEmail) return null;
    
    if (window.parent && window.parent.electronAPI && window.parent.electronAPI.getUnsentMessages) {
        try {
            const params = { fromer: myEmail, toer: toEmail };
            const messages = await window.parent.electronAPI.getUnsentMessages(params);
            
            // Filter out plain text messages (status < 100 means unsent)
            // Exclude messages containing images or files
            const textMessages = messages
                .filter(msg => {
                    if (msg.status >= 100) return false;  // Exclude already sent messages
                    
                    const content = msg.content || '';
                    // Exclude image messages: check if contains img tag, data-image, or file-related elements
                    if (content.includes('<img') || 
                        content.includes('data-image-') ||
                        content.includes('file-request-') ||
                        content.includes('data-copied-path')) {
                        return false;
                    }
                    return true;
                });
            
            // Sort by id and take the last one
            if (textMessages.length > 0) {
                textMessages.sort((a, b) => (b.id || 0) - (a.id || 0));
                const lastMsg = textMessages[0];
                return {
                    id: lastMsg.msgid || lastMsg.id,
                    content: lastMsg.content,
                    timestamp: lastMsg.createtime || lastMsg.timestamp || Date.now()
                };
            }
        } catch (error) {
            console.error('failed to get unsent text messages:', error);
            sendLogToParent('failed to get unsent text messages: ' + error.message);
        }
    }
    return null;
}
