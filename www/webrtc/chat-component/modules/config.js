
// Config module - configuration constants

// WebRTC config
export const config = {
  // ICE server config (IPv4)
  iceServers: [
    // Domestic STUN servers (preferred, low latency)
    { urls: 'stun:stun.miwifi.com:3478' },  // Xiaomi (preferred, lowest latency)
    { urls: 'stun:global.stun.twilio.com:3478' },  // Twilio (available in China)
    { urls: 'stun:stun.l.google.com:19302' },  // Google (available in China)
    // International STUN servers (fallback)
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.voipstunt.com:3478' }
  ],
  
  // IPv6-specific STUN server config
  ipv6StunServers: [
    { urls: 'stun:[2001:4860:4860::8888]:3478' },  // Google IPv6 STUN primary
    { urls: 'stun:[2001:4860:4860::8844]:3478' },  // Google IPv6 STUN backup
    { urls: 'stun:[2606:2800:220:1:248:1893:25c8:1946]:3478' }  // Alternate IPv6
  ],
  
  // Initial ICE candidate pool size
  iceCandidatePoolSize: 10,
  // ICE collection timeout (ms)
  ICE_GATHERING_TIMEOUT: 10000,
  // Minimum candidate count required to send Answer early
  MIN_CANDIDATES_TO_PROCEED: 1,
  // [P0 Optimization] Relay candidate collection timeout (ms)
  // Original value: 10000ms (10s)
  // New value: 5000ms (5s)
  // Optimization note: srflx is sufficient for NAT traversal; no need to wait long for relay
  RELAY_CANDIDATE_TIMEOUT: 5000,
  // [P0 Optimization] Whether to enable srflx optimization (stop waiting for relay once srflx is detected)
  ENABLE_SRFLX_OPTIMIZATION: true,
  // [P0 Optimization] Minimum candidate wait time after srflx detection (ms)
  SRFLX_WAIT_TIME_AFTER_DETECTION: 2000,
  // Whether to collect local host candidates (default false; avoid P2P direct connection in single-machine tests)
  ENABLE_HOST_CANDIDATE: false,
  // ICE disconnected state reconnect delay (ms)
  // Original value: 10000ms (10s), tends to hurt user experience
  // Optimized value: 6000ms (6s), enough for network self-recovery while improving responsiveness
  // Current value: 3000ms (3s), quickly detect peer disconnection and allow 1-2 ICE recovery chances
  ICE_DISCONNECTED_RECONNECT_DELAY: 3000
};

// Constant definitions
export const MAX_CONNECTION_RETRIES = 5;
export const CONNECTION_TIMEOUT = 90000; // 90-second connection timeout
export const MIN_SEND_INTERVAL = 3000; // Minimum send interval, 3 seconds
export const MAX_RETRIES = 3; // Max retry count
export const RETRY_DELAY = 500; // Retry delay, 500ms

// [P0 Optimization-Plan 2] Top-level export of ICE-related config to ensure correct config path propagation
// Avoid falling back to || 10000 when this.context.config.RELAY_CANDIDATE_TIMEOUT is undefined
export const RELAY_CANDIDATE_TIMEOUT = config.RELAY_CANDIDATE_TIMEOUT; // 5000ms
export const REQUIRE_RELAY_CANDIDATE = true; // Require relay candidates by default
export const ENABLE_SRFLX_OPTIMIZATION = config.ENABLE_SRFLX_OPTIMIZATION; // true
export const SRFLX_WAIT_TIME_AFTER_DETECTION = config.SRFLX_WAIT_TIME_AFTER_DETECTION; // 2000ms
export const ICE_DISCONNECTED_RECONNECT_DELAY = config.ICE_DISCONNECTED_RECONNECT_DELAY; // 6000ms
export const ENABLE_HOST_CANDIDATE = config.ENABLE_HOST_CANDIDATE; // false

// Network quality related config
export const HEARTBEAT_INTERVAL_NORMAL = 5000; // Normal state heartbeat interval, 5s (was 30s)
export const HEARTBEAT_INTERVAL_SUSPICIOUS = 2000; // Suspected state heartbeat interval, 2s (was 10s)
export const HEARTBEAT_INTERVAL_FLUCTUATION = 1000; // Fluctuating state heartbeat interval, 1s (was 5s)
export const HEARTBEAT_MISSED_THRESHOLD = 3; // Heartbeat loss threshold; exceeding this means disconnected
export const SUSPICIOUS_STATE_TIMEOUT = 10000; // Suspected state timeout, confirm real disconnection after 10s (was 30s)
export const BASE_RETRY_DELAY = 2000; // Base retry delay, 2s
export const MAX_RETRY_DELAY = 32000; // Max retry delay, 32s

// Progressive exponential backoff retry config
export const CONNECTION_RETRY_CONFIG = {
  // Stage 1: Fast retry (first 3 times, short interval)
  FAST_RETRY: {
    count: 3,
    baseDelay: 2000,      // 2-second base delay
    maxDelay: 5000        // Max 5s
  },
  
  // Stage 2: Standard retry (middle 3 times, medium interval)
  STANDARD_RETRY: {
    count: 3,
    baseDelay: 5000,      // 5-second base delay
    multiplier: 1.5,      // 1.5x exponential growth
    maxDelay: 15000       // Max 15s
  },

  // Stage 3: Slow retry (last 2 times, long interval)
  SLOW_RETRY: {
    count: 2,
    baseDelay: 15000,     // 15-second base delay
    multiplier: 2,        // 2x exponential growth
    maxDelay: 300000      // Max 300s (5 minutes)
  },

  // Total: 3 + 3 + 2 = 8 retries
  MAX_TOTAL_RETRIES: 8,
  
  // Wait time after each reconnect (exponential backoff)
  getRetryDelay: function(retryCount) {
    if (retryCount <= this.FAST_RETRY.count) {
      // Stage 1: 2s, 3s, 5s (1.3x growth)
      return Math.min(
        Math.round(this.FAST_RETRY.baseDelay * Math.pow(1.3, retryCount - 1)),
        this.FAST_RETRY.maxDelay
      );
    } else if (retryCount <= this.FAST_RETRY.count + this.STANDARD_RETRY.count) {
      // Stage 2: 5s, 7.5s, 11s (1.5x growth)
      const standardRetryIndex = retryCount - this.FAST_RETRY.count;
      return Math.min(
        Math.round(this.STANDARD_RETRY.baseDelay * Math.pow(this.STANDARD_RETRY.multiplier, standardRetryIndex - 1)),
        this.STANDARD_RETRY.maxDelay
      );
    } else {
      // Stage 3: 15s, 30s, 60s, 60s -> 15s, 30s (2x growth, max 2 times)
      const slowRetryIndex = retryCount - this.FAST_RETRY.count - this.STANDARD_RETRY.count;
      return Math.min(
        Math.round(this.SLOW_RETRY.baseDelay * Math.pow(this.SLOW_RETRY.multiplier, slowRetryIndex - 1)),
        this.SLOW_RETRY.maxDelay
      );
    }
  },
  
  // Get current stage description
  getRetryPhase: function(retryCount) {
    if (retryCount <= this.FAST_RETRY.count) {
      return 'fast';
    } else if (retryCount <= this.FAST_RETRY.count + this.STANDARD_RETRY.count) {
      return 'standard';
    } else {
      return 'slow';
    }
  }
};

// Define auto-acceptable image MIME types
export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml'
];

// Export default object
export default {
  config,
  MAX_CONNECTION_RETRIES,
  CONNECTION_TIMEOUT,
  MIN_SEND_INTERVAL,
  MAX_RETRIES,
  RETRY_DELAY,
  RELAY_CANDIDATE_TIMEOUT,
  REQUIRE_RELAY_CANDIDATE,
  ENABLE_SRFLX_OPTIMIZATION,
  SRFLX_WAIT_TIME_AFTER_DETECTION,
  HEARTBEAT_INTERVAL_NORMAL,
  HEARTBEAT_INTERVAL_SUSPICIOUS,
  HEARTBEAT_INTERVAL_FLUCTUATION,
  HEARTBEAT_MISSED_THRESHOLD,
  SUSPICIOUS_STATE_TIMEOUT,
  BASE_RETRY_DELAY,
  MAX_RETRY_DELAY,
  IMAGE_MIME_TYPES,
  CONNECTION_RETRY_CONFIG,
  ICE_DISCONNECTED_RECONNECT_DELAY,
  ENABLE_HOST_CANDIDATE
};
