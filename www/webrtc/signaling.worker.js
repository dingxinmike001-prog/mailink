
// Signaling email prefix constant (keep in sync with shared/config/signaling-constants.js)
const SIGNALING_EMAIL_PREFIX = 'WebRTC-SIGNAL-';

class LRUCache {
    constructor(maxSize = 1000, maxAge = 5 * 60 * 1000) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.maxAge = maxAge;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }

        this.cache.set(key, { value, timestamp: Date.now() });
    }

    has(key) {
        const entry = this.cache.get(key);
        if (!entry) return false;

        if (Date.now() - entry.timestamp > this.maxAge) {
            this.cache.delete(key);
            return false;
        }

        const value = entry.value;
        this.cache.delete(key);
        this.cache.set(key, { value, timestamp: Date.now() });

        return true;
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        if (Date.now() - entry.timestamp > this.maxAge) {
            this.cache.delete(key);
            return undefined;
        }

        const value = entry.value;
        this.cache.delete(key);
        this.cache.set(key, { value, timestamp: Date.now() });

        return value;
    }

    delete(key) {
        this.cache.delete(key);
    }
}

const processedEmailIds = new LRUCache(1000, 5 * 60 * 1000);

let currentMyEmail = null;

const errorStats = {
    totalErrors: 0,
    errorTypes: {},
    lastErrorTime: null,
    retryCount: 0,
    invalidSignals: 0,
    processingFailed: 0,
    parsingFailed: 0
};

function reportHealthStatus() {
    return {
        timestamp: Date.now(),
        errorStats: {
            totalErrors: errorStats.totalErrors,
            errorTypes: { ...errorStats.errorTypes },
            lastErrorTime: errorStats.lastErrorTime,
            retryCount: errorStats.retryCount,
            invalidSignals: errorStats.invalidSignals,
            processingFailed: errorStats.processingFailed,
            parsingFailed: errorStats.parsingFailed
        },
        cacheStatus: {
            currentSize: processedEmailIds.cache.size,
            maxSize: processedEmailIds.maxSize,
            maxAge: processedEmailIds.maxAge
        },
        workerStatus: {
            isRunning: true,
            uptime: Date.now() - self.startTime || 0
        }
    };
}

self.startTime = Date.now();

// Unified email validation function (consistent with common.js)
function isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Unified role parsing function (consistent with common.js)
function resolveRole(myEmail, targetEmail) {
    const trimmedMyEmail = typeof myEmail === 'string' ? myEmail.trim() : '';
    const trimmedTargetEmail = typeof targetEmail === 'string' ? targetEmail.trim() : '';
    const valid = !!trimmedMyEmail && !!trimmedTargetEmail;

    if (!valid) {
        return {
            myEmail: trimmedMyEmail,
            targetEmail: trimmedTargetEmail,
            polite: true,
            role: 'unknown',
            valid: false,
            reason: 'Email information incomplete'
        };
    }

    if (trimmedMyEmail === trimmedTargetEmail) {
        return {
            myEmail: trimmedMyEmail,
            targetEmail: trimmedTargetEmail,
            polite: false,
            role: 'same',
            valid: true,
            reason: 'Same email address'
        };
    }

    const polite = trimmedMyEmail > trimmedTargetEmail;
    const role = trimmedMyEmail < trimmedTargetEmail ? 'sender' : 'receiver';
    return {
        myEmail: trimmedMyEmail,
        targetEmail: trimmedTargetEmail,
        polite,
        role,
        valid: true,
        reason: polite
            ? `${trimmedMyEmail} > ${trimmedTargetEmail}, I am Receiver (Polite Peer)`
            : `${trimmedMyEmail} < ${trimmedTargetEmail}, I am Sender (Impolite Peer)`
    };
}

function isSender(myEmail, targetEmail) {
    const roleInfo = resolveRole(myEmail, targetEmail);
    return roleInfo.valid && roleInfo.role === 'sender';
}

function isReceiver(myEmail, targetEmail) {
    const roleInfo = resolveRole(myEmail, targetEmail);
    return roleInfo.valid && roleInfo.role === 'receiver';
}

function validateSignalingEmail(email) {
    if (!email || typeof email !== 'object') {
        errorStats.invalidSignals++;
        console.log(`[Signaling Worker] ❌ Email validation failed: invalid email structure - sender: ${email?.from || 'unknown'}, subject: ${email?.subject || 'no subject'}`);
        return { valid: false, reason: 'Invalid email structure' };
    }

    if (!email.subject || typeof email.subject !== 'string') {
        errorStats.invalidSignals++;
        console.log(`[Signaling Worker] ❌ Email validation failed: missing or invalid subject field - sender: ${email.from || 'unknown'}`);
        return { valid: false, reason: 'Missing or invalid subject' };
    }

    if (!email.from || typeof email.from !== 'string') {
        errorStats.invalidSignals++;
        console.log(`[Signaling Worker] ❌ Email validation failed: missing or invalid sender address - subject: ${email.subject || 'no subject'}`);
        return { valid: false, reason: 'Missing or invalid from address' };
    }

    if (!email.subject.startsWith(SIGNALING_EMAIL_PREFIX)) {
        console.log(`[Signaling Worker] ⏭️  Skipping non-signaling email - sender: ${email.from}, subject: ${email.subject}`);
        return { valid: false, reason: 'Not a WebRTC signaling email' };
    }

    if (email.text === undefined || email.text === null) {
        email.text = '';
    }

    if (email.date) {
        const emailDate = new Date(email.date);
        if (isNaN(emailDate.getTime())) {
            errorStats.invalidSignals++;
            console.log(`[Signaling Worker] ❌ Email validation failed: invalid date format - sender: ${email.from}, subject: ${email.subject}, date: ${email.date}`);
            return { valid: false, reason: 'Invalid date format' };
        }

        const endTime = email.receivedDate ? new Date(email.receivedDate) : new Date(email.date.getTime() + 60000);
        
        const now = new Date();
        const emailEndTime = endTime;
        
        if (now > emailEndTime) {
            const diffSeconds = (now - emailDate) / 1000;
            console.log(`[Signaling Worker] ❌ Email validation failed: signaling email too old - sender: ${email.from}, subject: ${email.subject}, sent time: ${email.date}, valid until: ${emailEndTime.toISOString()}, delay: ${diffSeconds.toFixed(2)}s`);
            return { valid: false, reason: 'Signaling email too old' };
        }
    }

    return { valid: true };
}

function parseSignalingContent(email) {
    let content = null;
    let senderName = email.from.split('@')[0];
    let unsentMessages = [];
    let attachments = email.attachments || [];
    let carryTextMessage = null;
    let avatarAttachment = null;
    let avatarData = null;

    try {
        content = JSON.parse(email.text);
        if (content) {
            if (content.senderName) senderName = content.senderName;
            if (content.unsentMessages) unsentMessages = content.unsentMessages;
            if (content.carryTextMessage) carryTextMessage = content.carryTextMessage;
            if (content.avatarAttachment) avatarAttachment = content.avatarAttachment;
        }
    } catch (e) {
        errorStats.parsingFailed++;
    }
    
    // Handle avatar attachments (prefixed with myavatar_)
    if (avatarAttachment) {
        const avatarAtt = attachments.find(att => 
            att.filename === avatarAttachment.filename || 
            (att.filename && att.filename.startsWith('myavatar_'))
        );
        if (avatarAtt) {
            avatarData = {
                filename: avatarAtt.filename,
                content: avatarAtt.content,
                mimeType: avatarAttachment.mimeType || avatarAtt.mimeType || 'image/png',
                size: avatarAttachment.size || avatarAtt.content?.length || 0
            };
            console.log(`[Signaling Worker] Parsed avatar attachment from signaling email: ${avatarAtt.filename}`);
        }
    }
    
    if (carryTextMessage) {
        console.log(`[Signaling Worker] Parsed carried text message from signaling email: ${carryTextMessage.id}`);
    }
    
    return { content, senderName, unsentMessages, attachments, carryTextMessage, avatarAttachment, avatarData };
}

function withTimeout(promiseOrFn, timeoutMs = 5000) {
    const promise = typeof promiseOrFn === 'function'
        ? promiseOrFn()
        : promiseOrFn;

    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Operation timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        })
    ]);
}

async function withRetry(asyncFn, maxRetries = 3, delayMs = 1000) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await asyncFn();
        } catch (error) {
            lastError = error;
            errorStats.retryCount++;
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, delayMs * (i + 1)));
            }
        }
    }
    throw lastError;
}

self.onmessage = async function (e) {
    const { type, emails, myEmail, activeConnections = [], port } = e.data;

    console.log(`[Signaling Worker] Received message: type=${type}, emailsCount=${emails?.length || 0}, myEmail=${myEmail || 'not set'}`);

    if (type === 'updateMyEmail') {
        if (myEmail && myEmail !== currentMyEmail) {
            console.log(`[Signaling Worker] [UPDATE] myEmail updated: ${currentMyEmail} -> ${myEmail}`);
            currentMyEmail = myEmail;
        }
        return;
    }

    if (type === 'init_signaling_port') {
        const directPort = port || e.ports[0];
        console.log('[Signaling Worker] Direct signaling port initialized');
        directPort.onmessage = async (event) => {
            const { type: portMsgType, emails: portEmails, myEmail: portMyEmail, activeConnections: portActiveConnections } = event.data;
            console.log(`[Signaling Worker] Received direct port message: type=${portMsgType}, emailsCount=${portEmails?.length || 0}`);

            if (portMsgType === 'processEmails') {
                const emailToUse = portMyEmail || currentMyEmail;
                await processBatchEmails(portEmails, emailToUse, portActiveConnections);
            }
        };
        console.log('[Signaling Worker] Direct port message listener set');
        return;
    }

    if (type === 'processEmails') {
        console.log(`[Signaling Worker] Received processEmails request: ${emails?.length || 0} emails`);
        const emailToUse = myEmail || currentMyEmail;
        if (!emailToUse) {
            console.warn(`[Signaling Worker] [WARN] myEmail is empty, signaling emails may not be processed correctly`);
        }
        await processBatchEmails(emails, emailToUse, activeConnections);
    }
};

async function processBatchEmails(emails, myEmail, activeConnections) {
    const signals = [];

    if (!emails || !Array.isArray(emails)) {
        self.postMessage({ type: 'SIGNALS_PROCESSED', results: [] });
        return;
    }

    function generateUniqueEmailId(email) {
        if (email.uid) return email.uid;
        if (email.id) return email.id;
        if (email.messageId) return email.messageId;
        const quickId = `${email.subject || ''}_${email.date || ''}_${email.from || ''}`;
        return quickId;
    }

    const emailProcessingPromises = emails.map(async (email) => {
        try {
            const validationResult = validateSignalingEmail(email);
            if (!validationResult.valid) {
                console.log(`[Signaling Worker] ⏭️  Email validation failed, skipping processing - sender: ${email.from || 'unknown'}, subject: ${email.subject || 'no subject'}, reason: ${validationResult.reason}`);
                return null;
            }

            const emailId = generateUniqueEmailId(email);

            if (processedEmailIds.has(emailId)) {
                console.log(`[Signaling Worker] ⏭️  Email already processed, skipping - sender: ${email.from}, subject: ${email.subject}, email ID: ${emailId}`);
                return null;
            }

            processedEmailIds.set(emailId, true);

            return email;
        } catch (err) {
            console.error(`[Signaling Worker] ❌ Error processing email - sender: ${email.from || 'unknown'}, subject: ${email.subject || 'no subject'}, error: ${err.message}`);
            errorStats.processingFailed++;
            return null;
        }
    });

    const newSignalingEmails = (await Promise.all(emailProcessingPromises))
        .filter(email => email !== null);

    async function processSignal(email) {
        const activeConnectionsMap = new Map(activeConnections);
        const isDataChannelActive = activeConnectionsMap.has(email.from);

        const signal = {
            originalSubject: email.subject,
            from: email.from,
            text: email.text,
            actions: []
        };

        if (!isDataChannelActive) {
            // Automatically add the sender as a contact (status=0, meaning acquaintance, auto-added via signaling email)
            signal.actions.push({
                type: 'ADD_CONTACT',
                sender: email.from,
                status: 0
            });

            if (email.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')
                && !email.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-sender-')
                && !email.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-recver-')) {

                // Extract sequence number from subject
                const sequenceMatch = email.subject.match(new RegExp(SIGNALING_EMAIL_PREFIX + 'discover-(\\d+)$'));
                const sequence = sequenceMatch ? parseInt(sequenceMatch[1], 10) : null;
                
                // Validate the discover email timestamp (extracted from the sequence number or from the email date)
                const emailTimestamp = sequence || (email.date ? new Date(email.date).getTime() : null);
                const now = Date.now();
                const maxAge = 60000; // 60-second validity period
                
                if (emailTimestamp && (now - emailTimestamp > maxAge)) {
                    console.log(`[Signaling Worker] ⏭️ Ignoring expired discover email: ${email.subject}, age: ${now - emailTimestamp}ms`);
                    signal.actions.push({
                        type: 'LOG',
                        message: `⏭️ Ignoring expired discover email: ${email.subject}`
                    });
                    // Still add the delete action
                    signal.actions.push({
                        type: 'DELETE_EMAIL_BY_UID',
                        emailUids: [email.uid],
                        immediate: true
                    });
                    return signal;
                }
                
                if (sequence) {
                    console.log(`[Signaling Worker] [SignalingSequence] Received discover sequence: ${sequence} from ${email.from}`);
                }

                signal.actions.push({ type: 'SHOW_P2P_CHAT' });

                signal.actions.push({
                    type: 'LOAD_HISTORY_MESSAGES',
                    from: email.from
                });

                const { content: emailContent, senderName, unsentMessages, attachments, carryTextMessage, avatarAttachment, avatarData } = parseSignalingContent(email);
                let discoverMessageId = null;
                const contentValid = !!emailContent;

                if (emailContent) {
                    // Trigger UPDATE_CONTACT as long as senderName or avatarData exists
                    if (emailContent.senderName || avatarData) {
                        signal.actions.push({
                            type: 'UPDATE_CONTACT',
                            sender: email.from,
                            senderName: senderName,
                            avatarData: avatarData
                        });
                    }

                    if (emailContent.messageId && typeof emailContent.messageId === 'string') {
                        discoverMessageId = emailContent.messageId;
                        console.log(`📋 Received discover email, message ID: ${discoverMessageId}`);
                    }

                    if (emailContent.version && typeof emailContent.version === 'string') {
                        console.log(`📋 Discover email version: ${emailContent.version}`);
                    }
                    
                    // Handle avatar attachments
                    if (avatarData) {
                        console.log(`🖼️ Received discover email with avatar: ${avatarData.filename}, size: ${avatarData.size} bytes`);
                    }
                }

                // Filter out avatar attachments to avoid showing them in chat history
                const nonAvatarAttachments = attachments.filter(att => {
                    const filename = att.filename || att.name || '';
                    return !filename.startsWith('myavatar_');
                });
                
                if ((unsentMessages && unsentMessages.length > 0) || (nonAvatarAttachments && nonAvatarAttachments.length > 0)) {
                    console.log(`📋 Discover email contains ${unsentMessages?.length || 0} unsent messages, ${nonAvatarAttachments?.length || 0} attachments (avatar excluded)`);
                    signal.actions.push({
                        type: 'FORWARD_TO_CHAT',
                        event: 'recv_offline_messages',
                        data: {
                            from: email.from,
                            messages: unsentMessages,
                            attachments: nonAvatarAttachments
                        }
                    });
                }

                if (carryTextMessage) {
                    console.log(`[Signaling Worker] Discover email carries text message: ${carryTextMessage.id}`);
                    signal.actions.push({
                        type: 'FORWARD_TO_CHAT',
                        event: 'recv_carry_text_message',
                        data: {
                            from: email.from,
                            message: carryTextMessage
                        }
                    });
                }

                console.log(`📤 Processing discover email: sender=${email.from}, content valid=${contentValid}`);

                if (myEmail) {
                    const roleInfo = resolveRole(myEmail, email.from);
                    console.log(`[Signaling Worker] Role determination: ${roleInfo.reason}`);
                    
                    if (roleInfo.valid) {
                        if (roleInfo.role === 'receiver') {
                            console.log(`[Signaling Worker] ✅ Received Discover email from Sender (${email.from}), I am Receiver (${myEmail})`);
                            signal.actions.push({
                                type: 'LOG',
                                message: `✅ Received Discover: peer is Sender (${email.from} < ${myEmail}), I am Receiver (Polite). Preparing to receive Offer...`
                            });
                            
                            signal.actions.push({
                                type: 'FORWARD_TO_WEBRTC',
                                event: 'prepare_receiver',
                                data: { from: email.from }
                            });
                        } else {
                            console.log(`[Signaling Worker] ✅ Received Discover email from Receiver (${email.from}), I am Sender (${myEmail})`);
                            signal.actions.push({
                                type: 'LOG',
                                message: `✅ Received Discover: peer is Receiver (${email.from} > ${myEmail}), I am Sender (Impolite). Should send Offer...`
                            });
                            
                            signal.actions.push({
                                type: 'FORWARD_TO_WEBRTC',
                                event: 'send_offer',
                                data: { from: email.from }
                            });
                        }
                    } else {
                        console.log(`[Signaling Worker] ⚠️ Role determination failed: ${roleInfo.reason}`);
                        signal.actions.push({
                            type: 'LOG',
                            message: `⚠️ Role determination failed: ${roleInfo.reason}`
                        });
                    }
                } else {
                    console.log(`[Signaling Worker] ⚠️ myEmail not found, cannot determine role, conservative handling: prepare to receive Offer`);
                    signal.actions.push({
                        type: 'LOG',
                        message: '⚠️ myEmail not found, cannot determine role, conservative handling: prepare to receive Offer'
                    });
                    signal.actions.push({
                        type: 'FORWARD_TO_WEBRTC',
                        event: 'prepare_receiver',
                        data: { from: email.from }
                    });
                }

                signal.actions.push({
                    type: 'LOG',
                    message: `📤 Sending discover email acknowledgment to: ${email.from}`
                });
            }
            if (email.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'offer-')) {
                console.log(`[Signaling Worker] 🎯 Processing offer email: sender=${email.from}, subject=${email.subject}`);
                
                // Extract sequence number from subject
                const sequenceMatch = email.subject.match(new RegExp(SIGNALING_EMAIL_PREFIX + 'offer-(\\d+)$'));
                const sequence = sequenceMatch ? parseInt(sequenceMatch[1], 10) : null;
                
                if (sequence) {
                    console.log(`[Signaling Worker] [SignalingSequence] Received offer sequence: ${sequence} from ${email.from}`);
                }
                
                signal.actions.push({ type: 'SHOW_P2P_CHAT' });

                const { content: emailContent, senderName, unsentMessages, attachments, carryTextMessage, avatarAttachment, avatarData } = parseSignalingContent(email);
                
                console.log(`[Signaling Worker] Offer parsing result:`, {
                    hasContent: !!emailContent,
                    hasSenderName: !!emailContent?.senderName,
                    unsentMessagesCount: unsentMessages?.length || 0,
                    attachmentsCount: attachments?.length || 0,
                    hasAvatar: !!avatarData,
                    sequence: sequence
                });

                // Trigger UPDATE_CONTACT as long as senderName or avatarData exists
                if (emailContent && (emailContent.senderName || avatarData)) {
                    signal.actions.push({
                        type: 'UPDATE_CONTACT',
                        sender: email.from,
                        senderName: senderName,
                        avatarData: avatarData
                    });
                    
                    if (avatarData) {
                        console.log(`🖼️ Received offer email with avatar: ${avatarData.filename}, size: ${avatarData.size} bytes`);
                    }
                }

                // Filter out avatar attachments to avoid showing them in chat history
                const nonAvatarAttachments = attachments.filter(att => {
                    const filename = att.filename || att.name || '';
                    return !filename.startsWith('myavatar_');
                });
                
                if ((unsentMessages && unsentMessages.length > 0) || (nonAvatarAttachments && nonAvatarAttachments.length > 0)) {
                    console.log(`?? Offer email contains ${unsentMessages?.length || 0} unsent messages, ${nonAvatarAttachments?.length || 0} attachments (avatar excluded)`);
                    signal.actions.push({
                        type: 'FORWARD_TO_CHAT',
                        event: 'recv_offline_messages',
                        data: {
                            from: email.from,
                            messages: unsentMessages,
                            attachments: nonAvatarAttachments
                        }
                    });
                }

                if (carryTextMessage) {
                    console.log(`[Signaling Worker] Offer email carries text message: ${carryTextMessage.id}`);
                    signal.actions.push({
                        type: 'FORWARD_TO_CHAT',
                        event: 'recv_carry_text_message',
                        data: {
                            from: email.from,
                            message: carryTextMessage
                        }
                    });
                }

                signal.actions.push({
                    type: 'FORWARD_TO_WEBRTC',
                    event: 'recv_offer',
                    data: {
                        from: email.from,
                        offerData: emailContent,
                        attachments: attachments,
                        emailSubject: email.subject // Pass the subject to extract the serial number
                    }
                });
                console.log(`[Signaling Worker] ✅ Added recv_offer action`);
                signal.actions.push({
                    type: 'LOG',
                    message: `📥 Received offer signal (sequence: ${sequence || 'none'})`
                });
            }
            if (email.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'answer-')) {
                console.log(`[Signaling Worker] 🎯 Processing answer email: sender=${email.from}, subject=${email.subject}`);
                
                // Extract sequence number from subject
                const sequenceMatch = email.subject.match(new RegExp(SIGNALING_EMAIL_PREFIX + 'answer-(?:complete-)?(\\d+)$'));
                const sequence = sequenceMatch ? parseInt(sequenceMatch[1], 10) : null;
                
                if (sequence) {
                    console.log(`[Signaling Worker] [SignalingSequence] Received answer sequence: ${sequence} from ${email.from}`);
                }
                
                const { content: emailContent, senderName, unsentMessages, attachments, carryTextMessage } = parseSignalingContent(email);
                
                console.log(`[Signaling Worker] Answer parsing result:`, {
                    hasContent: !!emailContent,
                    hasSenderName: !!emailContent?.senderName,
                    unsentMessagesCount: unsentMessages?.length || 0,
                    attachmentsCount: attachments?.length || 0
                });

                if (emailContent && emailContent.senderName) {
                    signal.actions.push({
                        type: 'UPDATE_CONTACT',
                        sender: email.from,
                        senderName: senderName
                    });
                }

                if ((unsentMessages && unsentMessages.length > 0) || (attachments && attachments.length > 0)) {
                    console.log(`?? Answer email contains ${unsentMessages?.length || 0} unsent messages, ${attachments?.length || 0} attachments`);
                    signal.actions.push({
                        type: 'FORWARD_TO_CHAT',
                        event: 'recv_offline_messages',
                        data: {
                            from: email.from,
                            messages: unsentMessages,
                            attachments: attachments
                        }
                    });
                }

                if (carryTextMessage) {
                    console.log(`[Signaling Worker] Answer email carries text message: ${carryTextMessage.id}`);
                    signal.actions.push({
                        type: 'FORWARD_TO_CHAT',
                        event: 'recv_carry_text_message',
                        data: {
                            from: email.from,
                            message: carryTextMessage
                        }
                    });
                }

                signal.actions.push({
                    type: 'FORWARD_TO_WEBRTC',
                    event: 'recv_answer',
                    data: {
                        from: email.from,
                        answerData: emailContent,
                        attachments: attachments,
                        emailSubject: email.subject // Pass the subject to extract the serial number
                    }
                });
                console.log(`[Signaling Worker] ✅ Added recv_answer action`);
                signal.actions.push({
                    type: 'LOG',
                    message: `📥 Received answer signal (sequence: ${sequence || 'none'})`
                });
            }


        } else {
            console.log(`[Signaling Worker] ⏭️ Already connected, skipping signal parsing - sender: ${email.from}, subject: ${email.subject}, activeConnections=${activeConnectionsMap.size}`);

            if (email.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-') ||
                email.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'offer-') ||
                email.subject.startsWith(SIGNALING_EMAIL_PREFIX + 'answer-')) {

                const { unsentMessages, attachments, carryTextMessage } = parseSignalingContent(email);
                if ((unsentMessages && unsentMessages.length > 0) || (attachments && attachments.length > 0)) {
                    console.log(`[ActiveState] Extracted ${unsentMessages?.length || 0} offline messages, ${attachments?.length || 0} attachments from signaling email: ${email.subject}`);
                    signal.actions.push({
                        type: 'FORWARD_TO_CHAT',
                        event: 'recv_offline_messages',
                        data: {
                            from: email.from,
                            messages: unsentMessages,
                            attachments: attachments
                        }
                    });
                }
                
                if (carryTextMessage) {
                    console.log(`[ActiveState] Connected state, extracted carried text message from signaling email: ${carryTextMessage.id}`);
                    signal.actions.push({
                        type: 'FORWARD_TO_CHAT',
                        event: 'recv_carry_text_message',
                        data: {
                            from: email.from,
                            message: carryTextMessage
                        }
                    });
                }
            }

            signal.actions.push({
                type: 'LOG',
                message: `📡 Connected: skipping WebRTC operations, only checking offline messages: ${email.from}`
            });
        }

        signal.actions.push({
            type: 'DELETE_EMAIL_BY_UID',
            emailUids: [email.uid],
            immediate: true
        });

        return signal;
    }

    const signalProcessingPromises = newSignalingEmails.map(async (email) => {
        try {
            return await withTimeout(processSignal(email), 3000);
        } catch (err) {
            console.error('Error processing signal:', err, email);
            errorStats.processingFailed++;
            return null;
        }
    });

    const processedSignals = await Promise.all(signalProcessingPromises);

    const validSignals = processedSignals.filter(signal => signal !== null);

    self.postMessage({ type: 'SIGNALS_PROCESSED', results: validSignals });

    if (Math.random() < 0.1) {
        self.postMessage({ type: 'HEALTH_STATUS', status: reportHealthStatus() });
    }
}
