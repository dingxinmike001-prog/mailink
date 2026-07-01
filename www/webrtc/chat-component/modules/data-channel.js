
import { safeJsonParse, debugConfigCache } from '../../../utils/common.js';

export class DataChannelManager {
  constructor(context) {
    this.context = context;
    // State initialization
    this.globalConnectionTimeout = null;
    this.heartbeatInterval = null;
    this.heartbeatTimeout = null;
    this.missedHeartbeats = 0;
    this.heartbeatCount = 0;
    this.connectionState = 'disconnected';
    this.suspiciousTimer = null;
    this.dataChannel = null;
    this.pendingBinaryHeaders = new Map(); // Use Map to store multiple headers to avoid data loss

    // Network quality
    this.networkQuality = {
      type: 'unknown',
      rtt: 0,
      downlink: 0,
      effectiveType: 'unknown',
      saveData: false
    };
    this.networkMonitor = null;

    this.bufferedAmountLowThreshold = 1024 * 1024;
    this.maxBufferedAmount = 2048 * 1024;

    // State debounce configuration
    this.STATUS_THROTTLE_MS = 50;
    this._lastEmittedStatus = { status: null, timestamp: 0 };

    this.setupEventListeners();
    this.setupNetworkQualityMonitoring();
  }

  // Getters for context properties
  get logger() { return this.context.logger; }
  get eventBus() { return this.context.eventBus; }
  get config() { return this.context.config; }

  /**
   * Check whether current webcom is active window (contact currently viewed by user)
   * Inactive windows do not actively trigger reconnect on connection state change
   * @returns {boolean}
   */
  _isActiveWindow() {
    // Check whether current element is the globally active chat component
    return window.activeChatWebcom === this.context.element;
  }

  _shouldEmitStatus(status) {
    const now = Date.now();
    if (status !== this._lastEmittedStatus.status) {
      this._lastEmittedStatus = { status, timestamp: now };
      return true;
    }
    if (now - this._lastEmittedStatus.timestamp >= this.STATUS_THROTTLE_MS) {
      this._lastEmittedStatus.timestamp = now;
      return true;
    }
    return false;
  }

  setupEventListeners() {
    // Listen for connection established event (emitted by ConnectionManager)
    this.eventBus.on('connection:established', (pc) => {
      this.createDataChannel(pc);
    });

    // Listen for connection status changes
    this.eventBus.on('connection:statusChanged', (status) => {
      if (status === 'connected') {
        if (this.connectionState === 'disconnected') {
          this.connectionState = 'normal';
        }
      } else {
        this.connectionState = 'disconnected';
      }
      this.updateVideoCallBtnState();
      
      // Notify file transfer manager on connection state change
      if (this.context.fileTransferManager) {
        this.context.fileTransferManager.handleConnectionStatusChange(status);
      }
    });


  }

  setupDataChannel(dc) {
    if (!dc) {
      this.logger.error('setupDataChannel: dc parameter is undefined, skipping');
      return;
    }

    this.dataChannel = dc;
    this.dataChannel.binaryType = 'arraybuffer';
    // Expose to context for other modules (e.g. FileTransfer)
    this.context.dataChannel = dc;

    this.logger.info('Starting DataChannel configuration');
    this.logger.debug(`DataChannel Info: ID=${dc.id}, Label=${dc.label}, Status=${dc.readyState}`);

    this.clearAllTimers();

    dc.onopen = () => {
      this.eventBus.emit('datachannel:open');

      this.logger.info('🟢 DataChannel Opened');
      this.logger.debug(`DataChannel Open Details: Sender=${this.context.myEmail}, Target=${this.context.targetEmail}`);

      // Update UI status via event or direct DOM manipulation if needed
      // Prefer event or calling UI renderer
      if (this.context.uiRenderer) {
          this.context.uiRenderer.updateStatus(`@:  ${window.i18n?.t ? window.i18n.t('chat.connected') : 'Connected'}`);
      }

      this.connectionState = 'normal';
      if (this._shouldEmitStatus('connected')) {
        this.eventBus.emit('connection:statusChanged', 'connected');
      }

      // Clear connection timeout
      if (this.context.connectionManager) {
          this.context.connectionManager.clearConnectionTimeout(this.context.targetEmail);
      }
      this.logger.debug('Connected successfully, cleared connection timeout');

      // Reset heartbeat
      this.missedHeartbeats = 0;
      this.heartbeatCount = 0;

      // Start heartbeat
      this.setHeartbeatInterval(this.config.HEARTBEAT_INTERVAL_NORMAL || 3000);
      this.logger.info(`Started heartbeat mechanism, interval=${this.config.HEARTBEAT_INTERVAL_NORMAL}ms`);

      // Notify parent/main process
      // Since we are in the main window now, we might not need postMessage to parent.
      // But we might need to update app state.
      this.context.element.dispatchEvent(new CustomEvent('datachannel-status', {
        detail: {
            email: this.context.targetEmail,
            status: 'connected'
        }
      }));

      // Notify discover email confirmed
      this.context.element.dispatchEvent(new CustomEvent('discover-email-confirmed', {
        detail: { email: this.context.targetEmail }
      }));

      // Reset retry counts
      if (this.context.connectionManager) {
          this.context.connectionManager.connectionRetryCounts.delete(this.context.targetEmail);
      }

      this.updateVideoCallBtnState();
      
      if (this.context.connectionManager) {
          this.context.connectionManager.handshakeInProgress = false;
      }
    };

    dc.bufferedAmountLowThreshold = this.bufferedAmountLowThreshold;

    dc.onmessage = (e) => {
      // Use cached debug flag to avoid frequent localStorage reads
      const trace = debugConfigCache.isEnabled('MAILINK_FILE_TRANSFER_TRACE', '1');

      const len =
        typeof e?.data === 'string'
          ? e.data.length
          : (e?.data && (e.data.byteLength || e.data.size)) || 0;
      if (trace) {
        this.logger.debug(`Received DataChannel message, length=${len}`);
      }

      const handleBinary = (arrayBuffer) => {
        // Find matching header
        let matchedKey = null;
        let header = null;
        
        for (const [key, h] of this.pendingBinaryHeaders) {
          if (h.byteLength === arrayBuffer.byteLength) {
            matchedKey = key;
            header = h;
            break;
          }
        }
        
        if (!header || !header.id) {
          if (trace) this.logger.warn(`Received binary DataChannel message without matching header, size: ${arrayBuffer.byteLength}, pending headers: ${this.pendingBinaryHeaders.size}`);
          return;
        }
        
        // Delete used header
        this.pendingBinaryHeaders.delete(matchedKey);
        
        const payload = {
          ...header,
          type: 'file-data',
          data: arrayBuffer
        };
        this.eventBus.emit('datachannel:messageReceived', payload);
        if (trace) {
          this.logger.debug(`Dispatching DataChannel binary, type=file-data, id=${payload.id}, offset=${payload.offset}`);
        }
      };

      try {
        if (typeof e.data !== 'string') {
          if (e.data instanceof ArrayBuffer) {
            handleBinary(e.data);
            return;
          }
          if (e.data && typeof e.data.arrayBuffer === 'function') {
            e.data.arrayBuffer().then(handleBinary).catch(err => this.logger.debug('ArrayBuffer conversion failed:', err));
            return;
          }
          throw new Error('non-string datachannel message');
        }

        const data = safeJsonParse(e.data, null);
        if (!data) {
          this.logger.warn('Failed to parse DataChannel message');
          return;
        }
        if (trace) {
          this.logger.debug(`Parsed DataChannel message, type=${data.type}`);
        }

        if (data.type === 'file-data-binary') {
          // Store header with unique key to avoid being overwritten
          const key = `${data.id}-${data.offset}`;
          this.pendingBinaryHeaders.set(key, data);
          if (trace) {
            this.logger.debug(`Stored binary header: ${key}, pending count: ${this.pendingBinaryHeaders.size}`);
          }
          return;
        }

        if (data.type === 'heartbeat') {
          this.logger.info(`💓 Received Heartbeat #${data.count}`);
          const heartbeatResponse = {
            type: 'heartbeat-response',
            count: data.count,
            timestamp: Date.now()
          };
          this.sendData(heartbeatResponse);
        } else if (data.type === 'heartbeat-response') {
          this.logger.info(`💓 Received Heartbeat Response #${data.count}`);
          this.handleHeartbeatResponse(data);
        } else {
          // Dispatch to EventBus
          this.eventBus.emit('datachannel:messageReceived', data);
          if (trace) {
            this.logger.debug(`Dispatching DataChannel message, type=${data.type}`);
          }

          // Handle media signaling
          if (data.type === 'voice-offer') {
            this.eventBus.emit('media:voice-offer', data);
          } else if (data.type === 'voice-answer') {
            this.eventBus.emit('media:voice-answer', data);
          } else if (data.type === 'video-offer') {
            this.eventBus.emit('media:video-offer', data);
          } else if (data.type === 'video-answer') {
            this.eventBus.emit('media:video-answer', data);
          } else if (data.type === 'end-call') {
            this.eventBus.emit('media:end-call', data);
          }
        }
      } catch (err) {
        // Fallback for non-JSON messages (simple chat)
        this.logger.info('Received plain text message');
        if (this.context.uiRenderer) {
            this.context.uiRenderer.displayMessage('peer', e.data);
        }
        
        // Update contact last message
        this.context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
            detail: {
                email: this.context.targetEmail,
                message: e.data
            }
        }));
      }
    };

    dc.onclose = () => {
      this.logger.info('🔴 [debug]DataChannel Closed');
      this.logger.info(`[debug]current targetEmail: ${this.context?.targetEmail}`);
      this.clearAllTimers();

      this.connectionState = 'disconnected';
      if (this._shouldEmitStatus('disconnected')) {
        this.logger.info('[debug]trigger connection:statusChanged -> disconnected');
        this.eventBus.emit('connection:statusChanged', 'disconnected');
      }

      this.updateVideoCallBtnState();

      this.context.element.dispatchEvent(new CustomEvent('datachannel-status', {
        detail: {
            email: this.context.targetEmail,
            status: 'disconnected'
        }
      }));

      // When DataChannel closes, trigger full reset and reconnect regardless of active window
      const isActive = this._isActiveWindow();
      this.logger.info(`🔄 [simplified reconnect] DataChannel close (${isActive ? 'active' : 'inactive'} window), trigger full reset and reconnect`);
      this.eventBus.emit('connection:fullResetAndReconnect');
    };

    dc.onerror = (error) => {
      const details = {
        readyState: dc?.readyState,
        bufferedAmount: dc?.bufferedAmount,
        error: error?.message || error
      };
      this.logger.error('DataChannel Error', details);
      this.clearAllTimers();

      this.connectionState = 'disconnected';
      if (this._shouldEmitStatus('disconnected')) {
        this.eventBus.emit('connection:statusChanged', 'disconnected');
      }
      
      this.updateVideoCallBtnState();

      this.context.element.dispatchEvent(new CustomEvent('datachannel-status', {
        detail: {
            email: this.context.targetEmail,
            status: 'error',
            message: error.message
        }
      }));
    };
  }

  createDataChannel(pc) {
    this.logger.info('Creating DataChannel');
    try {
        const dc = pc.createDataChannel('data', {
            ordered: true
        });
        this.setupDataChannel(dc);
    } catch (e) {
        this.logger.error('Failed to create DataChannel', e);
    }
  }

  isOpen() {
    return this.dataChannel && this.dataChannel.readyState === 'open';
  }

  getBufferedAmount() {
    const dc = this.dataChannel;
    if (!dc) return 0;
    const amount = dc.bufferedAmount;
    return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
  }

  sendData(data) {
      const dc = this.dataChannel;
      if (!dc || dc.readyState !== 'open') {
          this.logger.warn('Cannot send data: DataChannel not open');
          return false;
      }

      const bufferedAmount = this.getBufferedAmount();
      if (bufferedAmount > this.maxBufferedAmount) {
          return false;
      }

      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      try {
          dc.send(payload);
          return true;
      } catch (error) {
          this.logger.error('DataChannel send failed', error);
          return false;
      }
  }

  sendBinary(data) {
      const dc = this.dataChannel;
      if (!dc || dc.readyState !== 'open') {
          this.logger.warn('Cannot send binary: DataChannel not open');
          return false;
      }

      const bufferedAmount = this.getBufferedAmount();
      if (bufferedAmount > this.maxBufferedAmount) {
          return false;
      }

      try {
          dc.send(data);
          return true;
      } catch (error) {
          this.logger.error('DataChannel send binary failed', error);
          return false;
      }
  }

  async sendDataReliable(data, options = {}) {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 20000;
    const intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : 50;
    const start = Date.now();

    while (true) {
      const ok = this.sendData(data);
      if (ok) return true;

      if (Date.now() - start >= timeoutMs) {
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  async sendBinaryReliable(data, options = {}) {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 20000;
    const intervalMs = typeof options.intervalMs === 'number' ? options.intervalMs : 50;
    const start = Date.now();

    while (true) {
      const ok = this.sendBinary(data);
      if (ok) return true;

      if (Date.now() - start >= timeoutMs) {
        return false;
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  sendHeartbeat() {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      const heartbeatData = {
        type: 'heartbeat',
        count: this.heartbeatCount,
        timestamp: Date.now()
      };
      try {
        const ok = this.sendData(heartbeatData);
        if (!ok) return;
        this.heartbeatCount++;
        
        this.heartbeatTimeout = setTimeout(() => {
          this.handleHeartbeatTimeout();
        }, 10000); 
      } catch (error) {
        this.logger.error('Failed to send heartbeat:', error);
        this.handleHeartbeatTimeout();
      }
    }
  }

  handleHeartbeatTimeout() {
    this.missedHeartbeats++;
    this.logger.warn(`⏱️ Heartbeat missed: ${this.missedHeartbeats}`);

    // simplified：Log only，No longer trigger reconnection via heartbeat
    // Actual reconnection by DataChannel onclose Event triggered
  }

  handleHeartbeatResponse(data) {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }

    this.missedHeartbeats = 0;

    // Reset to normal state when connection recovers
    if (this.connectionState !== 'normal') {
      this.enterNormalState();
    }
  }

  enterNormalState() {
    this.connectionState = 'normal';
    this.logger.info('✅ Connection state: Normal');

    if (this.suspiciousTimer) {
      clearTimeout(this.suspiciousTimer);
      this.suspiciousTimer = null;
    }

    this.setHeartbeatInterval(this.config.HEARTBEAT_INTERVAL_NORMAL || 3000);
  }



  setHeartbeatInterval(interval) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
  }



  clearAllTimers() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    if (this.suspiciousTimer) {
      clearTimeout(this.suspiciousTimer);
      this.suspiciousTimer = null;
    }
    if (this.globalConnectionTimeout) {
      clearTimeout(this.globalConnectionTimeout);
      this.globalConnectionTimeout = null;
    }
  }

  updateVideoCallBtnState() {
    // In Web Component, we might need to notify UI Renderer or update button directly
    // Assuming UI Renderer handles button states based on 'connection:statusChanged'
    // But we can also emit specific event
    const isConnected = this.connectionState === 'normal' || this.connectionState === 'fluctuation'; // Relaxed check
    this.eventBus.emit('ui:videoBtnState', isConnected);
    
    // Also update media call button states if we're in a call
    const mediaCallManager = this.context?.mediaCallManager;
    if (mediaCallManager && mediaCallManager.isInCall) {
      this.eventBus.emit('media:callStateChanged', { 
        isInCall: mediaCallManager.isInCall, 
        callMode: mediaCallManager.callMode 
      });
    }
  }

  setupNetworkQualityMonitoring() {
    if ('connection' in navigator) {
      this.networkMonitor = navigator.connection;
      this.updateNetworkQuality();
      this.networkMonitor.addEventListener('change', () => {
        this.updateNetworkQuality();
      });
    }
  }

  updateNetworkQuality() {
    if (this.networkMonitor) {
      this.networkQuality = {
        type: this.networkMonitor.type || 'unknown',
        rtt: this.networkMonitor.rtt || 0,
        downlink: this.networkMonitor.downlink || 0,
        effectiveType: this.networkMonitor.effectiveType || 'unknown',
        saveData: this.networkMonitor.saveData || false
      };
      // Logic to adjust heartbeat based on network quality can be added here
    }
  }

}
