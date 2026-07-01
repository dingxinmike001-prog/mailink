/**
 * Email Distributor Worker
 * Responsibility: Classify and optimize email data in a background thread
 * - Separate signaling emails from display emails
 * - Reduce unnecessary data transfer
 * - Optimize email content to reduce memory usage
 */

// Signaling email prefix constant (keep in sync with shared/config/signaling-constants.js)
const SIGNALING_EMAIL_PREFIX = 'WebRTC-SIGNAL-';

// Configuration constants
const CONFIG = {
    STATS_THROTTLE_MS: 500,
    LOG_BATCH_SIZE: 10,
    SIGNAL_LOG_THRESHOLD: 5
};

let signalingPort = null;
let messageCount = 0;
let lastStatsTime = 0;
let pendingSignalingCount = 0;
let pendingDisplayCount = 0;
let lastLogTypes = new Map();
let logBatchBuffer = [];
let currentMyEmail = null; // Store current myEmail

self.onmessage = function (e) {
    const { type, emails, myEmail, port } = e.data;
    messageCount++;
    const logId = `[EmailDistributor#${messageCount}]`;

    if (type === 'init_signaling_port') {
        signalingPort = port || e.ports[0];
        console.log(`${logId} [INIT] Direct signaling port initialized:`, {
            hasPort: !!signalingPort,
            portType: signalingPort ? 'MessageChannel' : 'undefined'
        });

        if (!signalingPort) {
            console.warn(`${logId} [WARN] signalingPort not initialized, signaling emails will be forwarded via main thread`);
        }
        return;
    }

    // Handle update myEmail message
    if (type === 'updateMyEmail') {
        if (myEmail && myEmail !== currentMyEmail) {
            console.log(`${logId} [UPDATE] myEmail updated: ${currentMyEmail} -> ${myEmail}`);
            currentMyEmail = myEmail;
        }
        return;
    }

    if (type === 'distributeEmails') {
        // Update current myEmail
        if (myEmail) {
            currentMyEmail = myEmail;
        }
        try {
            const startTime = Date.now();
            const emailsCount = emails?.length || 0;
            
            if (emailsCount === 0) {
                self.postMessage({
                    type: 'distributed',
                    signalingEmails: [],
                    displayEmails: [],
                    stats: null
                });
                return;
            }

            if (!Array.isArray(emails)) {
                console.error(`${logId} [ERROR] Invalid emails data: expected array`);
                self.postMessage({
                    type: 'error',
                    message: 'Invalid emails data: expected array'
                });
                return;
            }

            const signalingEmails = [];
            const displayEmails = [];
            let signalingSubjectCounts = {};
            let totalTextLength = 0;

            emails.forEach((email, index) => {
                if (!email) return;

                const subject = email.subject || 'No Subject';
                const fromEmail = email.from || 'Unknown';
                const isSignaling = subject.startsWith(SIGNALING_EMAIL_PREFIX);
                const textLength = email.text?.length || 0;
                totalTextLength += textLength;

                if (isSignaling) {
                    signalingEmails.push({
                        subject: subject,
                        from: fromEmail,
                        text: email.text || '',
                        date: email.date || new Date().toISOString(),
                        messageId: email.messageId || '',
                        uid: email.uid || email.id,
                        // 🔍 Add attachment info - this is the key fix
                        attachments: email.attachments || [],
                        emailImageMetadata: email.emailImageMetadata || [],
                        imageAttachments: email.imageAttachments || []
                    });
                    
                    signalingSubjectCounts[subject] = (signalingSubjectCounts[subject] || 0) + 1;
                }

                displayEmails.push({
                    subject: subject,
                    from: fromEmail,
                    date: email.date || new Date().toISOString(),
                    text: isSignaling ? email.text || '' : (email.text ? email.text.substring(0, 500) : ''),
                    hasHtml: !!email.html,
                    id: email.id,
                    messageId: email.messageId || '',
                    uid: email.uid || email.id
                });
            });

            const processingTime = Date.now() - startTime;
            const signalingCount = signalingEmails.length;
            const displayCount = displayEmails.length;

            if (signalingPort && signalingCount > 0) {
                try {
                    // Use currentMyEmail or the passed myEmail
                    const emailToUse = currentMyEmail || myEmail;
                    if (!emailToUse) {
                        console.warn(`${logId} [WARN] myEmail is empty, signaling emails may not be handled correctly`);
                    }
                    signalingPort.postMessage({
                        type: 'processEmails',
                        emails: signalingEmails,
                        myEmail: emailToUse,
                        activeConnections: e.data.activeConnections || []
                    });
                    pendingSignalingCount += signalingCount;
                } catch (error) {
                    self.postMessage({
                        type: 'signalingEmailsFallback',
                        emails: signalingEmails
                    });
                }
            } else if (!signalingPort && signalingCount > 0) {
                self.postMessage({
                    type: 'signalingEmailsFallback',
                    emails: signalingEmails
                });
            }

            const now = Date.now();
            const shouldSendStats = (now - lastStatsTime) >= CONFIG.STATS_THROTTLE_MS;
            
            self.postMessage({
                type: 'distributed',
                signalingEmails: signalingPort ? [] : signalingEmails,
                displayEmails: displayEmails,
                stats: shouldSendStats ? {
                    total: emailsCount,
                    signaling: signalingCount,
                    display: displayCount,
                    timestamp: now,
                    processingTime: processingTime,
                    avgTextLength: Math.round(totalTextLength / emailsCount)
                } : null
            });

            lastStatsTime = now;
            
            const duplicateSubjects = Object.entries(signalingSubjectCounts)
                .filter(([_, count]) => count > 1)
                .map(([sub, count]) => `${sub.split('-').slice(0, 4).join('-')}(${count})`);
            
            if (duplicateSubjects.length > 0) {
                console.log(`${logId} [CLASSIFY] Completed: ${emailsCount} emails, signaling ${signalingCount}, display ${displayCount}, time ${processingTime}ms, duplicate subjects: ${duplicateSubjects.join(',')}`);
            } else {
                console.log(`${logId} [CLASSIFY] Completed: ${emailsCount} emails, signaling ${signalingCount}, display ${displayCount}, time ${processingTime}ms`);
            }

        } catch (error) {
            console.error(`${logId} [ERROR] Error in email distribution process:`, error);
            self.postMessage({
                type: 'error',
                message: error.message || 'Unknown error in email distribution'
            });
        }
    }
};

console.log('[Email Distributor Worker] Initialized and ready');
