/**
 * IMAP IDLE management and email pull module (queue version)
 * Integrates email queue manager and supports async Worker parsing
 */

const ImapLogger = require('./imap-logger');
const logger = require('../logger');
const { getEmailProcessorService } = require('./email-processor-service');

/**
 * IMAP IDLE manager (queue version)
 * Integrates async email parsing queue
 */
const ImapIdleManagerQueue = {

  // Email processor service instance
  processorService: null,

  /**
   * Initialize email processor service
   */
  initProcessorService() {
    if (!this.processorService) {
      this.processorService = getEmailProcessorService({
        poolSize: Math.min(4, require('os').cpus().length),
        maxQueueSize: 1000,
        taskTimeout: 30000
      });
      this.processorService.initialize();
      
      // Listen to processing events
      this.processorService.on('emailSaved', (data) => {
        logger.info(`[ImapIdleManagerQueue] email saved UID=${data.uid}, ID=${data.emailId}`);
      });
      
      this.processorService.on('emailFailed', (data) => {
        logger.error(`[ImapIdleManagerQueue] email processing failed UID=${data.uid}:`, data.error);
      });
    }
  },

  /**
   * Search emails
   */
  _searchEmails(imap, criteria) {
    return new Promise((resolve, reject) => {
      imap.search(criteria, (err, results) => {
        if (err) {
          reject(new Error(`Email search failed: ${err.message}`));
        } else {
          resolve(results);
        }
      });
    });
  },

  /**
   * Fetch emails and enqueue for async parsing (new approach)
   * Does not wait for parsing, returns immediately, processed by Worker in background
   * @param {Object} imap - IMAP instance
   * @param {Array} results - Email UID array
   * @param {Object} options - Fetch options
   * @param {string} username - Username
   * @returns {Promise<Array>} - Returns only the list of enqueued email UIDs
   */
  async _fetchEmailsAsync(imap, results, options, username) {
    return new Promise((resolve, reject) => {
      if (results.length === 0) {
        resolve([]);
        return;
      }

      results.sort((a, b) => a - b);

      const f = imap.fetch(results, options);
      const queuedUids = [];
      const uidArray = [...results];
      let messageIndex = 0;

      const fetchTimeout = setTimeout(() => {
        logger.warn('Email fetch timeout, resolving with queued emails');
        resolve(queuedUids);
      }, this.fetchTimeout || 30000);

      f.on('message', (msg) => {
        const uid = uidArray[messageIndex];
        messageIndex++;

        msg.on('body', (stream) => {
          const chunks = [];
          
          stream.on('data', (chunk) => {
            chunks.push(chunk);
          });

          stream.on('end', () => {
            try {
              const streamBuffer = Buffer.concat(chunks);
              
              // Initialize handler service
              this.initProcessorService();
              
              // Quickly determine if it is a signaling email (by checking subject in first 1KB of data)
              const preview = streamBuffer.slice(0, 1024).toString('utf8');
              const { SIGNALING_EMAIL_PREFIX } = require('../../shared/config/signaling-constants');
              const isSignaling = preview.includes(SIGNALING_EMAIL_PREFIX);
              
              // Enqueue for async processing (fire-and-forget mode)
              this.processorService.queueEmail(
                streamBuffer,
                uid,
                username,
                isSignaling
              );
              
              queuedUids.push({
                uid,
                isSignaling,
                queued: true
              });
              
              logger.debug(`[ImapIdleManagerQueue] email enqueued UID=${uid}, signaling=${isSignaling}`);
            } catch (error) {
              logger.error(`[ImapIdleManagerQueue] email enqueue failed UID=${uid}:`, error);
            }
          });
        });

        msg.once('attributes', () => {
          // reserved handling
        });

        msg.once('end', () => {
          // reserved handling
        });
      });

      f.once('error', (err) => {
        clearTimeout(fetchTimeout);
        logger.error('Failed to fetch email data:', err);
        reject(new Error(`Failed to fetch email data: ${err.message}`));
      });

      f.once('end', () => {
        clearTimeout(fetchTimeout);
        logger.debug(`[ImapIdleManagerQueue] Fetch end, ${queuedUids.length} emails queued`);
        resolve(queuedUids);
      });
    });
  },

  /**
   * Fetch emails and wait for parsing to complete (compatible with old approach)
   * Suitable for scenarios requiring immediate parsing results
   * @param {Object} imap - IMAP instance
   * @param {Array} results - Email UID array
   * @param {Object} options - Fetch options
   * @param {string} username - Username
   * @returns {Promise<Array>} - Parsed email array
   */
  async _fetchEmailsSync(imap, results, options, username) {
    return new Promise(async (resolve, reject) => {
      if (results.length === 0) {
        resolve([]);
        return;
      }

      results.sort((a, b) => a - b);

      const f = imap.fetch(results, options);
      const emailPromises = [];
      const uidArray = [...results];
      let messageIndex = 0;

      const fetchTimeout = setTimeout(() => {
        logger.warn('Email fetch timeout, resolving with completed emails');
        Promise.allSettled(emailPromises)
          .then(results => {
            const completedEmails = results
              .filter(result => result.status === 'fulfilled' && result.value)
              .map(result => result.value);
            resolve(completedEmails);
          })
          .catch(() => {
            resolve([]);
          });
      }, this.fetchTimeout || 30000);

      f.on('message', (msg) => {
        const uid = uidArray[messageIndex];
        messageIndex++;

        const emailPromise = new Promise(async (resolveEmail) => {
          const emailTimeout = setTimeout(() => {
            logger.warn(`Email processing timeout for UID: ${uid}`);
            resolveEmail(null);
          }, 10000);

          try {
            let streamBuffer = Buffer.alloc(0);

            msg.on('body', (stream) => {
              stream.on('data', (chunk) => {
                streamBuffer = Buffer.concat([streamBuffer, chunk]);
              });

              stream.on('end', async () => {
                try {
                  // Initialize handler service
                  this.initProcessorService();
                  
                  // Use queue service to parse emails
                  const result = await this.processorService.parseEmail(
                    streamBuffer,
                    uid,
                    username,
                    { timeout: 15000 }
                  );
                  
                  clearTimeout(emailTimeout);
                  resolveEmail(result.emailData);
                } catch (parseErr) {
                  logger.error(`Email parsing failed for UID ${uid}:`, parseErr);
                  clearTimeout(emailTimeout);
                  resolveEmail(null);
                }
              });
            });

            msg.once('attributes', () => {
              // reserved handling
            });

            msg.once('end', () => {
              // reserved handling
            });
          } catch (err) {
            logger.error(`Error processing email UID ${uid}:`, err);
            clearTimeout(emailTimeout);
            resolveEmail(null);
          }
        });

        emailPromises.push(emailPromise);
      });

      f.once('error', (err) => {
        clearTimeout(fetchTimeout);
        logger.error('Failed to fetch email data:', err);
        reject(new Error(`Failed to fetch email data: ${err.message}`));
      });

      f.once('end', () => {
        clearTimeout(fetchTimeout);
        logger.debug(`Fetch end event received, processing ${emailPromises.length} email promises`);

        Promise.all(emailPromises)
          .then(emailResults => {
            const validEmails = emailResults.filter(email => email !== null);
            logger.debug(`Fetched ${validEmails.length} emails successfully`);
            resolve(validEmails);
          })
          .catch(err => {
            logger.error('Error in email processing promises:', err);
            resolve([]);
          });
      });
    });
  },

  /**
   * Batch fetch emails and process asynchronously
   * Recommended for large email retrieval scenarios
   * @param {Object} imap - IMAP instance
   * @param {Array} results - Email UID array
   * @param {Object} options - Fetch options
   * @param {string} username - Username
   * @returns {Promise<Object>} - Processing result statistics
   */
  async fetchAndQueueEmails(imap, results, options, username) {
    const imapLogger = ImapLogger.getInstance(username);
    imapLogger.info(`[ImapIdleManagerQueue] started batch fetching emails: ${results.length} `);

    try {
      // Use async mode to fetch emails and enqueue
      const queuedEmails = await this._fetchEmailsAsync(imap, results, options, username);
      
      const signalingCount = queuedEmails.filter(e => e.isSignaling).length;
      const normalCount = queuedEmails.filter(e => !e.isSignaling).length;
      
      imapLogger.info(`[ImapIdleManagerQueue] email enqueued: total=${queuedEmails.length}, signaling=${signalingCount}, regular=${normalCount}`);
      
      // Return enqueue statistics
      return {
        success: true,
        queued: queuedEmails.length,
        signaling: signalingCount,
        normal: normalCount,
        emails: queuedEmails
      };
    } catch (error) {
      imapLogger.error(`[ImapIdleManagerQueue] batch fetch emails failed:`, error);
      throw error;
    }
  },

  /**
   * Get queue status
   */
  getQueueStatus() {
    if (!this.processorService) {
      return { initialized: false };
    }
    return this.processorService.getStatus();
  },

  /**
   * Clear email queue
   */
  clearQueue() {
    if (this.processorService) {
      return this.processorService.clearQueue();
    }
    return 0;
  },

  /**
   * Close queue service
   */
  async shutdown() {
    if (this.processorService) {
      await this.processorService.shutdown();
      this.processorService = null;
    }
  }
};

module.exports = { ImapIdleManagerQueue };
