import { getUtilsRoot } from './root.js';
import { isValidEmail as commonIsValidEmail } from './common.js';

export function formatDate(dateString, locale = 'zh-CN') {
    const root = getUtilsRoot();
    const api = root?.format;
    const impl = api?.formatDate;
    if (typeof impl === 'function') return impl.call(api, dateString, locale);
    const date = typeof dateString === 'string' ? new Date(dateString) : dateString;
    return date.toLocaleString(locale);
}

export function convertToMilliseconds(timestamp) {
    const root = getUtilsRoot();
    const api = root?.format;
    const impl = api?.convertToMilliseconds;
    if (typeof impl === 'function') return impl.call(api, timestamp);

    if (timestamp) {
        if (typeof timestamp === 'string') {
            if (timestamp.length > 15) {
                return Number(BigInt(timestamp) / BigInt(1000000));
            }
            return Number(timestamp);
        }
        if (typeof timestamp === 'number') {
            if (timestamp > 1e15) {
                return Math.floor(timestamp / 1e6);
            }
        }
        return timestamp;
    }
    return null;
}

export function formatTime(timestamp) {
    const root = getUtilsRoot();
    const api = root?.format;
    const impl = api?.formatTime;
    if (typeof impl === 'function') return impl.call(api, timestamp);

    const msTimestamp = convertToMilliseconds(timestamp);
    const now = msTimestamp ? new Date(msTimestamp) : new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
}

export function formatTimeFull(timestamp) {
    const root = getUtilsRoot();
    const api = root?.format;
    const impl = api?.formatTimeFull;
    if (typeof impl === 'function') return impl.call(api, timestamp);

    const msTimestamp = convertToMilliseconds(timestamp);
    const now = msTimestamp ? new Date(msTimestamp) : new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
}

export function isValidEmail(email) {
    // Prefer the implementation in common.js
    const root = getUtilsRoot();
    const api = root?.format;
    const impl = api?.isValidEmail;
    if (typeof impl === 'function') return impl.call(api, email);
    // Use unified implementation from common.js
    return commonIsValidEmail(email);
}
