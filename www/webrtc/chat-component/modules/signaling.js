
// Signaling module - sending and receiving email signals
import { SIGNALING_EMAIL_PREFIX } from '../../../../shared/config/signaling-constants.js';

export class SignalingManager {
  constructor(context) {
    this.context = context;
    this.setupEventListeners();
  }

  // Quick access to logs
  get logger() {
    return this.context.logger;
  }

  // Set up event listeners
  setupEventListeners() {
    // In Web Component mode, no longer listen to global window messages
    // Instead, call handleMessage directly via the component's postMessage method
    // Keep this method empty or use it for other internal event listening
  }

  handleMessage(event) {
    const dataObj = event.data;
    const startTime = Date.now();
    const { type, event: signalEvent, data } = dataObj;

    // Signal channel status monitoring: log received messages in detail
    const messageSummary = {
      type,
      event: signalEvent,
      timestamp: new Date().toISOString(),
      dataSize: data ? JSON.stringify(data).length : 0
    };

    if (type === 'WEBRTC_SIGNAL') {
      this.handleWebRTCSignal(signalEvent, data, messageSummary, startTime);
    } else if (type === 'contactSelected') {
      this.handleContactSelected(dataObj);
    } else if (type === 'connectionStatusChange') {
      this.handleConnectionStatusChange(dataObj);
    } else if (type === 'updateContactLastMessage') {
      this.handleUpdateContactLastMessage(dataObj);
    } else if (type === 'forwardLog') {
      // Handle forwardLog messages
      if (dataObj.logData && this.context.ui) {
        const { content, type: logType } = dataObj.logData;
        // Display directly via UI renderer, or log through logger (logger will emit log events again, so avoid infinite loops)
        // Calling the UI display directly here is safer
        this.context.ui.log(content);
      }
    } else if (type === 'RESET_WEBRTC_STATE') {
      this.handleResetWebRTCState();
    }
  }

  // Get the last unsent plain text message
  async getLastUnsentTextMessage(toEmail) {
    const myEmail = this.context?.myEmail || '';
    if (!myEmail || !toEmail) return null;
    
    if (window.electronAPI && window.electronAPI.getUnsentMessages) {
      try {
        const params = { fromer: myEmail, toer: toEmail };
        const messages = await window.electronAPI.getUnsentMessages(params);
        
        // Filter out plain text messages (status < 100 means unsent)
        const textMessages = messages
          .filter(msg => {
            if (msg.status >= 100) return false;
            
            const content = msg.content || '';
            // Exclude image messages
            if (content.includes('<img') || 
                content.includes('data-image-') ||
                content.includes('file-request-') ||
                content.includes('data-copied-path')) {
              return false;
            }
            return true;
          });
        
        // Sort by id and take the last one
        if (textMessages.length > 0) {
          textMessages.sort((a, b) => (b.id || 0) - (a.id || 0));
          const lastMsg = textMessages[0];
          return {
            id: lastMsg.msgid || lastMsg.id,
            content: lastMsg.content,
            timestamp: lastMsg.createtime || lastMsg.timestamp || Date.now()
          };
        }
      } catch (error) {
        this.logger.error('failed to get unsent text message: ' + error.message);
      }
    }
    return null;
  }

  // Send an email signal
  async sendSignalEmail(toEmail, signalData, attachments = []) {
    const myEmail = this.context?.myEmail || '';
    const signalTypeRaw = signalData?.type || 'signal';
    const signalType = String(signalTypeRaw || 'signal').toLowerCase();
    const roleInfo = this.context?.utils?.resolveRole
      ? this.context.utils.resolveRole(myEmail, toEmail)
      : { myEmail, targetEmail: toEmail, polite: true, role: 'unknown', valid: false, reason: 'resolveRoleunavailable' };

    const isOfferSignal = signalType.startsWith('offer');
    const isAnswerSignal = signalType.startsWith('answer');
    const isDiscoverSignal = signalType.startsWith('discover');
    const expectedRole = isOfferSignal ? 'sender' : isAnswerSignal ? 'receiver' : isDiscoverSignal ? 'receiver' : null;

    this.logger.info(
      `ROLE_CHECK branch=send_signal_email signal=${signalType} my=${roleInfo.myEmail} target=${roleInfo.targetEmail} polite=${roleInfo.polite} role=${roleInfo.role} decision=${expectedRole && roleInfo.role !== expectedRole ? 'block' : 'allow'} reason=${expectedRole && roleInfo.role !== expectedRole ? `expected_${expectedRole}` : (roleInfo.reason || '')}`
    );

    if (expectedRole && roleInfo.role !== expectedRole) {
      this.logger.warn(
        `ROLE_BLOCK branch=send_signal_email signal=${signalType} my=${roleInfo.myEmail} target=${roleInfo.targetEmail} polite=${roleInfo.polite} role=${roleInfo.role} expected=${expectedRole}`
      );
      return false;
    }

    this.logger.info(`📧 preparesendsignaling emailto  ${toEmail}, type: ${signalTypeRaw || 'unknown'}`);
    this.context?.uiRenderer?.updateStatus?.(`@:  ${window.i18n?.t ? window.i18n.t('chat.preparingSignalEmail') : 'preparesend{type}email...'}`.replace('{type}', signalTypeRaw || 'signal'));

    try {
      const subjectType = signalData?.type || 'signal';
      const subject = `${SIGNALING_EMAIL_PREFIX}${subjectType}-${Date.now()}`;
      
      // Get the last unsent plain-text message to carry in the signaling email
      const lastTextMsg = await this.getLastUnsentTextMessage(toEmail);
      
      // Build email body; add carryTextMessage if signalData is an object
      let bodyText;
      if (typeof signalData === 'string') {
        bodyText = signalData;
      } else {
        const signalDataWithCarry = {
          ...signalData,
          carryTextMessage: lastTextMsg ? {
            id: lastTextMsg.id,
            content: lastTextMsg.content,
            timestamp: lastTextMsg.timestamp
          } : null
        };
        bodyText = JSON.stringify(signalDataWithCarry);
        if (lastTextMsg) {
          this.logger.info(`📋 signaling email carrying text message: ${lastTextMsg.id}`);
        }
      }

      const configFromWindow = typeof window.getSelectedConfig === 'function'
        ? window.getSelectedConfig()
        : window.selectedConfig;

      const config = configFromWindow
        || (window.electronAPI && typeof window.electronAPI.getCurrentConfig === 'function'
          ? await window.electronAPI.getCurrentConfig()
          : null);

      if (window.electronAPI && typeof window.electronAPI.sendemail === 'function' && config) {
        this.logger.info('📨 via electronAPI.sendemail sendsignaling email');
        await window.electronAPI.sendemail(config, {
          to: toEmail,
          subject,
          text: bodyText,
          attachments
        });

        this.logger.info('✅ signaling email submitted');
        this.context?.uiRenderer?.updateStatus?.(`@:  ${window.i18n?.t ? window.i18n.t('chat.signalEmailSubmitted') : '{type} email submitted'}`.replace('{type}', signalTypeRaw || 'signal'));
        return true;
      }

      this.logger.warn('⚠️ No available send channel, unable to send signaling email');
      this.context.element.dispatchEvent(new CustomEvent('send-signal-email', {
        detail: {
          to: toEmail,
          data: signalData,
          attachments: attachments
        },
        bubbles: true,
        composed: true
      }));

      return false;
    } catch (error) {
        this.logger.error('❌ exception occurred while sending signaling email: ' + error.message);
        return false;
    }
  }

  // Send an email signal with a custom subject
  async sendSignalEmailWithSubject(toEmail, signalData, attachments = [], customSubject = null) {
    const myEmail = this.context?.myEmail || '';
    const signalTypeRaw = signalData?.type || 'signal';
    const signalType = String(signalTypeRaw || 'signal').toLowerCase();
    const roleInfo = this.context?.utils?.resolveRole
      ? this.context.utils.resolveRole(myEmail, toEmail)
      : { myEmail, targetEmail: toEmail, polite: true, role: 'unknown', valid: false, reason: 'resolveRoleunavailable' };

    const isOfferSignal = signalType.startsWith('offer');
    const isAnswerSignal = signalType.startsWith('answer');
    const isDiscoverSignal = signalType.startsWith('discover');
    const expectedRole = isOfferSignal ? 'sender' : isAnswerSignal ? 'receiver' : isDiscoverSignal ? 'receiver' : null;

    this.logger.info(
      `ROLE_CHECK branch=send_signal_email_with_subject signal=${signalType} my=${roleInfo.myEmail} target=${roleInfo.targetEmail} polite=${roleInfo.polite} role=${roleInfo.role} decision=${expectedRole && roleInfo.role !== expectedRole ? 'block' : 'allow'} reason=${expectedRole && roleInfo.role !== expectedRole ? `expected_${expectedRole}` : (roleInfo.reason || '')}`
    );

    if (expectedRole && roleInfo.role !== expectedRole) {
      this.logger.warn(
        `ROLE_BLOCK branch=send_signal_email_with_subject signal=${signalType} my=${roleInfo.myEmail} target=${roleInfo.targetEmail} polite=${roleInfo.polite} role=${roleInfo.role} expected=${expectedRole}`
      );
      return false;
    }

    this.logger.info(`📧 prepare send signaling email (custom subject) to ${toEmail}, type: ${signalTypeRaw || 'unknown'}, subject: ${customSubject || 'default'}`);
    this.context?.uiRenderer?.updateStatus?.(`@:  ${window.i18n?.t ? window.i18n.t('chat.preparingSignalEmail') : 'preparesend{type}email...'}`.replace('{type}', signalTypeRaw || 'signal'));

    try {
      // Use a custom subject or generate a default subject
      const subject = customSubject || `${SIGNALING_EMAIL_PREFIX}${signalData?.type || 'signal'}-${Date.now()} - please do not delete within 3 minutes!`;
      
      // Get the last unsent plain-text message to carry in the signaling email
      const lastTextMsg = await this.getLastUnsentTextMessage(toEmail);
      
      // Build email body; add carryTextMessage if signalData is an object
      let bodyText;
      if (typeof signalData === 'string') {
        bodyText = signalData;
      } else {
        const signalDataWithCarry = {
          ...signalData,
          carryTextMessage: lastTextMsg ? {
            id: lastTextMsg.id,
            content: lastTextMsg.content,
            timestamp: lastTextMsg.timestamp
          } : null
        };
        bodyText = JSON.stringify(signalDataWithCarry);
        if (lastTextMsg) {
          this.logger.info(`📋 signaling email carrying text message: ${lastTextMsg.id}`);
        }
      }

      const configFromWindow = typeof window.getSelectedConfig === 'function'
        ? window.getSelectedConfig()
        : window.selectedConfig;

      const config = configFromWindow
        || (window.electronAPI && typeof window.electronAPI.getCurrentConfig === 'function'
          ? await window.electronAPI.getCurrentConfig()
          : null);

      if (window.electronAPI && typeof window.electronAPI.sendemail === 'function' && config) {
        this.logger.info('📨 via electronAPI.sendemail send signaling email (custom subject)');
        
        // 🔄 Async mode: initiate the request immediately without waiting for the result (to avoid IPC timeout)
        // Results are notified asynchronously via the sendmail-result event
        const result = await window.electronAPI.sendemail(config, {
          to: toEmail,
          subject,
          text: bodyText,
          attachments
        });
        
        // Check whether it is async mode (returns taskId)
        if (result && result.taskId) {
          this.logger.info(`✅ signaling email (custom subject) submitted (TaskID: ${result.taskId})`);
          this.context?.uiRenderer?.updateStatus?.(`@:  ${window.i18n?.t ? window.i18n.t('chat.signalEmailSubmitted') : '{type} email submitted'}`.replace('{type}', signalTypeRaw || 'signal'));
          
          // Set up a one-time task completion listener
          this._setupSendmailResultListener(result.taskId, toEmail, subject);
          
          return true;
        } else {
          // Fall back to legacy synchronous mode support
          this.logger.info('✅ signaling email (custom subject) sent');
          this.context?.uiRenderer?.updateStatus?.(`@:  ${window.i18n?.t ? window.i18n.t('chat.signalEmailSent') : '{type} email sent'}`.replace('{type}', signalTypeRaw || 'signal'));
          return result?.success !== false;
        }
      }

      this.logger.warn('⚠️ No available send channel, unable to send signaling email');
      this.context.element.dispatchEvent(new CustomEvent('send-signal-email', {
        detail: {
          to: toEmail,
          data: signalData,
          attachments: attachments,
          subject: customSubject
        },
        bubbles: true,
        composed: true
      }));

      return false;
    } catch (error) {
        this.logger.error('❌ sendsignaling email(Customsubject)occurred whenexception: ' + error.message);
        return false;
    }
  }

  // Set up email send result listener
  _setupSendmailResultListener(taskId, toEmail, subject) {
    if (!window.electronAPI || !window.electronAPI.onSendmailResult) {
      this.logger.warn('⚠️ unable to listen for email sending result: electronAPI.onSendmailResult unavailable');
      return;
    }
    
    // Create a one-time listener
    const onceListener = (result) => {
      if (result.taskId === taskId) {
        // Find the corresponding task result
        if (result.success) {
          this.logger.info(`✅ emailsucceededsendto  ${result.to} (MessageID: ${result.messageId})`);
          
          // Optional: trigger event or update UI
          if (this.context.element) {
            this.context.element.dispatchEvent(new CustomEvent('signal-email-sent', {
              detail: {
                taskId: result.taskId,
                to: result.to,
                messageId: result.messageId,
                subject: result.subject
              },
              bubbles: true,
              composed: true
            }));
          }
        } else {
          this.logger.error(`❌ email sendingfailed: ${result.to} - ${result.error}`);
          
          // Optional: trigger event or update UI
          if (this.context.element) {
            this.context.element.dispatchEvent(new CustomEvent('signal-email-failed', {
              detail: {
                taskId: result.taskId,
                to: result.to,
                error: result.error,
                subject: result.subject
              },
              bubbles: true,
              composed: true
            }));
          }
        }
        
        // Remove the listener
        if (window.electronAPI && window.electronAPI.offSendmailResult) {
          window.electronAPI.offSendmailResult(onceListener);
        }
      }
    };
    
    // Set up the listener
    window.electronAPI.onSendmailResult(onceListener);
    
    // Safety timeout: automatically remove the listener if no result is received within 60 seconds
    setTimeout(() => {
      this.logger.warn(`⚠️ email sending result timeout (TaskID: ${taskId})`);
      if (window.electronAPI && window.electronAPI.offSendmailResult) {
        window.electronAPI.offSendmailResult(onceListener);
      }
    }, 60000);
  }

  async handleWebRTCSignal(signalEvent, data, messageSummary, startTime) {
    const logMsg = `[debug] signaling: handleWebRTCSignal called, signalEvent=${signalEvent}`;
    console.log(logMsg, data);
    if (window.electronAPI?.log) {
      window.electronAPI.log('info', logMsg, 'Debug');
    }
    // Only show the signal type, not the specific data
    this.logger.info('📡 received WebRTC signal: ' + signalEvent);

    const eventBus = this.context.eventBus;
    const utils = this.context.utils;
    const logMsg2 = `[debug] signaling: eventBus=${eventBus ? 'exists' : 'does not exist'}, utils=${utils ? 'exists' : 'does not exist'}`;
    console.log(logMsg2);
    if (window.electronAPI?.log) {
      window.electronAPI.log('info', logMsg2, 'Debug');
    }

    // Set the target email address in advance
    if (data?.from) {
      // In Web Components, we may control targetEmail through attributes,
      // but here for compatibility we notify updates via eventBus
      this.context.targetEmail = data.from;
    }

    this.logger.info('📡 received WebRTC signal, type: ' + signalEvent + ', source: ' + (data?.from || 'unknown'));
    this.logger.debug('signal detail info: type=' + messageSummary.type + ', event=' + signalEvent + ', data size=' + messageSummary.dataSize + ' chars');

    if (signalEvent === 'recv_offer') {
      // Notify main process to start signaling transmission
      if (window.electronAPI?.signalingState) {
        window.electronAPI.signalingState('start').catch(err => this.logger.debug('Signaling state start failed:', err));
      }

      // Add role validation: an Impolite Peer (Sender) should not process received Offers
      const myEmail = this.context.myEmail;
      const roleInfo = utils?.resolveRole ? utils.resolveRole(myEmail, data.from) : null;
      if (utils && !utils.isPolite(myEmail, data.from)) {
        if (roleInfo) {
          this.logger.warn(`ROLE_DROP branch=recv_offer my=${roleInfo.myEmail} target=${roleInfo.targetEmail} polite=${roleInfo.polite} role=${roleInfo.role} decision=drop reason=impolite_should_not_process_offer`);
        }
        this.logger.warn(`⚠️ Role conflict: I am Impolite Peer (Sender), should not process Offer from ${data.from}, drop directly`);
        if (window.electronAPI?.signalingState) {
          window.electronAPI.signalingState('end').catch(err => this.logger.debug('Signaling state end failed:', err));
        }
        return;
      }

      this.logger.info('🔄 process recv_offer signal');
      const processStartTime = Date.now();

      // Set target mailbox
      this.context.targetEmail = data.from;
      
      // Trigger WebRTC initialization event (inside component)
      eventBus.emit('webp2p:init');

      // Ensure offerData is in string format
      const offerDataStr = typeof data.offerData === 'object'
        ? JSON.stringify(data.offerData)
        : data.offerData;

      // Unified handling: use emailImageMetadata + attachments
      let finalAttachments = data.attachments || [];
      let finalEmailImageMetadata = data.emailImageMetadata || [];
      
      // If attachments are included, pass them to eventBus as well
      if (finalAttachments && finalAttachments.length > 0) {
        this.logger.info(`Offer include ${finalAttachments.length}  attachments, prepare forward`);
        eventBus.emit('signaling:offer', data.from, offerDataStr, finalAttachments, data.emailSubject);
      } else {
        eventBus.emit('signaling:offer', data.from, offerDataStr, [], data.emailSubject);
      }

      this.logger.info('offer signal process completed, time taken: ' + (Date.now() - processStartTime) + 'ms');

      // Notify main process to end signaling transmission
      if (window.electronAPI?.signalingState) {
        window.electronAPI.signalingState('end').catch(() => {});
      }

    } else if (signalEvent === 'recv_answer') {
      // Notify main process to start signaling transmission
      if (window.electronAPI?.signalingState) {
        window.electronAPI.signalingState('start').catch(() => {});
      }

      // Add role validation: a Polite Peer (Receiver) should not process Answers
      const myEmail = this.context.myEmail;
      const roleInfo = utils?.resolveRole ? utils.resolveRole(myEmail, data.from) : null;
      if (utils && utils.isPolite(myEmail, data.from)) {
        if (roleInfo) {
          this.logger.warn(`ROLE_DROP branch=recv_answer my=${roleInfo.myEmail} target=${roleInfo.targetEmail} polite=${roleInfo.polite} role=${roleInfo.role} decision=drop reason=polite_should_not_receive_answer`);
        }
        this.logger.warn(`⚠️ Role conflict: I am Polite Peer (Receiver), should not receive Answer, drop signal from ${data.from}`);
        if (window.electronAPI?.signalingState) {
          window.electronAPI.signalingState('end').catch(() => {});
        }
        return;
      }

      this.logger.info('🔄 process recv_answer signal');
      const processStartTime = Date.now();

      // Set target mailbox
      this.context.targetEmail = data.from;

      // Ensure answerData is in string format
      const answerDataStr = typeof data.answerData === 'object'
        ? JSON.stringify(data.answerData)
        : data.answerData;

      // Unified handling: use emailImageMetadata + attachments
      let finalAttachments = data.attachments || [];
      let finalEmailImageMetadata = data.emailImageMetadata || [];

      // If attachments are included, pass them to eventBus as well
      if (finalAttachments && finalAttachments.length > 0) {
        this.logger.info(`Answer include ${finalAttachments.length}  attachments, prepare forward`);
        eventBus.emit('signaling:answer', data.from, answerDataStr, finalAttachments, data.emailSubject);
      } else {
        eventBus.emit('signaling:answer', data.from, answerDataStr, [], data.emailSubject);
      }

      this.logger.info('answer signal process completed, time taken: ' + (Date.now() - processStartTime) + 'ms');

      // Notify main process to end signaling transmission
      if (window.electronAPI?.signalingState) {
        window.electronAPI.signalingState('end').catch(err => this.logger.debug('Signaling state end failed:', err));
      }

    } else if (signalEvent === 'send_offer') {
      this.logger.info('📤 process send_offer signal, call sendoffer function');
      const processStartTime = Date.now();

      // Set target mailbox
      this.context.targetEmail = data.from;

      const connection = this.context.connection;
      if (connection) {
        connection.sendoffer(data.from);
      } else {
        this.logger.error('Connection manager not found in context');
      }

      this.logger.info('send_offer signal process completed, time taken: ' + (Date.now() - processStartTime) + 'ms');

    } else if (signalEvent === 'prepare_receiver') {
      this.logger.info('🛡️  process prepare_receiver signal, prepare receiveOffer');
      const processStartTime = Date.now();
      
      // Set target mailbox
      this.context.targetEmail = data.from;
      
      // Update UI state
      if (this.context.ui) {
        this.context.ui.updateStatus('@:  preparereceivefrom  ' + data.from + ' connection...');
      }

      // Initialize WebRTC connection state
      this.context.webRTCConnectionStatus = 'disconnected';

      // Ensure the pc object is initialized - the connection manager will handle it automatically
      this.logger.debug('WebRTC connection peer object prepared and ready (managed by ConnectionManager)');

      this.logger.info('prepare_receiver signal process completed, time taken: ' + (Date.now() - processStartTime) + 'ms');

    } else if (signalEvent === 'recv_offline_messages') {
      this.logger.info('📥 process recv_offline_messages signal');
      const processStartTime = Date.now();
      
      const { from, messages, attachments } = data || {};
      
      // Handle non-image attachments
      if (attachments && attachments.length > 0) {
        if (this.context.connectionManager && this.context.connectionManager.handleReceivedAttachments) {
          const nonAvatarAttachments = attachments.filter(att => {
            const filename = att.filename || att.name || '';
            return !filename.startsWith('myavatar_');
          });
          if (nonAvatarAttachments.length > 0) {
            this.context.connectionManager.handleReceivedAttachments(from, nonAvatarAttachments);
          }
        }
      }

    } else if (signalEvent === 'recv_carry_text_message') {
      // Handle text messages carried in signaling emails
      await this.handleCarryTextMessage(data);
    } else if (signalEvent === 'discover') {
      const logMsg3 = '[debug] signaling: enter discover process branch';
      console.log(logMsg3);
      if (window.electronAPI?.log) {
        window.electronAPI.log('info', logMsg3, 'Debug');
      }
      this.logger.info('🔍 process discover signal, prepare sendOffer');
      const processStartTime = Date.now();
      
      // Set target mailbox
      this.context.targetEmail = data.from;
      const logMsg4 = `[debug] signaling: set targetEmail = ${data.from}`;
      console.log(logMsg4);
      if (window.electronAPI?.log) {
        window.electronAPI.log('info', logMsg4, 'Debug');
      }
      
      // Trigger WebRTC initialization event (inside component)
      const logMsg5 = '[debug] signaling: trigger webp2p:init event';
      console.log(logMsg5);
      if (window.electronAPI?.log) {
        window.electronAPI.log('info', logMsg5, 'Debug');
      }
      eventBus.emit('webp2p:init');
      
      // Invoke the logic for sending an Offer
      const logMsg6 = `[debug] signaling: connection=${this.context.connection ? 'exists' : 'does not exist'}`;
      console.log(logMsg6);
      if (window.electronAPI?.log) {
        window.electronAPI.log('info', logMsg6, 'Debug');
      }
      if (this.context.connection && typeof this.context.connection.sendoffer === 'function') {
        const logMsg7 = '[debug] signaling: call connection.sendoffer';
        console.log(logMsg7);
        if (window.electronAPI?.log) {
          window.electronAPI.log('info', logMsg7, 'Debug');
        }
        this.context.connection.sendoffer(data.from);
      } else {
        const errorMsg = '[debug] signaling: connection does not exist or sendoffer is not a function';
        console.error(errorMsg);
        if (window.electronAPI?.log) {
          window.electronAPI.log('error', errorMsg, 'Debug');
        }
      }
      
      this.logger.info('discover signal process completed, time taken: ' + (Date.now() - processStartTime) + 'ms');
    } else {
      this.logger.warn('unknown WebRTC signal type: ' + signalEvent);
    }
  }

  handleContactSelected(data) {
    this.logger.info('👤 [debug] handleContactSelected called, email: ' + data.email);
    const processStartTime = Date.now();

    // [Protection] Refuse to switch if chatWebcom is already bound to another contact and connected
    // Each chatWebcom only serves the contact it was bound to at creation
    const boundEmail = this.context.element?.getAttribute?.('contact-email');
    if (boundEmail && boundEmail !== data.email) {
      const connection = this.context.connection;
      if (connection && connection.isConnected()) {
        this.logger.warn(`⚠️ Reject handleContactSelected: current chatWebcom bind ${boundEmail}, not should switchto  ${data.email}`);
        return;
      }
    }

    // Set target mailbox
    this.logger.info(`[debug]set targetEmail: ${data.email}`);
    this.context.targetEmail = data.email;

    // Save to sessionStorage for retrieval during reconnection (using a key prefixed with the email address)
    const currentEmail = window.selectedConfig?.username;
    const lastContactKey = `lastSelectedContact_${currentEmail.replace(/@/g, '_at_')}`;
    sessionStorage.setItem(lastContactKey, data.email);
    this.logger.info(`[debug]saved recent contact to sessionStorage: ${data.email}`);

    // Ensure myEmail is up to date (runtime update, not relying on localStorage)
    const runtimeMyEmail = window.currentMyEmail || currentEmail || '';
    this.logger.info(`[debug]get mymail: ${runtimeMyEmail}`);

    if (runtimeMyEmail && runtimeMyEmail !== this.context.myEmail) {
        this.context.myEmail = runtimeMyEmail;
        this.logger.info('[debug] Updated context myEmail: ' + runtimeMyEmail);
    }

    // Reset the retry counter
    if (this.context.connectionManager) {
        this.logger.info('[debug] reset connection retry counter');
        this.context.connectionManager.connectionRetryCounts.clear();
    }

    // Update UI
    if (this.context.ui) {
      this.context.ui.updateStatus('✉️ ' + data.email);
    }

    // Load historical messages
    if (this.context.chatManager) {
        this.logger.info('[debug] triggerLoading history messages...');
        this.context.chatManager.loadHistoryMessages(data.email)
            .catch(err => this.logger.error('failed to load history message: ' + err));
    }

    this.logger.info(`[debug] trigger webp2p:init event`);
    // Trigger the WebRTC initialization event
    this.context.eventBus.emit('webp2p:init');

    this.logger.info(`[debug] trigger connection:targetChanged event`);
    // Trigger the connection target change event to start the WebRTC connection flow
    this.context.eventBus.emit('connection:targetChanged', data.email);

    // 🎯 Pre-generate BackupScenarios in advance (asynchronously, without blocking the UI)
    this.logger.info(`[optimization]startasyncpre-generateBackupScenarios for ${data.email}`);
    this._preGenerateBackupScenarios(data.email);

    this.logger.info(`[debug]handleContactSelected Process completed, time taken: ${Date.now() - processStartTime}ms`);
  }

  /**
   * 🎯 Asynchronously pre-generate BackupScenarios
   * Start pre-generation when the user selects a contact, rather than waiting until sending an Offer
   * This significantly reduces connection establishment time
   * @param {string} targetEmail - Target email address
   */
  async _preGenerateBackupScenarios(targetEmail) {
    try {
      // Check whether connectionManager exists and has the ensureBackupScenariosFor method
      if (this.context.connectionManager && 
          typeof this.context.connectionManager.ensureBackupScenariosFor === 'function') {
        
        this.logger.info(`[optimization]asyncpre-generateBackupScenariosstart: ${targetEmail}`);
        const startTime = Date.now();
        
        // Execute asynchronously without blocking the UI
        await this.context.connectionManager.ensureBackupScenariosFor(targetEmail);
        
        const duration = Date.now() - startTime;
        this.logger.info(`[optimization]asyncpre-generateBackupScenarioscompleted: ${targetEmail}, time taken${duration}ms`);
        
        // Update status display
        if (this.context.uiRenderer) {
          this.context.uiRenderer.updateStatus('@:  pre-generation completed, ready');
        }
      } else {
        this.logger.warn(`[optimization]unable topre-generateBackupScenarios: connectionManagerunavailable`);
      }
    } catch (error) {
      this.logger.error(`[optimization]pre-generateBackupScenariosfailed: ${error.message}`);
      // pre-generation failednot Affects main flow, continueexecute
    }
  }

  handleConnectionStatusChange(data) {
    const statusStr = data.isConnected ? 'Connected' : 'Disconnected';
    this.logger.info(`🌐 received IMAP connection status change: ${statusStr}`);

    // Trigger WebRTC reconnection when the IMAP connection recovers
    if (data.isConnected) {
      this.logger.info('🔄 IMAP connectionRestored, preparetrigger WebRTC reconnect...');

      // Delay triggering reconnection to wait for IMAP to be fully ready
      setTimeout(() => {
        // Reset the retry counter to allow new connection attempts
        if (this.context.connectionManager) {
          this.logger.info('🔄 reset connection retry counter');
          this.context.connectionManager.connectionRetryCounts.clear();
        }

        // Trigger reconnection
        this.logger.info('🔄 trigger connection:needReconnect event');
        this.context.eventBus.emit('connection:needReconnect');
      }, 3000);
    }
  }

  handleUpdateContactLastMessage(data) {
    const { email, message } = data;
    if (email === this.context.targetEmail) {
      this.logger.debug(`received target contact ${email} latest email notification, update active time`);
      // The original logic here isupdateParent page lastEmailTimes, 
      // Web Component Can choosetriggeran eventtoExternal
    }
  }

  handleResetWebRTCState() {
    this.logger.info('♻️ received RESET_WEBRTC_STATE signal, start soft reset...');
    // Trigger a reset event to be handled by ConnectionManager
    this.context.eventBus.emit('webrtc:reset');
  }

  /**
   * Handle text messages carried in signaling emails
   * @param {Object} data - { from: string, message: Object }
   */
  async handleCarryTextMessage(data) {
    const { from, message } = data;
    if (!message || !message.content) return;
    
    this.logger.info(`📨 receivedsignaling email carrying text message: ${message.id}`);
    
    // Notify ChatManager to display the message
    this.context.eventBus.emit('chat:receiveCarryTextMessage', {
      from: from,
      id: message.id,
      content: message.content,
      timestamp: message.timestamp
    });
  }
}
