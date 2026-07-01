/**
 * General utility functions module
 * Encapsulates frequently used utility functions across the project
 */

/**
 * Validate whether the email format is valid
 * @param {string} email - email address
 * @returns {boolean} whether it is valid
 */
export function isValidEmail(email) {
  if (!email) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Parse role information (Polite/Impolite Peer pattern)
 * @param {string} myEmail - current user email
 * @param {string} targetEmail - target user email
 * @returns {Object} role information object
 */
export function resolveRole(myEmail, targetEmail) {
  const trimmedMyEmail = typeof myEmail === 'string' ? myEmail.trim() : '';
  const trimmedTargetEmail = typeof targetEmail === 'string' ? targetEmail.trim() : '';
  const valid = !!trimmedMyEmail && !!trimmedTargetEmail;

  if (!valid) {
    return {
      myEmail: trimmedMyEmail,
      targetEmail: trimmedTargetEmail,
      polite: true,
      role: 'unknown',
      valid: false,
      reason: 'Incomplete email information'
    };
  }

  if (trimmedMyEmail === trimmedTargetEmail) {
    return {
      myEmail: trimmedMyEmail,
      targetEmail: trimmedTargetEmail,
      polite: false,
      role: 'same',
      valid: true,
      reason: 'Same email'
    };
  }

  const polite = trimmedMyEmail > trimmedTargetEmail;
  const role = trimmedMyEmail < trimmedTargetEmail ? 'sender' : 'receiver';
  return {
    myEmail: trimmedMyEmail,
    targetEmail: trimmedTargetEmail,
    polite,
    role,
    valid: true,
    reason: polite
      ? `${trimmedMyEmail} > ${trimmedTargetEmail}，I am Receiver (Polite Peer)`
      : `${trimmedMyEmail} < ${trimmedTargetEmail}，I am Sender (Impolite Peer)`
  };
}

/**
 * Determine whether the current user is the Polite Peer
 * @param {string} myEmail - current user email
 * @param {string} targetEmail - target user email
 * @returns {boolean} whether it is the Polite Peer
 */
export function isPolite(myEmail, targetEmail) {
  return resolveRole(myEmail, targetEmail).polite;
}

/**
 * Determine whether the current user is the Sender
 * @param {string} myEmail - current user email
 * @param {string} targetEmail - target user email
 * @returns {boolean} whether it is the Sender
 */
export function isSender(myEmail, targetEmail) {
  const roleInfo = resolveRole(myEmail, targetEmail);
  return roleInfo.valid && roleInfo.role === 'sender';
}

/**
 * Determine whether the current user is the Receiver
 * @param {string} myEmail - current user email
 * @param {string} targetEmail - target user email
 * @returns {boolean} whether it is the Receiver
 */
export function isReceiver(myEmail, targetEmail) {
  const roleInfo = resolveRole(myEmail, targetEmail);
  return roleInfo.valid && roleInfo.role === 'receiver';
}

/**
 * Delay function
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Promise with a timeout limit
 * @param {Promise|Function} promiseOrFn - Promise or function returning a Promise
 * @param {number} timeoutMs - timeout in milliseconds
 * @param {string} errorMessage - timeout error message
 * @returns {Promise}
 */
export function withTimeout(promiseOrFn, timeoutMs = 5000, errorMessage = 'Operation timed out') {
  const promise = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${errorMessage} (${timeoutMs}ms)`));
      }, timeoutMs);
    })
  ]);
}

/**
 * Generate unique message ID
 * @returns {string} Message ID
 */
export function generateMessageId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `msg-${timestamp}-${random}`;
}

/**
 * Generate a unique file ID
 * @returns {string} file ID
 */
export function generateFileId() {
  return `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Safely parse JSON
 * @param {string} jsonString - JSON string
 * @param {*} defaultValue - default value when parsing fails
 * @returns {*} parsed result or default value
 */
export function safeJsonParse(jsonString, defaultValue = null) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    return defaultValue;
  }
}

/**
 * Format byte size
 * @param {number} bytes - number of bytes
 * @param {number} decimals - decimal places
 * @returns {string} formatted string
 */
export function formatBytes(bytes, decimals = 2) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  const value = n / Math.pow(k, i);
  const fixed = i === 0 ? 0 : Math.max(0, Math.min(20, Number(decimals) || 0));

  return `${parseFloat(value.toFixed(fixed))} ${sizes[i]}`;
}

/**
 * Get the current user email (unified entry)
 * @returns {string} current user email
 */
export function getMyEmail() {
  return sessionStorage.getItem('mymail') ||
         window.selectedConfig?.username ||
         window.currentMyEmail ||
         '';
}

/**
 * Debug config cache manager
 * Caches debug flags from localStorage to avoid frequent reads
 */
export class DebugConfigCache {
  constructor() {
    this._cache = new Map();
    this._lastCheck = new Map();
    this.CACHE_TTL_MS = 5000; // 5-second cache
    
    // Listen for localStorage changes and update the cache
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key && this._cache.has(e.key)) {
          this._cache.set(e.key, e.newValue);
          this._lastCheck.set(e.key, Date.now());
        }
      });
    }
  }
  
  /**
   * Get the debug flag value
   * @param {string} key - localStorage key
   * @param {string} defaultValue - default value
   * @returns {string|null} config value
   */
  get(key, defaultValue = null) {
    const now = Date.now();
    const lastCheck = this._lastCheck.get(key) || 0;
    
    // Return the cached value directly if the cache has not expired
    if (now - lastCheck < this.CACHE_TTL_MS && this._cache.has(key)) {
      return this._cache.get(key);
    }
    
    // Read from localStorage when the cache is expired or missing
    try {
      const value = typeof localStorage !== 'undefined' 
        ? localStorage.getItem(key) 
        : defaultValue;
      this._cache.set(key, value);
      this._lastCheck.set(key, now);
      return value;
    } catch (e) {
      return defaultValue;
    }
  }
  
  /**
   * Check whether the debug flag equals a specific value
   * @param {string} key - localStorage key
   * @param {string} expectedValue - expected value
   * @returns {boolean} whether it matches
   */
  isEnabled(key, expectedValue = '1') {
    return this.get(key) === expectedValue;
  }
  
  /**
   * Clear the cache for the specified key
   * @param {string} key - localStorage key
   */
  clear(key) {
    this._cache.delete(key);
    this._lastCheck.delete(key);
  }
  
  /**
   * Clear all caches
   */
  clearAll() {
    this._cache.clear();
    this._lastCheck.clear();
  }
}

// Export singleton instance
export const debugConfigCache = new DebugConfigCache();
