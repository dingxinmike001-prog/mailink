import { getUtilsRoot } from './root.js';
import { sleep } from './common.js';

export async function withRetry(fn, options = {}) {
    const root = getUtilsRoot();
    const api = root?.retry;
    const impl = api?.withRetry;
    if (typeof impl === 'function') return impl.call(api, fn, options);

    const { maxRetries = 3, delay = 1000, shouldRetry } = options;
    let retries = 0;
    while (retries <= maxRetries) {
        try {
            return await fn(retries);
        } catch (error) {
            retries++;
            if (retries > maxRetries) throw error;
            if (shouldRetry && !shouldRetry(error)) throw error;
            await sleep(delay);
        }
    }
}

export function sendMessageToWebcomWithRetry(webcom, message, options = {}) {
    const root = getUtilsRoot();
    const api = root?.retry;
    const impl = api?.sendMessageToWebcomWithRetry;
    if (typeof impl === 'function') return impl.call(api, webcom, message, options);

    const {
        interval = 500,
        maxRetryTime = 5000,
        messageType = 'WEBRTC_SIGNAL',
        logPrefix = '📤'
    } = options;

    // Define send message function
    const sendMessage = () => {
        if (webcom && webcom.contentWindow) {
            console.log(`${logPrefix} Sending ${messageType} message, data:`, message);
            try {
                webcom.contentWindow.postMessage(message, '*');
                console.log(`${logPrefix} ${messageType} message sent`);
                return true;
            } catch (error) {
                console.error(`${logPrefix} Failed to send ${messageType} message:`, error);
                console.log(`${logPrefix} Checking webcom@: readyState=${webcom.readyState}, contentWindow=${webcom.contentWindow ? 'available' : 'unavailable'}`);
                return false;
            }
        } else if (webcom && typeof webcom.postMessage === 'function') {
            // Support for Custom Elements (MailinkChat)
            console.log(`${logPrefix} Sending ${messageType} message (CustomElement), data:`, message);
            try {
                webcom.postMessage(message);
                console.log(`${logPrefix} ${messageType} message sent (CustomElement)`);
                return true;
            } catch (error) {
                console.error(`${logPrefix} Failed to send ${messageType} message (CustomElement):`, error);
                return false;
            }
        } else {
            console.error(`${logPrefix} Cannot send message: chat webcom or contentWindow does not exist`);
            return false;
        }
    };

    // Use setInterval to send messages periodically until webcom loads or max retry time is reached
    const intervalId = setInterval(() => {
        if (webcom.contentWindow || typeof webcom.postMessage === 'function') {
            console.log(`${logPrefix} Chat webcom is ready, sending ${messageType} message`);
            if (sendMessage()) {
                clearInterval(intervalId);
            }
        } else {
            console.log(`${logPrefix} Chat webcom is not ready yet, attempting to send message`);
            sendMessage();
        }
    }, interval);

    // Set max retry time to prevent infinite loop
    setTimeout(() => {
        clearInterval(intervalId);
        console.log(`${logPrefix} Max retry time reached (${maxRetryTime}ms), stopping ${messageType} message sending`);
    }, maxRetryTime);

    // Add onload event listener to ensure messages are sent again after webcom loads
    webcom.onload = function () {
        console.log(`${logPrefix} Chat webcom loaded, resending ${messageType} message to ensure delivery`);
        sendMessage();
        clearInterval(intervalId);
    };
}

/**
 * Ensure the window.sendemail function is available
 * @returns {Promise<void>}
 */
export async function ensureSendEmailAvailable() {
    const root = getUtilsRoot();
    const api = root?.retry;
    const maybeTrigger = api?.ensureSendEmailAvailable;
    if (typeof maybeTrigger === 'function') {
        try {
            maybeTrigger.call(api);
        } catch (_) { }
    }

    const log = typeof window?.log === 'function' ? window.log : console.log.bind(console);
    const hasSendEmail = () =>
        typeof window?.sendemail === 'function' ||
        typeof window?.electronAPI?.sendemail === 'function' ||
        typeof window?.parent?.sendemail === 'function' ||
        typeof window?.parent?.electronAPI?.sendemail === 'function';

    if (!hasSendEmail()) {
        log('⚠️ sendemail function is unavailable, retrying in 1 second');
        await sleep(1000);
        return ensureSendEmailAvailable();
    }

    log('✅ sendemail function is available');
}
