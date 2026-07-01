/**
 * Signaling email related constants
 * uniformly manage constants such as WebRTC signaling email prefixes, avoid hardcoding
 */

const SIGNALING_EMAIL_PREFIX = 'WebRTC-SIGNAL-';

// ES Module export
export { SIGNALING_EMAIL_PREFIX };

// CommonJS export
// Note: module may be undefined in ES Module environments, safety check required
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SIGNALING_EMAIL_PREFIX
    };
}
