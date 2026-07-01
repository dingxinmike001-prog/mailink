/**
 * Signaling sequence number manager
 * Manages WebRTC signaling sequence numbers to ensure signals are processed in the correct order and to prevent stale signals from interfering
 */
import { SIGNALING_EMAIL_PREFIX } from '../../../../shared/config/signaling-constants.js';

export class SignalingSequenceManager {
  constructor(logger) {
    this.logger = logger || console;
    // Track sent sequence numbers: targetEmail -> { sequence, timestamp, type }
    this.sentSequences = new Map();
    // Track received and processed sequence numbers: targetEmail -> { sequence, timestamp, type }
    this.receivedSequences = new Map();
    // Track pending offers: targetEmail -> { sequence, timestamp, status }
    this.pendingOffers = new Map();
    // Track processed answer sequence numbers (global deduplication)
    this.processedAnswers = new Set();
    // Sequence number validity period (default 60 seconds)
    this.sequenceValidityPeriod = 60000;
    // Cleanup interval
    this.cleanupInterval = null;
    
    // Start periodic cleanup
    this.startCleanupTimer();
  }

  /**
   * Start the periodic cleanup timer
   */
  startCleanupTimer() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredEntries();
    }, 30000); // Clean up every 30 seconds
  }

  /**
   * Stop the cleanup timer
   */
  stopCleanupTimer() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get the next sequence number
   * @param {string} targetEmail - Target email address
   * @param {string} type - Signaling type (discover, offer, answer)
   * @returns {number} Next sequence number
   */
  getNextSequence(targetEmail, type = 'signal') {
    const normalizedEmail = this.normalizeEmail(targetEmail);
    const current = this.sentSequences.get(normalizedEmail)?.sequence || 0;
    const next = current + 1;
    
    this.recordSentSequence(targetEmail, next, type);
    
    this.logger.debug(`[SignalingSequence] generated sequence: ${normalizedEmail} -> ${next} (${type})`);
    return next;
  }

  /**
   * 🆕 Generate a unique timestamp-based sequence number (used during reconnection)
   * Ensures a fresh unique sequence number is used on each reconnection to avoid conflicts with previous signals
   * @param {string} targetEmail - Target email address
   * @param {string} type - Signaling type
   * @returns {number} Unique sequence number
   */
  getUniqueSequence(targetEmail, type = 'signal') {
    const normalizedEmail = this.normalizeEmail(targetEmail);
    // Generate a unique sequence number using the last 9 digits of the timestamp plus a random number (0-999)
    // This ensures uniqueness while keeping the number from growing too large
    const timestamp = Date.now() % 1000000000; // Take the last 9 digits
    const random = Math.floor(Math.random() * 1000);
    const uniqueSequence = timestamp * 1000 + random;
    
    this.recordSentSequence(targetEmail, uniqueSequence, type);
    
    this.logger.info(`[SignalingSequence] generated unique sequence (reconnect): ${normalizedEmail} -> ${uniqueSequence} (${type})`);
    return uniqueSequence;
  }

  /**
   * Record a sent sequence number, allowing an explicit sequence number to be specified externally
   * @param {string} targetEmail - Target email address
   * @param {number} sequence - Sequence number
   * @param {string} type - Signaling type
   */
  recordSentSequence(targetEmail, sequence, type = 'signal') {
    const normalizedEmail = this.normalizeEmail(targetEmail);
    const currentEntry = this.sentSequences.get(normalizedEmail);

    this.sentSequences.set(normalizedEmail, {
      sequence,
      timestamp: Date.now(),
      type,
      history: [...(currentEntry?.history || []).slice(-4), { sequence, type, timestamp: Date.now() }]
    });
  }

  /**
   * Validate whether a received sequence number is valid (not expired and not already processed)
   * @param {string} fromEmail - Sender email address
   * @param {number} sequence - Sequence number
   * @param {string} type - Signaling type
   * @returns {boolean} Whether valid
   */
  isValidSequence(fromEmail, sequence, type) {
    const normalizedEmail = this.normalizeEmail(fromEmail);
    const now = Date.now();
    
    // Check whether the sequence number is positive
    if (!sequence || sequence <= 0) {
      this.logger.warn(`[SignalingSequence] invalid sequence number: ${sequence} from  ${normalizedEmail}`);
      return false;
    }
    
    const lastProcessed = this.receivedSequences.get(normalizedEmail);
    
    // Reject if a newer or identical sequence number has already been processed
    if (lastProcessed) {
      if (sequence < lastProcessed.sequence) {
        this.logger.warn(`[SignalingSequence] rejected expired signal: ${normalizedEmail} sequence number ${sequence} < ${lastProcessed.sequence}`);
        return false;
      }
      
      if (sequence === lastProcessed.sequence) {
        this.logger.warn(`[SignalingSequence] rejected duplicate signal: ${normalizedEmail} sequence number ${sequence}`);
        return false;
      }
    }
    
    // Check whether it is within the validity period (for discover type)
    if (type === 'discover') {
      const entry = this.receivedSequences.get(normalizedEmail);
      if (entry && entry.type === 'discover') {
        const age = now - entry.timestamp;
        if (age > this.sequenceValidityPeriod) {
          this.logger.warn(`[SignalingSequence] discover signal expired: ${normalizedEmail} age ${age}ms`);
          return false;
        }
      }
    }
    
    return true;
  }

  /**
   * Record a processed sequence number
   * @param {string} fromEmail - Sender email address
   * @param {number} sequence - Sequence number
   * @param {string} type - Signaling type
   */
  markSequenceProcessed(fromEmail, sequence, type) {
    const normalizedEmail = this.normalizeEmail(fromEmail);
    
    this.receivedSequences.set(normalizedEmail, {
      sequence,
      timestamp: Date.now(),
      type
    });
    
    this.logger.debug(`[SignalingSequence] Processed: ${normalizedEmail} -> ${sequence} (${type})`);
  }

  /**
   * Check whether the offer should be processed
   * @param {string} fromEmail - Sender email address
   * @param {number} sequence - Sequence number
   * @returns {boolean}
   */
  shouldProcessOffer(fromEmail, sequence) {
    const normalizedEmail = this.normalizeEmail(fromEmail);
    
    // First validate the sequence number
    if (!this.isValidSequence(fromEmail, sequence, 'offer')) {
      return false;
    }
    
    const pending = this.pendingOffers.get(normalizedEmail);
    if (pending) {
      // Ignore if a newer sequence number has already been processed
      if (pending.sequence > sequence) {
        this.logger.warn(`[SignalingSequence] newer offer already exists: ${normalizedEmail} current ${pending.sequence} > received ${sequence}`);
        return false;
      }
      
      // Ignore if the same sequence number is already being processed
      if (pending.sequence === sequence) {
        this.logger.warn(`[SignalingSequence] processing same offer: ${normalizedEmail} sequence number ${sequence}`);
        return false;
      }
    }
    
    return true;
  }

  /**
   * Record a pending offer
   * @param {string} toEmail - Target email address
   * @param {number} sequence - Sequence number
   */
  markOfferPending(toEmail, sequence) {
    const normalizedEmail = this.normalizeEmail(toEmail);
    
    this.pendingOffers.set(normalizedEmail, {
      sequence,
      timestamp: Date.now(),
      status: 'pending'
    });
    
    this.logger.debug(`[SignalingSequence] marked pending offer: ${normalizedEmail} -> ${sequence}`);
  }

  /**
   * Mark the offer as completed
   * @param {string} toEmail - Target email address
   * @param {string} status - Completion status (completed, failed, timeout, cleanup)
   */
  markOfferCompleted(toEmail, status = 'completed') {
    const normalizedEmail = this.normalizeEmail(toEmail);
    const pending = this.pendingOffers.get(normalizedEmail);

    if (pending) {
      pending.status = status;
      pending.completedAt = Date.now();
      this.logger.debug(`[SignalingSequence] offer completed: ${normalizedEmail} sequence number ${pending.sequence} status ${status}`);

      // Clean up immediately for timeout and cleanup states to ensure new offers can be sent normally during subsequent reconnections
      // Delay cleanup for other states to handle delayed responses
      if (status === 'timeout' || status === 'cleanup') {
        this.pendingOffers.delete(normalizedEmail);
        this.logger.debug(`[SignalingSequence] clean immediately${status}statusoffer: ${normalizedEmail}`);
      } else {
        // Delayed cleanup
        setTimeout(() => {
          this.pendingOffers.delete(normalizedEmail);
        }, 5000);
      }
    }
  }

  /**
   * Check whether there is a pending offer
   * @param {string} targetEmail - Target email address
   * @returns {boolean}
   */
  hasPendingOffer(targetEmail) {
    const normalizedEmail = this.normalizeEmail(targetEmail);
    const pending = this.pendingOffers.get(normalizedEmail);
    
    if (!pending) return false;
    
    // Check if expired
    const age = Date.now() - pending.timestamp;
    if (age > this.sequenceValidityPeriod * 2) {
      this.logger.warn(`[SignalingSequence] cleaned expired pending offer: ${normalizedEmail} age ${age}ms`);
      this.pendingOffers.delete(normalizedEmail);
      return false;
    }
    
    return pending.status === 'pending';
  }

  /**
   * Check whether the answer should be processed
   * @param {number} sequence - Sequence number
   * @returns {boolean}
   */
  shouldProcessAnswer(sequence) {
    if (this.processedAnswers.has(sequence)) {
      this.logger.warn(`[SignalingSequence] rejected duplicate answer: sequence number ${sequence}`);
      return false;
    }
    return true;
  }

  /**
   * Mark the answer as processed
   * @param {number} sequence - Sequence number
   */
  markAnswerProcessed(sequence) {
    this.processedAnswers.add(sequence);
    this.logger.debug(`[SignalingSequence] answer processed: sequence number ${sequence}`);
    
    // Limit the collection size
    if (this.processedAnswers.size > 1000) {
      const iterator = this.processedAnswers.values();
      const first = iterator.next().value;
      this.processedAnswers.delete(first);
    }
  }

  /**
   * Extract the sequence number from the email subject
   * @param {string} subject - Email subject
   * @returns {number|null} Sequence number or null
   */
  extractSequenceFromSubject(subject) {
    if (!subject) return null;
    
    // Match the {SIGNALING_EMAIL_PREFIX}{type}-{sequence} format
    const match = subject.match(new RegExp(SIGNALING_EMAIL_PREFIX + '[\\w-]+-(\\d+)$'));
    if (match) {
      return parseInt(match[1], 10);
    }
    
    return null;
  }

  /**
   * Generate an email subject with a sequence number
   * @param {string} type - Signaling type
   * @param {string} targetEmail - Target email address
   * @returns {string} Email subject
   */
  generateSubject(type, targetEmail, explicitSequence = null) {
    const sequence = explicitSequence ?? this.getNextSequence(targetEmail, type);
    if (explicitSequence !== null) {
      this.recordSentSequence(targetEmail, sequence, type);
    }
    return `${SIGNALING_EMAIL_PREFIX}${type}-${sequence}`;
  }

  /**
   * Clean up expired entries
   */
  cleanupExpiredEntries() {
    const now = Date.now();
    let cleanedCount = 0;
    
    // Clean up sent records
    for (const [email, data] of this.sentSequences) {
      if (now - data.timestamp > this.sequenceValidityPeriod * 3) {
        this.sentSequences.delete(email);
        cleanedCount++;
      }
    }
    
    // Clean up received records
    for (const [email, data] of this.receivedSequences) {
      if (now - data.timestamp > this.sequenceValidityPeriod * 3) {
        this.receivedSequences.delete(email);
        cleanedCount++;
      }
    }
    
    // Clean up pending offers
    for (const [email, data] of this.pendingOffers) {
      if (now - data.timestamp > this.sequenceValidityPeriod * 2) {
        this.pendingOffers.delete(email);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      this.logger.debug(`[SignalingSequence] cleaned ${cleanedCount} expired entries`);
    }
  }

  /**
   * Reset the state for a specific email address
   * @param {string} email - Email address
   */
  resetState(email) {
    const normalizedEmail = this.normalizeEmail(email);
    
    this.sentSequences.delete(normalizedEmail);
    this.receivedSequences.delete(normalizedEmail);
    this.pendingOffers.delete(normalizedEmail);
    
    this.logger.info(`[SignalingSequence] reset state: ${normalizedEmail}`);
  }

  /**
   * Reset all state
   */
  resetAllState() {
    this.sentSequences.clear();
    this.receivedSequences.clear();
    this.pendingOffers.clear();
    this.processedAnswers.clear();
    
    this.logger.info('[SignalingSequence] reset all states');
  }

  /**
   * Normalize an email address
   * @param {string} email - Email address
   * @returns {string} Normalized email address
   */
  normalizeEmail(email) {
    if (!email) return '';
    return email.toLowerCase().trim();
  }

  /**
   * Get a summary of the current state
   * @returns {Object} State summary
   */
  getStatusSummary() {
    return {
      sentSequences: this.sentSequences.size,
      receivedSequences: this.receivedSequences.size,
      pendingOffers: this.pendingOffers.size,
      processedAnswers: this.processedAnswers.size,
      pendingDetails: Array.from(this.pendingOffers.entries()).map(([email, data]) => ({
        email,
        sequence: data.sequence,
        status: data.status,
        age: Date.now() - data.timestamp
      }))
    };
  }

  /**
   * Destroy the manager
   */
  destroy() {
    this.stopCleanupTimer();
    this.resetAllState();
  }
}

export default SignalingSequenceManager;
