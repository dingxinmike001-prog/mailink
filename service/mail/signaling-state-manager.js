/**
 * Signaling transmission state manager
 * Used to track WebRTC signaling transmission state and optimize file writes during signaling transmission
 */
class SignalingStateManager {
  constructor() {
    this.isSignalingActive = false;
    this.signalingStartTime = 0;
    this.signalingTimeout = null;
    this.listeners = new Set();
    this.STATELOG_THROTTLE_MS = 100;
  }

  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!SignalingStateManager.instance) {
      SignalingStateManager.instance = new SignalingStateManager();
    }
    return SignalingStateManager.instance;
  }

  /**
   * Start signaling transmission
   * @param {string} signalType - Signal type (offer, answer, ice-candidate)
   */
  startSignaling(signalType = 'unknown') {
    if (!this.isSignalingActive) {
      this.isSignalingActive = true;
      this.signalingStartTime = Date.now();
      this._notifyListeners({ type: 'start', signalType });
    }

    if (this.signalingTimeout) {
      clearTimeout(this.signalingTimeout);
    }

    this.signalingTimeout = setTimeout(() => {
      this.endSignaling();
    }, 5000);
  }

  /**
   * End signaling transmission
   */
  endSignaling() {
    if (this.isSignalingActive) {
      this.isSignalingActive = false;
      this.signalingStartTime = 0;
      if (this.signalingTimeout) {
        clearTimeout(this.signalingTimeout);
        this.signalingTimeout = null;
      }
      this._notifyListeners({ type: 'end' });
    }
  }

  /**
   * Check whether currently in signaling transmission
   */
  isActive() {
    return this.isSignalingActive;
  }

  /**
   * Add state listener
   * @param {Function} callback - Callback function
   */
  onStateChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify all listeners
   */
  _notifyListeners(data) {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (err) {
        console.error('SignalingStateManager listener error:', err);
      }
    }
  }

  /**
   * Get signaling transmission duration
   */
  getDuration() {
    if (!this.isSignalingActive || this.signalingStartTime === 0) {
      return 0;
    }
    return Date.now() - this.signalingStartTime;
  }

  /**
   * Get current state
   */
  getState() {
    return {
      isActive: this.isSignalingActive,
      duration: this.getDuration(),
      throttleInterval: this.STATELOG_THROTTLE_MS
    };
  }
}

module.exports = SignalingStateManager.getInstance();
