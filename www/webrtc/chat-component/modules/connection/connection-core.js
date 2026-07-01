
export class ConnectionCore {
  constructor(context) {
    this.context = context;
    
    // Initialize state
    this.pendingIceCandidates = [];
    this.collectedIceCandidates = [];
    this.pollingIntervalId = null;
    this.handshakeInProgress = false;
    this.makingOffer = false;
    this.webRTCConnectionStatus = 'disconnected';
    this.connectionRetryCounts = new Map();
    this.connectionTimeoutTimers = new Map();
    this.fixedTargetEmail = null;
    
    this.lastSendOfferTime = 0;
    this.processedAttachmentHashes = new Set();
    this.processingAnswer = false;
    
    this.pc = null;

    // Debounce mechanism: prevent repeated reconnects in short time
    this.lastReconnectTime = 0;
    this.RECONNECT_DEBOUNCE_MS = 2000; // Execute only once within 2 seconds

    this.setupEventListeners();
  }

  /**
   * Handle initial connection
   * Reuses handleReconnect logic but resets retry count
   */
  async handleInitialConnect(targetEmail) {
    this.log(`🔄 start initial connection flow...`);

    // Reset retry count during initial connection
    this.connectionRetryCounts.set(targetEmail, 0);

    // Reuse core logic of handleReconnect
    await this.handleReconnect();
  }

  /**
   * 🆕 Fully reset and reconnect
   * Called when DataChannel closes; resets all states to initial login state
   */
  async fullResetAndReconnect() {
    const targetEmail = this.context.targetEmail || this.fixedTargetEmail;

    this.log('🧹 [simplified reconnect]start full reset of all WebRTC state...');

    // 1. Fully clean up all connection resources
    this.cleanupConnection();

    // 2. Reset all state flags (as on first login)
    this.handshakeInProgress = false;
    this.makingOffer = false;
    this.hasReceivedOffer = false;
    this.hasSentOffer = false;
    this.processingAnswer = false;
    this.webRTCConnectionStatus = 'disconnected';
    this.lastSendOfferTime = 0;
    this.processedAttachmentHashes.clear();
    this.pendingIceCandidates = [];
    this.collectedIceCandidates = [];

    // 3. Reset retry count (start from 0 as on first login)
    if (targetEmail) {
      this.connectionRetryCounts.set(targetEmail, 0);
      this.log(`[simplified reconnect]reset ${targetEmail} retry count as  0`);
    }

    // 4. Reset debounce timer (allow immediate reconnect)
    this.lastReconnectTime = 0;
    this.log('[simplified reconnect]reset reconnect debounce timer');

    // 5. Clean up DataChannel references
    if (this.context.dataChannelManager) {
      this.context.dataChannelManager.dataChannel = null;
      this.context.dataChannel = null;
    }

    this.log('✅ [simplified reconnect]full reset completed, prepare to reconnect like first login');

    // 6. Trigger initial connection flow after delay (as on first login)
    if (targetEmail) {
      setTimeout(() => {
        this.log(`🔄 [simplified reconnect]trigger initial connection flow, target: ${targetEmail}`);
        this.handleInitialConnect(targetEmail);
      }, 1000); // 1s delay ensures cleanup completes
    } else {
      this.log('⚠️ [simplified reconnect]cannot reconnect: target email empty');
    }
  }

  get statusDiv() {
    // Access shadow DOM status element if possible, or emit events
    // In this component architecture, UI updates should be done via UIRenderer or events
    // But for compatibility with existing logic that might check textContent
    return this.context.root.getElementById('status');
  }

  log(message) {
    this.context.logger.info(message);
  }

  /**
   * Check whether current webcom is active window (contact currently viewed by user)
   * Inactive windows do not actively trigger reconnect on connection state change
   * @returns {boolean}
   */
  _isActiveWindow() {
    return window.activeChatWebcom === this.context.element;
  }

  /**
   * Validate whether email is valid
   * @param {string} email - Email address
   * @returns {boolean} - Whether valid
   */
  isValidEmail(email) {
    return typeof email === 'string' && email.trim() !== '';
  }

  /**
   * Validate emails and log
   * @param {string} myEmail - My email
   * @param {string} targetEmail - Target email
   * @param {string} context - Context description
   * @returns {boolean} - Whether valid
   */
  validateEmails(myEmail, targetEmail, context = '') {
    if (!this.isValidEmail(myEmail) || !this.isValidEmail(targetEmail)) {
      this.log(`⚠️ ${context} email info incomplete: myEmail=${myEmail}, targetEmail=${targetEmail}`);
      return false;
    }
    return true;
  }

  setupEventListeners() {
    const eventBus = this.context.eventBus;

    // 🆕 Listen for full reset and reconnect event (triggered when DataChannel closes)
    eventBus.on('connection:fullResetAndReconnect', () => {
      // Perform full reset regardless of active window
      const isActive = this._isActiveWindow();
      this.log(`🔄 [simplified reconnect]received full reset request(${isActive ? 'active' : 'non-active'}Window), perform full reset and reconnect`);
      this.fullResetAndReconnect();
    });

    // Listen for target email change event (triggered when switching contacts)
    // Note: targetChanged is explicitly triggered by handleContactSelected and is a "user action"
    // Therefore execute regardless of activity (user actively clicking a contact is necessarily active)
    eventBus.on('connection:targetChanged', (targetEmail) => {
      this.log(`📧 target email changed to: ${targetEmail}, prepare auto-connect...`);

      // [Protection] Reject switching if already connected to a different contact (each chatWebcom serves only its bound contact)
      if (this.isConnected() && this.fixedTargetEmail && this.fixedTargetEmail !== targetEmail) {
        this.log(`⚠️ reject target switch: currently connected with ${this.fixedTargetEmail} establish connection, should not switch to ${targetEmail}`);
        return;
      }

      // No need to reconnect if already connected to the same target
      if (this.isConnected() && this.fixedTargetEmail === targetEmail) {
        this.log(`✅ currently connected with ${targetEmail} connection established, no reconnect needed`);
        return;
      }

      this.fixedTargetEmail = targetEmail;
      this.context.targetEmail = targetEmail;

      // Clean up existing connection
      this.cleanupConnection();

      // Reset retry count and trigger initial connection
      this.connectionRetryCounts.set(targetEmail, 0);
      this.handleInitialConnect(targetEmail);
    });
  }

  async retryOperation(operation, operationName, maxRetries = 3, delay = 2000) {
    let attempts = 0;

    while (attempts <= maxRetries) {
      try {
        this.log(`🔄 execute${operationName} (try ${attempts + 1}/${maxRetries + 1})`);
        return await operation();
      } catch (error) {
        attempts++;
        this.log(`❌ ${operationName}failed (attempt ${attempts}/${maxRetries + 1}): ${error.message}`);
        this.context.logger.debug(`error stack: ${error.stack}`);

        if (attempts > maxRetries) {
          this.log(`❌ ${operationName}reached max retry count (${maxRetries + 1}), give up`);
          throw error;
        }

        this.log(`⏱️ ${delay}ms later retry${operationName}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Unified reconnect handler
   * Uses progressive exponential backoff to optimize retry intervals
   * @param {boolean} isUrgent - Whether urgent reconnect (e.g., ICE failed), bypasses debounce
   */
  async handleReconnect(isUrgent = false) {
    const config = this.context.config;
    const retryConfig = config.CONNECTION_RETRY_CONFIG;
    let targetEmail = this.context.targetEmail || this.fixedTargetEmail;



    // Debounce check: reconnect only once within 8 seconds (except urgent path)
    if (!isUrgent) {
      const now = Date.now();
      const timeSinceLastReconnect = now - this.lastReconnectTime;
      if (timeSinceLastReconnect < this.RECONNECT_DEBOUNCE_MS) {
        this.log(`⏳ [Debounce]skip reconnect, only since last reconnect ${timeSinceLastReconnect}ms, debounce interval ${this.RECONNECT_DEBOUNCE_MS}ms`);
        return;
      }
      this.lastReconnectTime = now;
    } else {
      this.log(`🔥 [fast path]urgent reconnect, bypass debounce`);
      this.lastReconnectTime = Date.now();
    }

    this.log(`🔄 [debug]handleReconnect called, targetEmail=${targetEmail}, isUrgent=${isUrgent}`);

    // If no targetEmail, try to get from contact list
    if (!targetEmail) {
      targetEmail = this.getLastContactEmail();
      if (targetEmail) {
        this.log(`📧 [debug]got targetEmail from contact list: ${targetEmail}`);
        this.context.targetEmail = targetEmail;
        this.fixedTargetEmail = targetEmail;
      }
    }

    if (!targetEmail) {
      this.log('⚠️ [debug]cannot reconnect: target email empty');
      return;
    }

    // Skip duplicate reconnect if handshake or Offer creation is in progress
    if (this.handshakeInProgress || this.makingOffer) {
      this.log(`⏳ [debug]establishing connection, skip duplicate reconnect request (handshakeInProgress=${this.handshakeInProgress}, makingOffer=${this.makingOffer})`);
      return;
    }

    // Get retry count
    let retryCount = this.connectionRetryCounts.get(targetEmail) || 0;
    retryCount++;
    this.connectionRetryCounts.set(targetEmail, retryCount);
    
    // Use new max retry count config
    const maxRetries = retryConfig ? retryConfig.MAX_TOTAL_RETRIES : config.MAX_CONNECTION_RETRIES;
    
    // Get current stage
    const phase = retryConfig ? retryConfig.getRetryPhase(retryCount) : 'unknown';
    
    this.log(`[debug]retry count: ${retryCount}/${maxRetries} (phase: ${phase})`);

    if (retryCount > maxRetries) {
      this.log(`❌ [debug]reconnect count reached limit (${maxRetries}), give up reconnect`);
      this.connectionRetryCounts.delete(targetEmail);
      // Trigger final failure event
      this.context.element.dispatchEvent(new CustomEvent('connection-failed-final', {
        detail: { email: targetEmail, reason: 'max_retries_exceeded', totalAttempts: maxRetries }
      }));
      return;
    }

    // Calculate delay for this retry (using progressive exponential backoff)
    const retryDelay = retryConfig ? retryConfig.getRetryDelay(retryCount) : (config.RETRY_DELAY || 2000);
    
    this.log(`🔄 [debug]start No. ${retryCount}/${maxRetries}  reconnect, delay  ${retryDelay}ms (phase: ${phase})...`);

    // 🆕 Fix: fully clear signaling cache and sequence state before reconnect
    this.log(`🧹 [reconnectprepare] clean all signaling cache and sequence state...`);
    // Trigger cleanup event via eventBus for ConnectionSignaling to handle
    this.context.eventBus.emit('signaling:resetState', targetEmail);
    this.log(`[SignalingSequence] sent reset signaling state event: ${targetEmail}`);
    
    // Clean up existing connection resources
    this.cleanupConnection();

    // Decide reconnect strategy based on role
    const myEmail = this.context.myEmail;

    // Fix: add email completeness check (using stricter validation)
    if (!this.validateEmails(myEmail, targetEmail, 'handleReconnect')) {
      return;
    }

    const isPolite = this.context.utils.isPolite(myEmail, targetEmail);
    this.log(`[debug]role determination: myEmail=${myEmail}, targetEmail=${targetEmail}, isPolite=${isPolite}`);

    if (isPolite) {
      // Polite Peer (Receiver) sends discover email to notify peer
      this.log('⏳ [debug]I am Receiver, sending discover to notify peer...');
      this.webRTCConnectionStatus = 'waiting';
      this.context.eventBus.emit('connection:statusChanged', 'waiting');

      // Send discover email using calculated delay
      setTimeout(() => {
        this.log('[debug]execute sendDiscoverEmail');
        this.sendDiscoverEmail(targetEmail);
        
        // [Fix] Receiver role also needs to trigger signaling mail fetching to receive Offer quickly
        this.log('📧 [fix]Receiverroletriggersignaling emailget...');
        this.triggerFetchEmails(2, true);
        
        // [Fix] Receiver role also needs to enable signaling mode polling to increase fetch frequency
        this.log('📡 [fix]ReceiverRole enables signaling mode polling...');
        if (window.electronAPI?.signalingState) {
          window.electronAPI.signalingState('start').catch(err => this.log('⚠️ signaling mode enable failed: ' + err.message));
        }
      }, retryDelay);
    } else {
      // Impolite Peer (Sender) actively initiates Offer
      this.log('📤 [debug]I am Sender, Initiate activelyconnection...');
      setTimeout(() => {
        this.log('[debug]execute sendOffer');
        this.sendoffer(targetEmail);
      }, retryDelay);
    }
  }

  /**
   * Clean up connection resources
   * Fully reset all signaling states and ICE candidates
   */
  cleanupConnection() {
    this.log('🧹 start cleaning connection resources...');

    // Stop polling
    this.stopPolling();

    // Clean up handshake state
    this.handshakeInProgress = false;
    this.makingOffer = false;
    
    // Clear all signaling-related flags
    this.hasReceivedOffer = false;
    this.hasSentOffer = false;
    this.processingAnswer = false;
    this.log('🧹 cleared all signaling flags: hasReceivedOffer=false, hasSentOffer=false, processingAnswer=false');

    // Reset connection state
    this.webRTCConnectionStatus = 'disconnected';
    this.lastSendOfferTime = 0;

    // Close existing PeerConnection
    if (this.pc) {
      try {
        // Remove all event listeners
        this.pc.onconnectionstatechange = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.onicecandidate = null;
        this.pc.onicegatheringstatechange = null;
        this.pc.ondatachannel = null;
        this.pc.onerror = null;
        
        // Close connection
        this.pc.close();
        this.log('✅ closed old connection and removed all event listeners');
      } catch (e) {
        this.log('⚠️ error closing old connection: ' + e.message);
      }
      this.pc = null;
    }

    // Clean up ICE candidates
    this.pendingIceCandidates = [];
    this.collectedIceCandidates = [];
    this.log(`🧹 cleaned ICE candidates: pending=${this.pendingIceCandidates.length}, collected=${this.collectedIceCandidates.length}`);

    // Clean up ICE disconnect reconnect timer
    if (this.iceDisconnectedTimerId) {
      clearTimeout(this.iceDisconnectedTimerId);
      this.iceDisconnectedTimerId = null;
      this.log('🧹 cleaned ICE disconnect reconnect timer');
    }

    // Clean up timeout timer
    const targetEmail = this.context.targetEmail || this.fixedTargetEmail;
    if (targetEmail) {
      this.clearConnectionTimeout(targetEmail);
    }

    // Clean up processed attachment hashes
    this.processedAttachmentHashes.clear();
    this.log('🧹 cleaned processed attachment hash set');

    this.log('✅ connection resource cleanup completed');
  }

  /**
   * Send discover email to notify peer to prepare for connection
   * Used by Receiver role to proactively notify Sender during reconnect
   */
  async sendDiscoverEmail(toEmail) {
    const myEmail = this.context.myEmail;

    // [Debug] Log call arguments and role determination
    this.log(`🔍 [debug]sendDiscoverEmail called`);
    this.log(`   myEmail=${myEmail}`);
    this.log(`   toEmail=${toEmail}`);
    this.log(`   email comparison: ${myEmail} > ${toEmail} = ${myEmail > toEmail}`);
    const isPolite = this.context.utils.isPolite(myEmail, toEmail);
    this.log(`   role determination: isPolite=${isPolite} (true=Receiver, false=Sender)`);

    // Fix: validate email before calling isPolite
    if (!this.validateEmails(myEmail, toEmail, 'sendDiscoverEmail')) {
      return;
    }

    this.log(`📤 sending discover email to: ${toEmail}`);
    if (this.statusDiv) this.statusDiv.textContent = '@:  Sending Discover signaling...';

    const discoverMessage = {
      type: 'discover',
      readme: 'MailLink email-chat signaling email. Please do not delete within 3 minutes; it will be automatically deleted when expired (you may also delete it manually).',
      timestamp: Date.now(),
      message: 'Ready to receive connection',
      version: '1.0'
    };

    try {
      if (this.context.signalingManager) {
        const sent = await this.context.signalingManager.sendSignalEmail(toEmail, discoverMessage, []);
        if (sent) {
          this.log('✅ Discover email sent');
          if (this.statusDiv) this.statusDiv.textContent = '@:  Discover signaling sent';
        } else {
          this.log('⚠️ Discover email send failed');
          if (this.statusDiv) this.statusDiv.textContent = '@:  Discover signaling send failed';
        }
      } else {
        this.log('❌ SignalingManager unavailable, cannot send discover email');
      }
    } catch (error) {
      this.log('❌ error sending discover email: ' + error.message);
    }
  }

  // Helper methods
  clearConnectionTimeout(email) {
    if (this.connectionTimeoutTimers.has(email)) {
      clearTimeout(this.connectionTimeoutTimers.get(email));
      this.connectionTimeoutTimers.delete(email);
    }
  }

  stopPolling() {
    if (this.pollingIntervalId) {
        clearInterval(this.pollingIntervalId);
        this.pollingIntervalId = null;
    }
  }
  
  startPolling() {
      // Typically handled by SignalingManager or global poller, but if we need specific polling
      // In new architecture, polling might be centralized.
      // We'll leave it as a hook or if needed invoke signaling manager
      if (this.context.signalingManager && this.context.signalingManager.startPolling) {
          this.context.signalingManager.startPolling();
      }
  }

  async triggerFetchEmails(minutes = 2, onlySignaling = true) {
    try {
      const configFromWindow = typeof window.getSelectedConfig === 'function'
        ? window.getSelectedConfig()
        : window.selectedConfig;
      const config = configFromWindow
        || (typeof window.electronAPI.getCurrentConfig === 'function'
          ? await window.electronAPI.getCurrentConfig()
          : null);
      if (!config || !config.username) return;

      // Prefer parallel Worker
      if (window.electronAPI && typeof window.electronAPI.fetchEmailsParallel === 'function') {
        this.log(`📧 use parallel Worker to fetch emails (signalingMinutes=${minutes})`);
        const result = await window.electronAPI.fetchEmailsParallel(config, minutes);
        this.log(`✅ parallel email fetch completed: signaling=${result.signalingEmails?.length || 0}, normal=${result.normalEmails?.length || 0}, time taken=${result.duration}ms`);
      } else if (window.electronAPI && typeof window.electronAPI.fetchEmails === 'function') {
        // Fallback: use original serial approach
        this.log(`📧 use serial Worker to fetch emails (minutes=${minutes}, onlySignaling=${onlySignaling})`);
        await window.electronAPI.fetchEmails(config, minutes, onlySignaling);
        this.log(`✅ serialemail fetchcompleted`);
      }
    } catch (e) {
      this.log(`⚠️ email fetchfailed: ${e?.message || e}`);
    }
  }

  /**
   * Get most recent contact's email address
   * Used to get targetEmail during reconnect
   */
  getLastContactEmail() {
    try {
      // 1. Try to get recent contact from sessionStorage (using key prefixed with email)
      const currentEmail = window.selectedConfig?.username;
      const lastContactKey = `lastSelectedContact_${currentEmail.replace(/@/g, '_at_')}`;
      const lastContact = sessionStorage.getItem(lastContactKey);
      if (lastContact) {
        this.log(`📧 [debug]get recent contact from sessionStorage: ${lastContact}`);
        return lastContact;
      }

      // 2. Try to get first contact from contact list
      if (window.contactManager && window.contactManager.getContacts) {
        const contacts = window.contactManager.getContacts();
        if (contacts && contacts.length > 0) {
          const firstContact = contacts[0].email;
          this.log(`📧 [debug]got first contact from contact list: ${firstContact}`);
          return firstContact;
        }
      }

      // 3. Try to get recent contact from database
      if (window.electronAPI && window.electronAPI.getContacts) {
        window.electronAPI.getContacts().then(result => {
          if (result && result.contacts && result.contacts.length > 0) {
            const firstContact = result.contacts[0].email;
            this.log(`📧 [debug]get recent contact from database: ${firstContact}`);
            return firstContact;
          }
        }).catch(err => this.log('failed to get contacts:', err));
      }
    } catch (e) {
      this.log(`⚠️ [debug]failed to get recent contacts: ${e.message}`);
    }
    return null;
  }

  // Check if connected
  isConnected() {
      return this.pc && (this.pc.connectionState === 'connected');
  }
  
  isDataChannelOpen() {
      if (this.context.dataChannelManager) {
          return this.context.dataChannelManager.isOpen();
      }
      return false;
  }

  getBufferedAmount() {
      const manager = this.context.dataChannelManager;
      if (!manager) return 0;
      if (typeof manager.getBufferedAmount === 'function') {
          const amount = manager.getBufferedAmount();
          return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
      }
      const dc = manager.dataChannel;
      if (dc && typeof dc.bufferedAmount === 'number' && Number.isFinite(dc.bufferedAmount)) {
          return dc.bufferedAmount;
      }
      return 0;
  }
  
  sendData(data) {
      if (this.context.dataChannelManager) {
          return this.context.dataChannelManager.sendData(data);
      }
      return false;
  }
}
