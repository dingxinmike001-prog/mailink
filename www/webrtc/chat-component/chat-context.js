import { getMyEmail } from '../../utils/common.js';

export class ChatContext {
  constructor(element, shadowRoot) {
    this.element = element;
    this.shadowRoot = shadowRoot;
    this.root = shadowRoot; // Alias for compatibility
    this.targetEmail = element.getAttribute('contact-email') || '';

    // Use runtime myEmail (not relying on localStorage)
    // Prefer element attribute, then fall back to getMyEmail()
    const myEmailFromAttr = element.getAttribute('my-email');
    this.myEmail = myEmailFromAttr || getMyEmail();

    // Log if myEmail is already set
    if (this.myEmail) {
      console.log(`[ChatContext] myEmail initialized: ${this.myEmail}`);
    } else {
      // Start a timer to check periodically if myEmail is empty
      console.log('[ChatContext] myEmail is empty, starting retry timer...');
      this._myEmailRetryTimer = setInterval(() => {
        const retryEmail = element.getAttribute('my-email') || getMyEmail();
        if (retryEmail) {
          console.log(`[ChatContext] myEmail found after retry: ${retryEmail}`);
          this.myEmail = retryEmail;
          if (this.logger) {
            this.logger.setMyEmail(retryEmail);
          }
          clearInterval(this._myEmailRetryTimer);
          this._myEmailRetryTimer = null;
        }
      }, 500); // Check every 500ms

      // Stop retrying after 30 seconds
      setTimeout(() => {
        if (this._myEmailRetryTimer) {
          console.log('[ChatContext] myEmail retry timeout, stopping timer');
          clearInterval(this._myEmailRetryTimer);
          this._myEmailRetryTimer = null;
        }
      }, 30000);
    }
    
    this.httpServerPort = window.httpServerPort || 8080;
    
    // Modules will be attached here
    this.eventBus = null;
    this.logger = null;
    this.uiRenderer = null;
    this.signalingManager = null;
    this.connectionManager = null;
    this.chatManager = null;
    this.mediaCallManager = null;
    
    // State
    this.displayedMessageIds = new Set();
    
    // User activity tracking
    this._lastUserActivityTime = 0;
    this._activityTimeout = 30000; // Treat as inactive after 30 seconds without activity
  }

  setTargetEmail(email) {
    this.targetEmail = email;
    // Update component attribute
    this.element.setAttribute('contact-email', email);
  }

  updateUserActivity() {
    this._lastUserActivityTime = Date.now();
  }

  isUserActive() {
    if (this._lastUserActivityTime === 0) {
      return false;
    }
    return (Date.now() - this._lastUserActivityTime) < this._activityTimeout;
  }

  getLastActivityTime() {
    return this._lastUserActivityTime;
  }
}
