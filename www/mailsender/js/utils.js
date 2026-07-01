import { buildAvatarHtml } from '../../utils/avatar-html.js';
import { SIGNALING_EMAIL_PREFIX } from '../../../shared/config/signaling-constants.js';

export function sendLogToParent(message, type = 'log') {
    try {
        if (window.parent && window.parent.postMessage) {
            window.parent.postMessage({
                type: 'forwardLog',
                logData: {
                    content: message,
                    timestamp: Date.now(),
                    type: type
                }
            }, '*');
        }
        console.log(message);
    } catch (error) {
        console.error('Failed to send log to parent window:', error);
    }
}

export { buildAvatarHtml };

export function generateWebRTCSignalSubject() {
    function generateRandomString(length) {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    const prefix = SIGNALING_EMAIL_PREFIX + 'discover-';
    const timestamp = Date.now();
    const randomStr = generateRandomString(9);
    const subject = `${prefix}${timestamp}-${randomStr}`;

    const subjectEl = document.getElementById('subject');
    if (subjectEl) {
        subjectEl.value = subject;
    }
}

export function deler(sender) {
    if (window.parent) {
        window.parent.postMessage({
            type: 'deleteEmailsBySenderAndSubject',
            sender: sender,
            subjectPrefix: SIGNALING_EMAIL_PREFIX
        }, '*');
    }

    Object.keys(localStorage).forEach(key => {
        if (key.includes('_send_') || key.includes('_recv_') || key.startsWith('send_') || key.startsWith('recv_')) {
            localStorage.setItem(key, '');
        }
    });

    Object.keys(localStorage).forEach(key => {
        if (key.includes('_send_') || key.includes('_recv_') || key.startsWith('send_') || key.startsWith('recv_')) {
            localStorage.removeItem(key);
        }
    });
}
