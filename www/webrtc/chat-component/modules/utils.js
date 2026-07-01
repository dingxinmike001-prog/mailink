
import {
  isValidEmail as commonIsValidEmail,
  resolveRole as commonResolveRole,
  isPolite as commonIsPolite,
  isSender as commonIsSender,
  isReceiver as commonIsReceiver,
  formatBytes as commonFormatBytes,
  generateMessageId as commonGenerateMessageId
} from '../../../utils/common.js';

export class Utils {
  constructor() {
    this.utils = window.utils || {};
  }

  isValidEmail(email) {
    // Prefer the implementation in window.utils, otherwise use common.js
    if (typeof this.utils.format?.isValidEmail === 'function') {
      return this.utils.format.isValidEmail(email);
    }
    return commonIsValidEmail(email);
  }

  isPolite(myEmail, targetEmail) {
    if (typeof this.utils.webrtc?.isPolite === 'function') {
      return this.utils.webrtc.isPolite(myEmail, targetEmail);
    }
    return commonIsPolite(myEmail, targetEmail);
  }

  resolveRole(myEmail, targetEmail) {
    if (typeof this.utils.webrtc?.resolveRole === 'function') {
      return this.utils.webrtc.resolveRole(myEmail, targetEmail);
    }
    return commonResolveRole(myEmail, targetEmail);
  }

  isSender(myEmail, targetEmail) {
    return commonIsSender(myEmail, targetEmail);
  }

  isReceiver(myEmail, targetEmail) {
    return commonIsReceiver(myEmail, targetEmail);
  }

  canSendOffer(myEmail, targetEmail) {
    return this.isSender(myEmail, targetEmail);
  }

  canSendDiscover(myEmail, targetEmail) {
    return this.isReceiver(myEmail, targetEmail);
  }

  shouldProcessOffer(myEmail, fromEmail) {
    return this.isReceiver(myEmail, fromEmail);
  }

  shouldProcessAnswer(myEmail, fromEmail) {
    return this.isSender(myEmail, fromEmail);
  }

  getOptimalIceCandidatePoolSize(...args) {
    return this.utils.webrtc?.getOptimalIceCandidatePoolSize(...args) || 10;
  }

  getIceCandidatePriority(...args) {
    return this.utils.webrtc?.getIceCandidatePriority(...args) || 0;
  }

  deduplicateIceCandidates(...args) {
    return this.utils.webrtc?.deduplicateIceCandidates(...args) || args[0];
  }

  filterHighPriorityIceCandidates(...args) {
    return this.utils.webrtc?.filterHighPriorityIceCandidates(...args) || Promise.resolve(args[0]);
  }

  addIceCandidates(...args) {
    return this.utils.webrtc?.addIceCandidates(...args) || Promise.resolve();
  }

  sanitizeHtml(...args) {
    return this.utils.dom?.sanitizeHtml(...args) || args[0];
  }

  textToHtml(...args) {
    return this.utils.dom?.textToHtml(...args) || args[0];
  }

  formatTime(...args) {
    return this.utils.format?.formatTime(...args) || '';
  }

  formatTimeFull(...args) {
    return this.utils.format?.formatTimeFull(...args) || '';
  }

  convertToMilliseconds(...args) {
    return this.utils.format?.convertToMilliseconds(...args) || args[0];
  }

  formatBytes(bytes, decimals = 2) {
    const impl = this.utils.format?.formatBytes;
    if (typeof impl === 'function') return impl(bytes, decimals);
    return commonFormatBytes(bytes, decimals);
  }

  ensureSendEmailAvailable(...args) {
    return this.utils.retry?.ensureSendEmailAvailable(...args) || Promise.resolve(true);
  }

  generateMessageId(...args) {
    if (this.utils.message?.generateMessageId) {
      return this.utils.message.generateMessageId(...args);
    }
    return commonGenerateMessageId();
  }
}
