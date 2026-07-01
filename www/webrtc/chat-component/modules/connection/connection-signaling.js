
import { ConnectionCore } from './connection-core.js';
import { NatDetector } from '../nat-detector.js';
import { SignalingSequenceManager } from '../signaling-sequence-manager.js';
import { BackupScenarioManager, AnswerGenerator } from '../backup-scenario-manager.js';
import { StunProbe } from '../stun-probe.js';

export class ConnectionSignaling extends ConnectionCore {
  constructor(context) {
    super(context);
    this.natDetector = new NatDetector(context.logger);
    // Initialize signaling sequence manager
    this.sequenceManager = new SignalingSequenceManager(context.logger);
    // Initialize backup Scenario manager (for pre-generating multiple RTCPeerConnections)
    this.backupScenarioManager = new BackupScenarioManager(context.logger, context.config);
    // Track avatar send status for each target email
    this.avatarSentMap = new Map();
    
    // 🎯 WebRTC bidirectional ACK-related properties
    this.currentDataChannel = null;               // Current DataChannel reference
    this.connectionReadyState = 'not-ready';      // Connection readiness state: not-ready → ready-to-send → ready-confirmed
    this.ackSequence = 0;                         // ACK sequence number
    this.ackReceiveTimeout = null;                // ACK receive timeout timer
    this.lastReceivedAckTimestamp = 0;            // Timestamp of last received ack
    this.ackReceivedMap = new Map();              // Record received ack (targetEmail -> {sequence, timestamp})
    
    // 🆕 Signaling state reset timeout mechanism
    this.signalingResetTimeoutId = null;          // Signaling reset timeout timer
    this.SIGNALING_RESET_TIMEOUT = 30000;         // Force reset signaling state after 30 seconds
    
    // 🎯 STUN parallel prober
    this.stunProbe = new StunProbe(context.logger);
    // Cache optimized ICE server config
    this.optimizedIceServers = null;
    // Last probe time
    this.lastStunProbeTime = 0;
    // Probe result cache validity (5 minutes)
    this.stunProbeCacheTTL = 5 * 60 * 1000;
    
    this.setupSignalingEventListeners();
  }

  setupSignalingEventListeners() {
    const eventBus = this.context.eventBus;

    eventBus.on('signaling:offer', (fromEmail, offerDataStr, attachments, emailSubject) => {
      this.sendanswer(fromEmail, offerDataStr, attachments, emailSubject);
    });

    eventBus.on('signaling:answer', (fromEmail, answerDataStr, attachments, emailSubject) => {
      this.getanswer(fromEmail, answerDataStr, attachments, emailSubject);
    });

    eventBus.on('signaling:ice-candidates', (candidates) => {
      this.handleIceCandidates(candidates);
    });

    // 🆕 Fix: listen for reset signaling state event
    eventBus.on('signaling:resetState', (targetEmail) => {
      if (this.sequenceManager && targetEmail) {
        this.sequenceManager.resetState(targetEmail);
        this.log(`[SignalingSequence] resetsignaling status: ${targetEmail}`);
      }
    });
  }

  /**
   * 🎯 Generate BackupScenarios for specified email
   * Should be called at:
   * 1. When user clicks a contact
   * 2. When Discover email is received
   * 3. When actively initiating connection
   */
  async ensureBackupScenariosFor(targetEmail) {
    if (!targetEmail || !this.backupScenarioManager) {
      return;
    }

    try {
      this.log(`🔄 [BackupScenario]  as  ${targetEmail} generate backup scenarios...`);
      const startTime = Date.now();
      
      // 🎯 Update ICE config before generating scenarios
      await this.updateBackupScenarioIceConfig();
      
      await this.backupScenarioManager.generateBackupScenariosFor(targetEmail);
      
      const stats = this.backupScenarioManager.getStats();
      const allTime = Date.now() - startTime;
      
      this.log(`✅ [BackupScenario] backup scenarios generation completed (time taken: ${allTime}ms)`);
      this.log(`📊 [BackupScenario] current stats: ${JSON.stringify(stats.scenarios)}`);
    } catch (e) {
      this.log(`⚠️ [BackupScenario] generate backup scenariosfailed: ${e.message}`);
    }
  }

  /**
   * 🎯 Get optimized ICE server config
   * Use parallel STUN probing to select optimal servers
   * @param {boolean} forceRefresh - Whether to force refresh cache
   * @returns {Promise<Object>} - Optimized RTCPeerConnection config
   */
  async getOptimizedIceConfig(forceRefresh = false) {
    const config = this.context.config;
    const originalServers = config.config?.iceServers || [];
    
    if (!originalServers || originalServers.length === 0) {
      this.log('[StunProbe] no original ICE Server configuration');
      return config.config;
    }

    const now = Date.now();
    
    // Build base config, ensuring key params like iceCandidatePoolSize are included
    const baseConfig = {
      ...config.config,
      iceCandidatePoolSize: config.config?.iceCandidatePoolSize ?? 10,
      bundlePolicy: config.config?.bundlePolicy ?? 'balanced',
      rtcpMuxPolicy: config.config?.rtcpMuxPolicy ?? 'require'
    };
    
    // Check if cache is valid
    if (!forceRefresh && 
        this.optimizedIceServers && 
        (now - this.lastStunProbeTime) < this.stunProbeCacheTTL) {
      this.log(`[StunProbe] usecacheoptimizationconfiguration (${(now - this.lastStunProbeTime) / 1000}sbeforeprobe)`);
      return { ...baseConfig, iceServers: this.optimizedIceServers };
    }

    this.log(`[StunProbe] startparallel STUN probe...`);
    if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.stunProbing') || 'probe STUN servers...'}`;
    const probeStartTime = Date.now();
    
    try {
      const result = await this.stunProbe.probeAllServers(originalServers);
      const probeTime = Date.now() - probeStartTime;
      
      if (result.bestServer) {
        this.log(`[StunProbe] probe completed, time taken ${probeTime}ms, best server: ${result.bestServer.name} (${result.bestServer.latency}ms)`);
        if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.stunProbeComplete') || 'STUN probecompleted, best server: {name} ({latency}ms)'}`.replace('{name}', result.bestServer.name).replace('{latency}', result.bestServer.latency);

        // Select top 3 optimal servers
        const topServers = result.results.slice(0, 3).map(r => ({ urls: r.url }));

        this.optimizedIceServers = topServers;
        this.lastStunProbeTime = now;

        this.log(`[StunProbe] optimized ICE server config (${topServers.length} ):`);
        result.results.slice(0, 3).forEach((r, i) => {
          this.log(`  ${i + 1}. ${r.name} - ${r.latency}ms`);
        });

        return { ...baseConfig, iceServers: topServers };
      } else {
        this.log(`[StunProbe] all STUN server probes failed, using original config`);
        if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.stunProbeFailed') || 'STUN probefailed, use default config'}`;
        return baseConfig;
      }
    } catch (e) {
      this.log(`[StunProbe] probeprocess error: ${e.message}, use original config`);
      return baseConfig;
    }
  }

  /**
   * 🎯 Update BackupScenarioManager ICE config
   * Called after probing to ensure pre-generated scenarios use optimized config
   */
  async updateBackupScenarioIceConfig() {
    if (this.backupScenarioManager) {
      const optimizedConfig = await this.getOptimizedIceConfig();
      this.backupScenarioManager.setOptimizedIceConfig(optimizedConfig);
    }
  }

  /**
   * Override cleanupConnection to add SignalingSequenceManager cleanup
   * Fully reset all signaling states
   */
  cleanupConnection() {
    this.log('🧹 [ConnectionSignaling] startdeep cleanupconnectionresource...');

    // Clean subclass-specific state first
    if (this.sequenceManager) {
      const targetEmail = this.context.targetEmail || this.fixedTargetEmail;
      if (targetEmail) {
        // 🆕 Fix: fully reset signaling sequence state, not just mark complete
        this.sequenceManager.resetState(targetEmail);
        this.log(`[SignalingSequence] full resetsignaling status: ${targetEmail}`);
      }
    }
    
    // Clean avatar send status (preserve other contacts' states)
    if (this.avatarSentMap) {
      const targetEmail = this.context.targetEmail || this.fixedTargetEmail;
      if (targetEmail && this.avatarSentMap.has(targetEmail)) {
        this.avatarSentMap.delete(targetEmail);
        this.log(`🖼️ cleanavatarsendstatus: ${targetEmail}`);
      }
    }

    // 🎯 Clean up BackupScenarios
    if (this.backupScenarioManager && this.fixedTargetEmail) {
      this.backupScenarioManager.cleanupScenariosFor(this.fixedTargetEmail);
      this.log(`🧹 [BackupScenario] clean ${this.fixedTargetEmail} pre-generate scenarios`);
    }

    // Clean current Scenario cache
    this.currentScenario = null;

    // 🎯 New: clean up WebRTC ACK state
    this.resetConnectionAckState();

    // 🆕 Cancel signaling state reset timeout timer
    this.cancelSignalingResetTimeout();

    // Call parent cleanup method
    super.cleanupConnection();

    this.log('✅ [ConnectionSignaling] depthCleanup completed');
  }

  async sendanswer(fromEmail, offerData, attachments, emailSubject = '') {
    const utils = this.context.utils;
    const config = this.context.config;

    this.log('📞 startexecutesendanswerfunction, from mailbox: ' + fromEmail);

    // Extract sequence number from email subject
    const payloadSequence = (offerData && typeof offerData === 'object') ? offerData.sequence : null;
    let sequence = emailSubject
      ? this.sequenceManager.extractSequenceFromSubject(emailSubject)
      : (payloadSequence || null);
    let offerChainKey = `${fromEmail}|offer:${sequence || 'none'}`;

    if (emailSubject) {
      this.log(`[SignalingSequence] recv_offer chain=${offerChainKey}, subject=${emailSubject}, parsedSequence=${sequence || 'none'}`);
    }
    
    if (sequence) {
      this.log(`[SignalingSequence] offer_chain in: chain=${offerChainKey}`);
      this.log(`[SignalingSequence] received offer sequence: ${sequence} from  ${fromEmail}`);
      
      // Validate sequence number
      if (!this.sequenceManager.shouldProcessOffer(fromEmail, sequence)) {
        this.log(`⚠️ [SignalingSequence] Rejectprocessexpired or duplicateoffer: ${fromEmail} serial number ${sequence}`);
        return;
      }
      
      // Mark as pending
      this.sequenceManager.markOfferPending(fromEmail, sequence);
    }

    // Filter out avatar attachments to avoid showing them in chat history
    const nonAvatarAttachments = attachments ? attachments.filter(att => {
      const filename = att.filename || att.name || '';
      return !filename.startsWith('myavatar_');
    }) : [];
    
    if (nonAvatarAttachments.length > 0) {
      this.log(`📥 received ${nonAvatarAttachments.length}  attachments(avatar excluded)`);
      this.handleReceivedAttachments(fromEmail, nonAvatarAttachments);
    }

    if (!this.fixedTargetEmail) {
      this.fixedTargetEmail = fromEmail;
    }
    // Update context target email if not set
    if (!this.context.targetEmail) {
      this.context.targetEmail = this.fixedTargetEmail;
    }

    const myEmail = this.context.myEmail;

    // Fix: validate email before calling isPolite
    if (!this.validateEmails(myEmail, this.fixedTargetEmail, 'sendanswer')) {
      this.log(`⚠️ email info incomplete, not process Offer alsonot send Answer`);
      if (sequence) {
        this.sequenceManager.markOfferCompleted(fromEmail, 'failed');
      }
      return;
    }

    const polite = utils.isPolite(myEmail, this.fixedTargetEmail);

    if (!polite) {
      this.log(`⚠️ role block: I am Sender role (${myEmail} < ${fromEmail}), do not process Offer nor send Answer`);
      if (sequence) {
        this.sequenceManager.markOfferCompleted(fromEmail, 'failed');
      }
      return;
    }

    this.connectionRetryCounts.set(fromEmail, 0);

    // Fix: set flag to record that Offer has been received and processed
    this.hasReceivedOffer = true;
    this.hasSentOffer = false; // Ensure state consistency
    this.log(`✅ setflag bit: received and processfrom  ${fromEmail}  Offer`);
    
    // Record sequence number as processed
    if (sequence) {
      this.sequenceManager.markSequenceProcessed(fromEmail, sequence, 'offer');
      this.log(`[SignalingSequence] offer_chain accepted: chain=${offerChainKey}`);
    }

    const collision = this.makingOffer || (this.pc && this.pc.signalingState !== 'stable');

    if (collision) {
      this.log(`🔄 [Polite Peer] collision detection, rollback and accept peer offer from: ${fromEmail}`);
      
      if (this.pc) {
        try {
          this.pc.close();
        } catch (e) {
          this.context.logger.error('closeconflictconnectionfailed:', e);
        }
        this.pc = null;
      }
      this.makingOffer = false;
      this.handshakeInProgress = false;
      this.pendingIceCandidates = [];
      this.collectedIceCandidates = [];
    }

    if (this.pc && this.pc.connectionState === 'connected') {
      this.log('⚠️ Connected, ignorenewoffer');
      return;
    }

    if (this.handshakeInProgress) {
      this.log(`⚠️ establishing connection, prioritycompletedcurrentconnectionprocess/program, ignorenewoffer from: ${fromEmail}`);
      return;
    }

    if (this.pc && this.pc.connectionState !== 'connected') {
      this.log('🔄 closeoldconnection, Acceptnewoffer');
      try {
        this.pc.close();
      } catch (e) {
        this.log('❌ closeoldconnectionfailed: ' + e.message);
      }
      this.pc = null;
      this.pendingIceCandidates = [];
      this.collectedIceCandidates = [];
    }
    this.handshakeInProgress = true;

    if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.connectingTo') || 'connection {email}...'}`.replace('{email}', fromEmail);

    const timeoutId = setTimeout(() => {
      this.log(`⏱️ Connection timeout (${config.CONNECTION_TIMEOUT}ms), cleanresource...`);

      this.webRTCConnectionStatus = 'disconnected';
      this.handshakeInProgress = false;
      this.makingOffer = false;
      this.context.eventBus.emit('connection:statusChanged', 'disconnected');

      // Key fix: clean up pending offer state on connection timeout so subsequent reconnects can handle new offers
      this.sequenceManager.markOfferCompleted(fromEmail, 'timeout');
      this.log(`[SignalingSequence] Connection timeout, cleanpendingprocessofferstatus: ${fromEmail}`);

      if (this.pc) {
        try {
          this.pc.close();
        } catch (e) {
          console.error('closetimeoutconnectionfailed:', e);
        }
        this.pc = null;
      }

      this.context.element.dispatchEvent(new CustomEvent('connection-failed', {
        detail: { email: fromEmail, reason: 'timeout' }
      }));

      this.connectionTimeoutTimers.delete(fromEmail);

      let retryCount = this.connectionRetryCounts.get(fromEmail) || 0;
      retryCount++;
      this.connectionRetryCounts.set(fromEmail, retryCount);

      if (retryCount <= config.MAX_CONNECTION_RETRIES) {
        this.log(`🔄 tryreestablish connection (${retryCount}/${config.MAX_CONNECTION_RETRIES})...`);
        this.log(`🔍 reconnectbeforeFetch firstemail, checkhaslatencyto reachOffer...`);
        this.triggerFetchEmails(2, true);
        setTimeout(() => {
          this.handleReconnect();
        }, config.RETRY_DELAY || 2000);
      } else {
        this.log(`❌ max retry count reached (${config.MAX_CONNECTION_RETRIES}), give upconnection`);
        this.context.element.dispatchEvent(new CustomEvent('connection-failed-final', {
          detail: { email: fromEmail }
        }));
        this.connectionRetryCounts.delete(fromEmail);
      }

      this.log('❌ Connection timeout, cleanresource');
      if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.connectionTimeout') || 'Connection timeout'}`;
    }, config.CONNECTION_TIMEOUT);

    this.connectionTimeoutTimers.set(fromEmail, timeoutId);

    if (!offerData) {
      this.log('❌ Not foundofferdata');
      this.handshakeInProgress = false;
      return;
    }

    let parsedOfferData = offerData;
    try {
      if (typeof offerData === 'string') {
        parsedOfferData = JSON.parse(offerData);
      }

      if (!sequence && parsedOfferData && parsedOfferData.sequence) {
        sequence = parsedOfferData.sequence;
        offerChainKey = `${fromEmail}|offer:${sequence}`;
        this.log(`[SignalingSequence] offer_sequence backfill from payload: chain=${offerChainKey}`);

        if (!this.sequenceManager.shouldProcessOffer(fromEmail, sequence)) {
          this.log(`⚠️ [SignalingSequence] payload offer sequence rejected: chain=${offerChainKey}`);
          this.handshakeInProgress = false;
          return;
        }
        this.sequenceManager.markOfferPending(fromEmail, sequence);
      }

      if (!parsedOfferData || !parsedOfferData.sdp) {
        this.log('❌ offerdataformaterror');
        this.handshakeInProgress = false;
        return;
      }

      this.log('✅ receivedofferfrom : ' + fromEmail);

      if (parsedOfferData.candidates && Array.isArray(parsedOfferData.candidates)) {
        this.pendingIceCandidates.push(...parsedOfferData.candidates);
      }

      offerData = parsedOfferData;
    } catch (e) {
      this.log('❌ processofferdatafailed: ' + e.message);
      this.handshakeInProgress = false;
      return;
    }

    await this.configurePeerConnection(offerData, fromEmail, sequence);
  }

  async configurePeerConnection(offerData, fromEmail, offerSequence = null) {
    const config = this.context.config;
    
    let pc;
    let currentScenario = null;  // Save currently used Scenario
    
    // 🎯 Optimization: try using pre-generated BackupScenario
    if (this.backupScenarioManager) {
      this.log(`🔍 [BackupScenario] try as  ${fromEmail} getpre-generatescenarios...`);
      try {
        // Get pre-generated scenarios from BackupScenarioManager
        currentScenario = await this.backupScenarioManager.selectBestScenario(offerData, fromEmail);
        
        if (currentScenario && currentScenario.pc) {
          pc = currentScenario.pc;
          // Use ICE candidates pre-collected in Scenario
          this.collectedIceCandidates = [...(currentScenario.candidates || [])];
          
          this.log(`✅ [BackupScenario] succeededusepre-generate ${currentScenario.metadata?.type || 'primary'} scenario (precollect ${this.collectedIceCandidates.length}  candidates)`);
        }
      } catch (e) {
        this.log(`⚠️ [BackupScenario] failed to get scenario, will fall back tocreatenewPC: ${e.message}`);
        currentScenario = null;
      }
    }
    
    // Create new RTCPeerConnection if no BackupScenario obtained
    if (!pc) {
      try {
        // 🎯 Get optimized ICE configuration
        const optimizedConfig = await this.getOptimizedIceConfig();
        
        pc = await this.retryOperation(
          () => new RTCPeerConnection(optimizedConfig),
          'createRTCPeerConnection',
          3,
          2000
        );
        this.collectedIceCandidates = [];
        this.log('✅ createRTCPeerConnectionsucceeded (useoptimizationafter STUN configuration)');
      } catch (e) {
        this.log('❌ createRTCPeerConnectionfailed: ' + e.message);
        this.handshakeInProgress = false;
        this.makingOffer = false;
        this.clearConnectionTimeout(fromEmail);
        return;
      }
    }
    
    this.pc = pc;
    this.currentScenario = currentScenario;  // Save current scenario for createAndSendAnswer

    pc.ondatachannel = (e) => {
      const dataChannel = e.channel;
      this.log(`📡 receivedDataChannel: ${dataChannel.label}`);
      this.setupDataChannelHandlers(dataChannel, this.context.targetEmail);
      
      if (this.context.dataChannelManager) {
          this.context.dataChannelManager.setupDataChannel(dataChannel);
      } else {
          console.warn('DataChannelManager not found in context');
      }
    };

    const handleConnectionStateChange = (connection) => {
      const state = connection.connectionState;
      this.log(`🔄 connection state changed: ${state}`);
      if (this.statusDiv) this.statusDiv.textContent = `@:  ${(window.i18n?.t('chat.connectionState') || '{state}').replace('{state}', state)}`;

      if (state === 'connected') {
        this.log('🎉 connectionsucceeded!');
        this.stopPolling();
        this.handshakeInProgress = false;
        this.makingOffer = false;
        this.webRTCConnectionStatus = 'connected';
        this.context.eventBus.emit('connection:statusChanged', 'connected');
        this.connectionRetryCounts.delete(fromEmail);
        this.clearConnectionTimeout(fromEmail);
      } else if (state === 'failed') {
        this.log('❌ connectionfailed!');
        this.stopPolling();
        this.handshakeInProgress = false;
        this.makingOffer = false;
        this.webRTCConnectionStatus = 'disconnected';
        this.context.eventBus.emit('connection:statusChanged', 'disconnected');
        this.clearConnectionTimeout(fromEmail);

        let retryCount = this.connectionRetryCounts.get(fromEmail) || 0;
        retryCount++;
        this.connectionRetryCounts.set(fromEmail, retryCount);

        if (retryCount <= config.MAX_CONNECTION_RETRIES) {
          this.log(`🔄 tryreestablish connection (${retryCount}/${config.MAX_CONNECTION_RETRIES})...`);
          setTimeout(() => {
            this.sendanswer(fromEmail, offerData);
          }, 2000);
        } else {
          this.log('❌ max retry count reached, give upconnection');
          this.connectionRetryCounts.delete(fromEmail);
        }
      } else if (state === 'closed' || state === 'disconnected') {
        this.log('🔌 connectionclose');
        this.stopPolling();
        this.handshakeInProgress = false;
        this.makingOffer = false;
        this.webRTCConnectionStatus = 'disconnected';
        this.context.eventBus.emit('connection:statusChanged', 'disconnected');
        this.clearConnectionTimeout(fromEmail);
        
        // 🆕 Trigger full reset and reconnect (resolve issue where DataChannel onclose may not fire)
        this.log(`🔄 RTCPeerConnection connectiondisconnect, triggerfull reset and reconnect...`);
        this.context.eventBus.emit('connection:fullResetAndReconnect');

      }

      setTimeout(() => {
        this.triggerFetchEmails(2, true);
      }, 1000);
    };

    pc.onconnectionstatechange = () => handleConnectionStateChange(pc);

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      this.log(`🧊 ICE connection@:  ${iceState}`);
      if (this.statusDiv) this.statusDiv.textContent = `@:  ${(window.i18n?.t('chat.iceState') || 'ICE connection{state}').replace('{state}', iceState)}`;

      if (iceState !== 'disconnected' && this.iceDisconnectedTimerId) {
        clearTimeout(this.iceDisconnectedTimerId);
        this.iceDisconnectedTimerId = null;
      }

      // ✅ New: when ICE connected, don't show success immediately; prepare to send ACK
      if (iceState === 'connected') {
        this.log(`⚡ ICE connected, waiting for DataChannel to open...`);
        this.connectionReadyState = 'ready-to-send';
        
        // 🆕 Cancel signaling state reset timeout timer (connection restored)
        this.cancelSignalingResetTimeout();
        
        // ✅ Send ACK immediately if DataChannel is open
        if (this.currentDataChannel && this.currentDataChannel.readyState === 'open') {
          this.log(`📤 DataChannel opened, immediatelysendconnection-ack...`);
          this.sendConnectionAck(fromEmail);
        }
        // Otherwise waitondatachannelopenoronopenCallback triggered
      }

      // When ICE connection state changes to failed, disconnected, or closed, update P2P status and reset flags
      if (iceState === 'failed' || iceState === 'disconnected' || iceState === 'closed') {
        this.log(`⚠️ ICE connection abnormal: ${iceState}, updateP2Pstatus and resetconnectionflag`);
        this.webRTCConnectionStatus = 'disconnected';
        this.context.eventBus.emit('connection:statusChanged', 'disconnected');

        // Reset connection state flags to ensure subsequent reconnects work
        this.handshakeInProgress = false;
        this.makingOffer = false;
        this.log(`🧹 ICEexceptiontimereset stateflag: handshakeInProgress=false, makingOffer=false`);
        
        // 🆕 Start signaling state reset timeout (force clear signaling state after 30 seconds)
        this.startSignalingResetTimeout(fromEmail);
        
        // 🆕 Trigger full reset and reconnect (resolve issue where DataChannel onclose may not fire)
        this.log(`🔄 ICE connection abnormal, triggerfull reset and reconnect...`);
        this.context.eventBus.emit('connection:fullResetAndReconnect');
      }
    };

    pc.onicecandidateerror = (event) => {
      this.log(`⚠️ ICE candidate error: ${event.errorText} (code: ${event.errorCode})`);
      // Trigger DataChannel layer into fluctuating state for high-frequency detection
      this.context.eventBus.emit('ice:candidateError', {
        errorCode: event.errorCode,
        errorText: event.errorText,
        timestamp: Date.now()
      });
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        // Check candidate type
        const candidateType = candidate.candidate.includes('typ host') ? 'host' :
          candidate.candidate.includes('typ srflx') ? 'srflx' :
            candidate.candidate.includes('typ relay') ? 'relay' :
              candidate.candidate.includes('typ prflx') ? 'prflx' : 'unknown';

        // Skip host-type candidates if host candidates are disabled
        const enableHostCandidate = this.context.config?.ENABLE_HOST_CANDIDATE ?? false;
        if (candidateType === 'host' && !enableHostCandidate) {
          this.log(`🚫 skiphostcandidate (ENABLE_HOST_CANDIDATE=${enableHostCandidate})`);
          return;
        }

        this.collectedIceCandidates.push(candidate);

        const protocol = candidate.candidate.includes('udp') ? 'UDP' : 'TCP';
        const component = candidate.sdpMLineIndex;

        this.log(`📥 collected ICE candidate (${this.collectedIceCandidates.length}): type=${candidateType}, component=${component}, protocol=${protocol}`);
        const collectingMsg = window.i18n?.t('chat.iceCandidateCollecting') || 'collect ICE candidates';
        if (this.statusDiv) this.statusDiv.textContent = `@:  ${collectingMsg}(${this.collectedIceCandidates.length}): ${candidateType}`;
      } else {
        this.log(`✅ ICE candidate collection completed, total ${this.collectedIceCandidates.length} `);
        const completeMsg = window.i18n?.t('chat.iceCandidateComplete') || 'ICE candidate collection completed';
        if (this.statusDiv) this.statusDiv.textContent = `@:  ${completeMsg}(${this.collectedIceCandidates.length})`;
      }
    };

    pc.onerror = (error) => {
      this.log(`❌ WebRTC error: ${error}`);
      this.webRTCConnectionStatus = 'disconnected';
      this.context.eventBus.emit('connection:statusChanged', 'disconnected');
      this.handshakeInProgress = false;
      this.makingOffer = false;
    };

    await this.createAndSendAnswer(pc, fromEmail, offerData, offerSequence);
  }

  async createAndSendAnswer(pc, fromEmail, offerData, offerSequence = null) {
    const utils = this.context.utils;
    const startTime = Date.now();
    
    // chat manager to get unsent messages
    let unsentMessages = [];
    if (this.context.chatManager && this.context.chatManager.getUnsentMessagesForEmail) {
        unsentMessages = await this.context.chatManager.getUnsentMessagesForEmail(fromEmail);
    }
    
    this.context.logger.info(`start creating and sending Answer, from mailbox: ${fromEmail}`);
    this.context.logger.debug(`Unsentmessagecount: ${unsentMessages.length}`);

    try {
      let answer = null;
      let filteredCandidates = null;
      let sdpToUse = null;
      
      // 🎯 Optimization: if BackupScenario was used, try AnswerGenerator for fast Answer generation
      // After optimization: AnswerGenerator collects ICE candidates in real time after setting localDescription (up to 1.5s)
      if (this.currentScenario && this.currentScenario.pc && this.backupScenarioManager) {
        this.log(`⚡ [BackupScenario] using fast Answer generation path...`);
        try {
          const generatorStartTime = Date.now();
          const answererGen = new AnswerGenerator(this.currentScenario, this.context.logger);
          const quickAnswer = await answererGen.generateQuickAnswer(offerData);
          
          if (quickAnswer) {
            answer = quickAnswer;
            filteredCandidates = quickAnswer.candidates;
            sdpToUse = quickAnswer.sdp;
            
            const generationTime = Date.now() - generatorStartTime;
            this.log(`⚡ [BackupScenario] fast Answer generation succeeded (time taken: ${generationTime}ms, real-timecandidate count: ${filteredCandidates?.length || 0})`);
          }
        } catch (e) {
          this.log(`⚠️ [BackupScenario] fast Answer generation failed, fall back toComplete flow: ${e.message}`);
          this.currentScenario = null;
        }
      }
      
      // If fast Answer generation fails or no Scenario, use full flow
      if (!answer) {
        this.log(`📋 using full Answer generation flow...`);
        
        await this.retryOperation(
          () => pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerData.sdp })),
          'set remote offer description',
          2,
          1500
        );
        
        await this.processPendingIceCandidates();

        answer = await this.retryOperation(
          () => pc.createAnswer(),
          'createAnswer',
          2,
          1500
        );

        await this.retryOperation(
          () => pc.setLocalDescription(answer),
          'set local answer description',
          2,
          1500
        );

        await this.waitForIceGathering(pc);

        filteredCandidates = await utils.filterHighPriorityIceCandidates(this.collectedIceCandidates);
        sdpToUse = pc.localDescription ? pc.localDescription.sdp : answer.sdp;
      }
      
      // Generate email subject with sequence number
      const effectiveOfferSequence = offerSequence || offerData?.sequence || null;
      const answerSequence = effectiveOfferSequence || this.sequenceManager.getNextSequence(fromEmail, 'answer-complete');
      const answerSubject = this.sequenceManager.generateSubject('answer-complete', fromEmail, answerSequence);
      this.log(`[SignalingSequence] answer sequence decision: offer=${effectiveOfferSequence || 'none'} -> answer=${answerSequence}, subject=${answerSubject}`);
      this.log(`[SignalingSequence] answer_chain out: chain=${fromEmail}|offer:${effectiveOfferSequence || 'none'}|answer:${answerSequence}`);
      
      const finalCombinedMessage = {
        type: 'answer-complete',
        readme: window.i18n?.t('chat.signalEmailReadme') || 'MailLink email-chat signaling email. Please do not delete within 3 minutes; it will be automatically deleted when expired (you may also delete it manually).',
        sdp: sdpToUse,
        candidates: filteredCandidates,
        iceComplete: true,
        unsentMessages: unsentMessages,
        sequence: answerSequence // Include sequence number for debugging
      };

      this.log(`[SignalingSequence] sent answer sequence: ${finalCombinedMessage.sequence} to  ${fromEmail}, subject=${answerSubject}`);
      if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.sendingAnswer') || 'sendAnswer signaling...'}`;

      // Send email via SignalingManager
      if (this.context.signalingManager) {
          // Send with custom subject
          const sent = await this.context.signalingManager.sendSignalEmailWithSubject(fromEmail, finalCombinedMessage, [], answerSubject);

          if (sent) {
              this.log(`✅ answer sent to: ${fromEmail}`);
              if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.answerSent') || 'Answer signalingSent'}`;
          } else {
              this.log(`⚠️ Answer email failed to send to: ${fromEmail}`);
          }
      } else {
          console.error('SignalingManager not found');
      }
      
      this.startPolling();
      
      setTimeout(() => {
        this.triggerFetchEmails(2, true);
      }, 3000);

    } catch (e) {
      this.log('❌ create/send Answer failed: ' + e.message);
      this.handshakeInProgress = false;
      this.makingOffer = false;
      this.clearConnectionTimeout(fromEmail);
      
       this.context.element.dispatchEvent(new CustomEvent('connection-failed', {
        detail: { email: fromEmail, reason: e.message }
      }));
    }
  }

  async processPendingIceCandidates() {
    if (this.pc && this.pc.remoteDescription && this.pendingIceCandidates.length > 0) {
      this.log(`processing pending ${this.pendingIceCandidates.length} ICE candidate`);
      const candidates = [...this.pendingIceCandidates];
      this.pendingIceCandidates = [];
      await this.context.utils.addIceCandidates(this.pc, candidates);
    }
  }

  waitForIceGathering(pc) {
    this.log('🔄 startexecutewaitForIceGatheringfunction, waitICE candidate collection completed');
    
    this.natDetector.reset();
    
    return new Promise((resolve) => {
      let resolved = false;
      let candidateCount = 0;
      let lastCandidateTime = Date.now();
      let firstCandidateTime = Date.now();
      let candidateGenerationRate = 0;
      let collectedCandidates = [];
      let hasSrflxCandidate = false;
      let hasRelayCandidate = false;
      let relayCandidateCount = 0;

      const requireRelay = this.context.config.REQUIRE_RELAY_CANDIDATE !== false;
      const relayTimeout = this.context.config.RELAY_CANDIDATE_TIMEOUT || 10000;

      const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const networkType = connection?.effectiveType || 'unknown';
      
      let fastSendThreshold = this.context.config.MIN_CANDIDATES_TO_PROCEED || 1;
      let waitTime = 1400;
      let finalTimeout = this.context.config.ICE_GATHERING_TIMEOUT || 15000;

      switch (networkType) {
        case '5g':
        case '4g':
          fastSendThreshold = 1;
          waitTime = 500;
          finalTimeout = 3000;
          break;
        case '3g':
          fastSendThreshold = 3;
          waitTime = 1400;
          finalTimeout = 5000;
          break;
        case '2g':
          fastSendThreshold = 4;
          waitTime = 1000;
          finalTimeout = 4000;
          break;
        default:
          fastSendThreshold = 3;
          waitTime = 1400;
          finalTimeout = 5000;
      }

      const logCandidateInfo = (candidate) => {
        const candidateStr = candidate.candidate || '';
        const candidateType = candidateStr.includes('typ host') ? 'host' :
          candidateStr.includes('typ srflx') ? 'srflx' :
            candidateStr.includes('typ relay') ? 'relay' :
              candidateStr.includes('typ prflx') ? 'prflx' : 'unknown';

        const protocol = candidateStr.includes('udp') ? 'UDP' : 
          candidateStr.includes('tcp') ? 'TCP' : 'unknown';
        const component = candidate.sdpMLineIndex;
        
        this.log(`📥 collected ICE candidate (${candidateCount}): type=${candidateType}, component=${component}, protocol=${protocol}`);
        
        return candidateType;
      };

      // Flag whether NAT detection has been triggered (used for early trigger mechanism)
      let natDetectionTriggered = false;
      
      // [Optimization] relay timeout controller ID, used to cancel waiting when srflx detected
      let relayTimeoutId = null;

      const performNatDetection = (isEarlyDetection = false) => {
        const natInfo = this.natDetector.detect();
        this.log(`🔍 NATtypedetectcompleted${isEarlyDetection ? '(prompt/mentionbeforetrigger)' : ''}: ${natInfo.typeName} - ${natInfo.description}`);
        // Add flag indicating whether it's early detection
        natInfo.isEarlyDetection = isEarlyDetection;
        this.context.eventBus.emit('nat:detected', natInfo);
      };

      const originalHandler = pc.onicecandidate;
      pc.onicecandidate = (event) => {
        if (originalHandler) originalHandler(event);
        if (event.candidate) {
          candidateCount++;
          const currentTime = Date.now();
          collectedCandidates.push(event.candidate);

          const candidateType = logCandidateInfo(event.candidate);
          
          this.natDetector.addCandidate(event.candidate);

          if (candidateType === 'srflx') {
            hasSrflxCandidate = true;
            // [Optimization 1] Trigger NAT detection early when first srflx candidate is collected
            if (!natDetectionTriggered) {
              natDetectionTriggered = true;
              this.log(`🎯 collectto srflxcandidate, prompt/mentionbeforetriggerNAT detection`);
              performNatDetection(true);
              
              // [P0 Optimization] srflx is sufficient to penetrate NAT; intelligently skip relay wait
              const enableSrflxOptimization = this.context.config.ENABLE_SRFLX_OPTIMIZATION !== false;
              if (enableSrflxOptimization && requireRelay && relayTimeoutId && !resolved) {
                clearTimeout(relayTimeoutId);
                relayTimeoutId = null;
                
                const relayTimeout = this.context.config.RELAY_CANDIDATE_TIMEOUT || 5000;
                const srflxWaitTime = this.context.config.SRFLX_WAIT_TIME_AFTER_DETECTION || 2000;
                
                this.log(`⚡ [P0 optimization]srflxSufficient to penetrateNAT, immediatelygive uprelaywait`);
                this.log(`📊 optimizationEffect: Save${relayTimeout}ms, use${srflxWaitTime}msfastcollectafterimmediatelysend`);
                
                // Wait 2 more seconds to allow more quality candidates, then complete immediately
                setTimeout(() => {
                  if (!resolved) {
                    resolved = true;
                    this.log(`✅ ICE gathering completed: Obtainedsrflxcandidate (${candidateCount}Total candidates)`);
                    performNatDetection();
                    resolve();
                  }
                }, srflxWaitTime);
              }
            }
          }
          
          if (candidateType === 'relay') {
            hasRelayCandidate = true;
            relayCandidateCount++;
            this.log(`🎯 collectto  Relay candidate!current relay count: ${relayCandidateCount}`);
          }

          if (candidateCount > 1) {
            const timeDiff = currentTime - firstCandidateTime;
            candidateGenerationRate = (candidateCount - 1) / (timeDiff / 1000);
          } else {
            firstCandidateTime = currentTime;
          }

          lastCandidateTime = currentTime;

          if (candidateGenerationRate > 5) {
            waitTime = Math.min(1500, waitTime + 200);
          } else if (candidateGenerationRate < 1) {
            waitTime = Math.max(300, waitTime - 100);
          }

          if (requireRelay) {
            if (hasRelayCandidate && !resolved) {
              this.log(`✅ collectto  Relay candidate, ICE collectMeets requirements`);
              setTimeout(() => {
                if (!resolved) {
                  resolved = true;
                  this.log(`✅ ICE gathering completed: Obtained Relay candidate (${relayCandidateCount} )`);
                  performNatDetection();
                  resolve();
                }
              }, waitTime);
            }
          } else {
            if (candidateCount >= fastSendThreshold && !resolved) {
              setTimeout(() => {
                if (!resolved && (Date.now() - lastCandidateTime) >= waitTime) {
                  resolved = true;
                  this.log(`✅ ICE gatheringprompt/mentionbeforecompleted: candidatecount(${candidateCount})reachto Threshold`);
                  performNatDetection();
                  resolve();
                }
              }, waitTime);
            }
          }
        } else {
          if (!resolved) {
            if (requireRelay) {
              if (hasRelayCandidate) {
                resolved = true;
                this.log(`✅ ICE gathering completed: Obtained Relay candidate, no more candidates`);
                performNatDetection();
                resolve();
              } else {
                this.log(`⚠️ ICE gathering completedbutno Relay candidate, continuewait...`);
              }
            } else {
              if (hasSrflxCandidate || Date.now() - firstCandidateTime >= finalTimeout) {
                resolved = true;
                this.log(`✅ ICE gathering completed: nomore candidates`);
                performNatDetection();
                resolve();
              }
            }
          }
        }
      };

      if (pc.iceGatheringState === 'complete') {
        if (requireRelay && !hasRelayCandidate) {
          this.log(`⏳ ICE status as  complete butno Relay candidate, continuewait...`);
        } else {
          if (hasRelayCandidate || !requireRelay) {
            resolved = true;
            this.log(`✅ ICE gathering completed: status as  complete`);
            performNatDetection();
            resolve();
            return;
          }
        }
      }

      pc.onicegatheringstatechange = () => {
        const state = pc.iceGatheringState;
        if (state === 'complete' && !resolved) {
          if (requireRelay) {
            if (hasRelayCandidate) {
              resolved = true;
              this.log(`✅ ICE gathering completed: statuschange as  complete, Obtained Relay candidate`);
              performNatDetection();
              resolve();
            } else {
              this.log(`⚠️ ICE statuschange as  complete butno Relay candidate, continuewaittimeout...`);
            }
          } else {
            if (hasSrflxCandidate || Date.now() - firstCandidateTime >= finalTimeout) {
              resolved = true;
              this.log(`✅ ICE gathering completed: statuschange as complete`);
              performNatDetection();
              resolve();
            }
          }
        }
      };

      // [P0 Optimization-Plan 1] Skip relay wait immediately when ICE is connected
      // Principle: if ICE connection is established (connected/completed), current candidates are sufficient for NAT traversal
      // No need to wait for relay candidates; send Answer immediately, saving up to 10 seconds
      const originalIceHandler = pc.oniceconnectionstatechange;
      pc.oniceconnectionstatechange = () => {
        // First call original ICE connection state handler
        if (originalIceHandler) originalIceHandler();
        
        const iceState = pc.iceConnectionState;
        if ((iceState === 'connected' || iceState === 'completed') && !resolved) {
          resolved = true;
          this.log(`⚡ [P0 optimization]ICEestablish connection(${iceState}), immediatelycompletedcandidatecollect, skiprelaywait`);
          if (relayTimeoutId) {
            clearTimeout(relayTimeoutId);
            relayTimeoutId = null;
          }
          performNatDetection();
          resolve();
        }
      };

      // [Optimization] Use let instead of const so it can be cancelled on srflx detection
      relayTimeoutId = setTimeout(() => {
        if (!resolved) {
          if (requireRelay && !hasRelayCandidate) {
            this.log(`❌ Relay candidatecollecttimeout (${relayTimeout}ms), not canget TURN  in progresscontinued candidates`);
            this.log(`⚠️ This may cause NAT penetrationfailed, connectionpossiblenot Stable`);
            this.log(`📊 currentcollectstatus: host=${candidateCount - relayCandidateCount - (hasSrflxCandidate ? 1 : 0)}, srflx=${hasSrflxCandidate ? 1 : 0}, relay=${relayCandidateCount}`);
          }
          resolved = true;
          this.log(`⚠️ ICE gatheringreachto finaltimeoutguarantee (${finalTimeout}ms), forcecompleted`);
          performNatDetection();
          resolve();
        }
      }, Math.max(finalTimeout, relayTimeout));
    });
  }

  handleIceCandidates(candidates) {
      if (this.pc && this.pc.remoteDescription) {
          this.context.utils.addIceCandidates(this.pc, candidates);
      } else {
          this.pendingIceCandidates.push(...candidates);
      }
  }

  async getanswer(fromEmail, answerData, attachments, emailSubject = '') {
    const startTime = Date.now();

    this.log('📥 receivedanswerdata');
    
    // Extract sequence number from email subject or data
    let parsedAnswerData = answerData;
    if (typeof parsedAnswerData === 'string') {
      try {
        parsedAnswerData = JSON.parse(parsedAnswerData);
      } catch (parseError) {
        this.log('❌ AnswerdataJSONparsefailed: ' + parseError.message);
        return;
      }
    }

    const sequence = emailSubject 
      ? this.sequenceManager.extractSequenceFromSubject(emailSubject)
      : (parsedAnswerData?.sequence || null);
    const answerChainKey = `${fromEmail}|answer:${sequence || 'none'}`;

    if (emailSubject) {
      this.log(`[SignalingSequence] recv_answer chain=${answerChainKey}, subject=${emailSubject}, parsedSequence=${sequence || 'none'}, dataSequence=${parsedAnswerData?.sequence || 'none'}`);
    }
    this.log(`[SignalingSequence] answer_chain in: chain=${answerChainKey}`);
    
    if (sequence) {
      this.log(`[SignalingSequence] received answer sequence: ${sequence} from  ${fromEmail}`);
      
      // Validate sequence number (deduplication check)
      if (!this.sequenceManager.shouldProcessAnswer(sequence)) {
        this.log(`⚠️ [SignalingSequence] rejected duplicate answer: serial number ${sequence}`);
        return;
      }
    }

    if (!answerData) {
      this.log('❌ Not foundanswerdata');
      return;
    }

    // Filter out avatar attachments to avoid showing them in chat history
    const nonAvatarAttachments = attachments ? attachments.filter(att => {
      const filename = att.filename || att.name || '';
      return !filename.startsWith('myavatar_');
    }) : [];
    
    if (nonAvatarAttachments.length > 0) {
      this.log(`📥 received ${nonAvatarAttachments.length}  attachments (Answer)(avatar excluded)`);
      this.handleReceivedAttachments(fromEmail, nonAvatarAttachments);
    }

    this.context.targetEmail = fromEmail;
    answerData = parsedAnswerData;

    if (typeof answerData === 'string') {
      try {
        answerData = JSON.parse(answerData);
      } catch (parseError) {
        this.log('❌ AnswerdataJSONparsefailed: ' + parseError.message);
        return;
      }
    }

    if (!answerData.sdp) {
      this.log('❌ AnswerdatamissingSDP');
      return;
    }

    const pc = this.pc;

    if (!pc) {
      this.log('⚠️ ignoreanswer: PeerConnection Peericon/elephantdoes not exist');
      return;
    }

    if (pc.signalingState === 'stable') {
      this.log('⏭️ ignoreduplicateanswer: connectionis in stable status');
      return;
    }

    if (this.processingAnswer) {
      this.log('⏳ processanother answer, ignorethis request');
      return;
    }

    try {
      this.processingAnswer = true;

      if (pc.signalingState === 'have-local-offer') {
        this.log('🔄 normalprocessanswer: PCstatus as  have-local-offer');

        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerData.sdp }));
        this.log('✅ remoteanswerdescriptionsetsucceeded');
        
        // [P0 Optimization-Plan 3] Close signaling mode polling after receiving Answer and restore normal frequency
        this._disableSignalingModePolling();
        
        // Mark answer as processed
        if (sequence) {
          this.sequenceManager.markAnswerProcessed(sequence);
          this.log(`[SignalingSequence] answerProcess completed: serial number ${sequence}`);
          this.log(`[SignalingSequence] answer_chain done: chain=${answerChainKey}`);
        }
        
        // Mark offer as completed
        this.sequenceManager.markOfferCompleted(fromEmail, 'completed');

        if (answerData.candidates && Array.isArray(answerData.candidates)) {
          this.log(`📥 process ICE candidates in Answer (${answerData.candidates.length})`);
          await this.context.utils.addIceCandidates(pc, answerData.candidates);
        }

      } else {
        this.log(`⚠️ PCstatusnot match: ${pc.signalingState}, unable tosetanswer`);
      }

    } catch (e) {
      this.log('❌ processanswerfailed: ' + e.message);
      // Mark offer as failed
      this.sequenceManager.markOfferCompleted(fromEmail, 'failed');
    } finally {
      this.processingAnswer = false;
    }
  }

  // Function to send offer
  async sendoffer(toemail, options = {}) {
    const config = this.context.config;
    const webRTCLogger = this.context.logger;
    const { addfriend, readme } = options;

    if (!this.fixedTargetEmail) {
      this.fixedTargetEmail = toemail;
    }
    this.context.targetEmail = this.fixedTargetEmail;

    this.log('📞 startexecute sendOfferfunction, targetmailbox: ' + toemail);

    const myEmail = this.context.myEmail;
    const targetEmail = this.fixedTargetEmail || toemail;

    // Fix: strengthen role validation - use validateEmails to ensure emails are valid
    if (!this.validateEmails(myEmail, targetEmail, 'sendoffer')) {
      this.log(`⚠️ email verification failed, Cancelsendoffer`);
      return;
    }

    // Fix: strengthen role validation - only Sender (smaller email) can send Offer
    const isPolite = this.context.utils.isPolite(myEmail, targetEmail);
    if (isPolite) {
      this.log(`⚠️ [role block]I am Receiver (${myEmail} > ${targetEmail}), not shouldsend Offer. only Sender cansend Offer. `);
      this.log(`⚠️ ifreceivedpeer Discover, shouldwaitpeer Offer,  or partyReady to receive connection. `);
      return;
    }

    // Extra validation: ensure myEmail < targetEmail
    if (myEmail >= targetEmail) {
      this.log(`⚠️ [role verificationfailed]email comparisonresultexception: ${myEmail} >= ${targetEmail}, Cancelsendoffer`);
      return;
    }

    this.log('✅ [roleConfirm]I am Sender (Impolite), mailbox is small, prepareinitiate Offer');
    if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.roleSender') || 'role: Sender, prepareinitiateconnection...'}`;

    // 🎯 Optimization: pre-generate BackupScenarios for peer to speed up subsequent Answer generation
    // Note: if pre-generated when user selected contact, existing result is returned quickly here
    this.ensureBackupScenariosFor(targetEmail).then(() => {
      this.log(`[optimization]BackupScenariosready(possiblefrom pre-generate)`);
    });

    const currentTime = Date.now();
    if (currentTime - this.lastSendOfferTime < config.MIN_SEND_INTERVAL * 2) { 
      this.log('⏱️  sendshort interval, ignoreduplicaterequest (interval: ' + (currentTime - this.lastSendOfferTime) + 'ms)');
      return;
    }
    this.lastSendOfferTime = currentTime;

    if (!toemail) {
      this.log('❌ targetmailboxaddress as empty');
      return;
    }

    // Fix: add stricter connection state check
    if (this.pc) {
      const connectionState = this.pc.connectionState;
      const signalingState = this.pc.signalingState;
      
      if (connectionState === 'connected') {
        this.log('⚠️ Connected, ignoreduplicateconnectionrequest');
        return;
      }
      
      // If peer's Offer has been received, should not send Offer
      if (signalingState === 'have-remote-offer') {
        this.log('⚠️ [state interception]alreadyreceivedpeer Offer (signalingState: have-remote-offer), not should againsend Offer');
        this.log('⚠️ should send Answer instead of Offer');
        return;
      }
      
      // If Offer has been sent and waiting for Answer
      if (signalingState === 'have-local-offer') {
        this.log('⚠️ [state interception]alreadysend Offer in wait Answer (signalingState: have-local-offer)');
        return;
      }
    }

    if (this.handshakeInProgress) {
      this.log('⚠️ establishing connection, prioritycompletedcurrentconnectionprocess/program, ignoresendofferrequest');
      return;
    }

    if (this.makingOffer) {
      this.log('⚠️ already waiting for Answer, ignoreduplicatesendofferrequest');
      return;
    }
    
    // Fix: add flag to record whether peer's Offer has been processed
    if (this.hasReceivedOffer) {
      this.log('⚠️ [flag bitblock]alreadyreceived and processpeer Offer, not should againsend Offer');
      return;
    }
    
    // Check if pending offer exists
    if (this.sequenceManager.hasPendingOffer(targetEmail)) {
      this.log(`⚠️ [SignalingSequence] pending offer already existsto  ${targetEmail}, skipsend`);
      return;
    }

    if (this.pc) {
      this.log('🔄 closeoldconnection, sendnewoffer');
      try {
        this.pc.close();
      } catch (e) {
        this.context.logger.error('closeoldconnectionfailed:', e);
      }
      this.pc = null;
      this.collectedIceCandidates = [];
    }
    this.handshakeInProgress = true;
    this.makingOffer = true;
    this.hasSentOffer = true; // Mark offer as sent

    this.context.targetEmail = toemail; 

    this.log('🔧 createRTCPeerConnection...');

    let pc;
    try {
      // 🎯 Get optimized ICE configuration
      const optimizedConfig = await this.getOptimizedIceConfig();
      
      pc = await this.retryOperation(
        () => new RTCPeerConnection(optimizedConfig),
        'createRTCPeerConnection',
        3,
        2000
      );
      this.pc = pc; 
      this.log('✅ createRTCPeerConnectionsucceeded (useoptimizationafter STUN configuration)');

      this.collectedIceCandidates = [];
    } catch (e) {
      this.log('❌ createRTCPeerConnectionfailed: ' + e.message);
      this.handshakeInProgress = false;
      this.makingOffer = false;

      this.clearConnectionTimeout(toemail);

      this.context.element.dispatchEvent(new CustomEvent('connection-failed', {
        detail: { email: toemail, reason: e.message }
      }));

      return;
    }

    if (this.context.dataChannelManager) {
      this.context.dataChannelManager.createDataChannel(pc);
    }

    const timeoutId = setTimeout(() => {
      this.log(`⏱️ Connection timeout (${config.CONNECTION_TIMEOUT}ms), cleanresource...`);

      this.webRTCConnectionStatus = 'disconnected';
      this.handshakeInProgress = false;
      this.makingOffer = false;
      this.context.eventBus.emit('connection:statusChanged', 'disconnected');

      // Key fix: clean up pending offer state on connection timeout so subsequent reconnects can send new offers
      this.sequenceManager.markOfferCompleted(toemail, 'timeout');
      this.log(`[SignalingSequence] Connection timeout, cleanpendingprocessofferstatus: ${toemail}`);

      if (this.pc) {
        try {
          this.pc.close();
        } catch (e) {
          console.error('closetimeoutconnectionfailed:', e);
        }
        this.pc = null;
      }

      this.context.element.dispatchEvent(new CustomEvent('connection-failed', {
        detail: { email: toemail, reason: 'timeout' }
      }));

      this.connectionTimeoutTimers.delete(toemail);
      this.log('❌ Connection timeout, cleanresource');
      if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.connectionTimeout') || 'Connection timeout'}`;

      this.log('🔄 Connection timeout, triggerautoreconnect...');
      setTimeout(() => {
        this.handleReconnect();
      }, config.RETRY_DELAY || 2000);
    }, config.CONNECTION_TIMEOUT);

    this.connectionTimeoutTimers.set(toemail, timeoutId);

    const handleConnectionStateChange = (connection) => {
      const state = connection.connectionState;
      this.log(`🔄 connection state changed: ${state}`);
      if (this.statusDiv) this.statusDiv.textContent = `@:  ${(window.i18n?.t('chat.connectionState') || '{state}').replace('{state}', state)}`;

      if (state === 'connected') {
        this.log('🎉 connectionsucceeded!');
        this.stopPolling();
        this.handshakeInProgress = false;
        this.makingOffer = false;
        this.webRTCConnectionStatus = 'connected';
        this.context.eventBus.emit('connection:statusChanged', 'connected');
        this.clearConnectionTimeout(toemail);
      } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.log('❌ connectiondisconnect/failed!');
        this.stopPolling();
        this.handshakeInProgress = false;
        this.makingOffer = false;
        this.webRTCConnectionStatus = 'disconnected';
        this.context.eventBus.emit('connection:statusChanged', 'disconnected');
        this.clearConnectionTimeout(toemail);

        this.log('🔄 connectiondisconnect/failed, triggerautoreconnect...');
        setTimeout(() => {
          this.handleReconnect();
        }, config.RETRY_DELAY || 2000);
      }

      setTimeout(() => {
        this.triggerFetchEmails(2, true);
      }, 1000);
    };

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      this.log(`🧊 ICE connection@:  ${iceState}`);
      if (this.statusDiv) this.statusDiv.textContent = `@:  ${(window.i18n?.t('chat.iceState') || 'ICE connection{state}').replace('{state}', iceState)}`;

      if (iceState !== 'disconnected' && this.iceDisconnectedTimerId) {
        clearTimeout(this.iceDisconnectedTimerId);
        this.iceDisconnectedTimerId = null;
      }

      // When ICE connection state changes to failed, disconnected, or closed, immediately update P2P status and reset flags
      if (iceState === 'failed' || iceState === 'disconnected' || iceState === 'closed') {
        this.log(`⚠️ ICE connection abnormal: ${iceState}, updateP2Pstatus and resetconnectionflag`);
        this.webRTCConnectionStatus = 'disconnected';
        this.context.eventBus.emit('connection:statusChanged', 'disconnected');
        
        // Key fix: immediately reset connection state flags to ensure subsequent reconnects work
        this.handshakeInProgress = false;
        this.makingOffer = false;
        this.log(`🧹 ICEexceptiontimereset stateflag: handshakeInProgress=false, makingOffer=false`);

        // 🆕 Start signaling state reset timeout (force clear signaling state after 30 seconds)
        this.startSignalingResetTimeout(toemail);

        // Trigger fast reconnect when ICE connection fails
        if (iceState === 'failed') {
          this.log('🔄 ICE connectionfailed, triggerfastreconnect...');
          setTimeout(() => {
            this.handleReconnect(true);  // Urgent reconnect, bypass debounce
          }, config.RETRY_DELAY || 2000);
        }
      }

      // 🆕 Cancel signaling state reset timeout timer when ICE connection succeeds
      if (iceState === 'connected') {
        this.cancelSignalingResetTimeout();
      }

      if (iceState === 'disconnected' && !this.iceDisconnectedTimerId) {
        const delay = config.ICE_DISCONNECTED_RECONNECT_DELAY || 3000;
        const pcRef = pc;
        this.iceDisconnectedTimerId = setTimeout(() => {
          this.iceDisconnectedTimerId = null;
          if (this.pc !== pcRef) return;
          if (pcRef.iceConnectionState !== 'disconnected') return;
          this.log(`🔄 ICE disconnected continuous ${delay}ms, notificationDataChannelentered suspiciousstatus...`);
          this.context.eventBus.emit('ice:disconnected', {
            currentState: this.webRTCConnectionStatus,
            timestamp: Date.now()
          });
        }, delay);
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        // Check candidate type
        const candidateType = candidate.candidate.includes('typ host') ? 'host' :
          candidate.candidate.includes('typ srflx') ? 'srflx' :
            candidate.candidate.includes('typ relay') ? 'relay' :
              candidate.candidate.includes('typ prflx') ? 'prflx' : 'unknown';

        // Skip host-type candidates if host candidates are disabled
        const enableHostCandidate = this.context.config?.ENABLE_HOST_CANDIDATE ?? false;
        if (candidateType === 'host' && !enableHostCandidate) {
          this.log(`🚫 skiphostcandidate (ENABLE_HOST_CANDIDATE=${enableHostCandidate})`);
          return;
        }

        this.collectedIceCandidates.push(candidate);
        this.log(`📥 collected ICE candidate (${this.collectedIceCandidates.length}): type=${candidateType}`);
        if (this.statusDiv) this.statusDiv.textContent = `@:  ${(window.i18n?.t('chat.iceCandidateCollecting') || 'collect ICE candidates')}(${this.collectedIceCandidates.length}): ${candidateType}`;
      } else {
        this.log(`✅ ICE candidate collection completed, total ${this.collectedIceCandidates.length} `);
        if (this.statusDiv) this.statusDiv.textContent = `@:  ${(window.i18n?.t('chat.iceCandidateComplete') || 'ICE candidate collection completed')}(${this.collectedIceCandidates.length})`;
      }
    };

    try {
      const offer = await this.retryOperation(
        () => pc.createOffer(),
        'createOffer',
        3,
        2000
      );
      
      await this.retryOperation(
        () => pc.setLocalDescription(offer),
        'setlocalOffer',
        3,
        2000
      );

      await this.waitForIceGathering(pc);

      const filteredCandidates = await config.utils ? config.utils.filterHighPriorityIceCandidates(this.collectedIceCandidates) : this.collectedIceCandidates;
      
      const sdpToUse = pc.localDescription ? pc.localDescription.sdp : offer.sdp;
      
      // Get user avatar attachment
      let attachments = [];
      let avatarAttachment = null;
      let shouldAttachAvatar = false;
      
      // Get user avatar and add to attachment (only sent in first Offer email to new contact)
      // Check if it is a new contact (using the new persistent storage mechanism)
      // Prefer newContactStorage; fall back to _newContactMap if not available
      if (window.newContactStorage && window.newContactStorage.isNewContact) {
        shouldAttachAvatar = window.newContactStorage.isNewContact(toemail);
      } else {
        // Backward compatibility
        shouldAttachAvatar = window._newContactMap && window._newContactMap.get(toemail);
      }
      
      if (shouldAttachAvatar) {
        try {
          const myAvatarData = this._getMyAvatarData();
          if (myAvatarData) {
            const avatarExt = this._getFileExtension(myAvatarData.mimeType);
            const avatarFilename = `myavatar_${this._generateRandomId()}.${avatarExt}`;
            const avatarCid = `avatar_${Date.now()}_${this._generateRandomId()}`;
            
            // Convert avatar data to base64 string (browser-compatible way)
            let avatarContent;
            if (myAvatarData.isBase64) {
              // Pass base64 data directly (strip data:image/xxx;base64, prefix)
              avatarContent = myAvatarData.data.split(',')[1];
            } else {
              avatarContent = myAvatarData.data;
            }
            
            attachments.push({
              filename: avatarFilename,
              content: avatarContent,
              cid: avatarCid,
              encoding: 'base64'  // Mark as base64 encoded
            });
            
            avatarAttachment = {
              filename: avatarFilename,
              mimeType: myAvatarData.mimeType,
              size: myAvatarData.size,
              cid: avatarCid
            };
            
            this.log(`🖼️ Offer emailattachavatar: ${avatarFilename} (${myAvatarData.mimeType})`);
          } else {
            this.log(`⚠️ is newcontactbutunable to getavatardata, skipattachavatar`);
          }
        } catch (error) {
          this.log(`⚠️ getavatarfailed: ${error.message}`);
        }
      } else {
        this.log(`🖼️ not is newcontact, Offer emailnot attachavatar`);
      }
      
      // 🆕 Fix: check if reconnect scenario; if so, use unique sequence number
      const retryCount = this.connectionRetryCounts.get(toemail) || 0;
      let offerSequence;
      if (retryCount > 0) {
        // Reconnect scenario: use unique sequence number based on timestamp
        offerSequence = this.sequenceManager.getUniqueSequence(toemail, 'offer');
        this.log(`[SignalingSequence] reconnectmode: useuniqueserial number ${offerSequence}`);
      } else {
        // Normal scenario: use incrementing sequence number
        offerSequence = this.sequenceManager.getNextSequence(toemail, 'offer');
      }
      const offerSubject = this.sequenceManager.generateSubject('offer', toemail, offerSequence);
      
      const offerMessage = {
        readme: readme || window.i18n?.t('chat.signalEmailReadme') || 'MailLink email-chat signaling email. Please do not delete within 3 minutes; it will be automatically deleted when expired (you may also delete it manually).',
        type: 'offer',
        sdp: sdpToUse,
        candidates: filteredCandidates,
        avatarAttachment: avatarAttachment,
        sequence: offerSequence // Include sequence number for debugging
      };

      this.log(`[SignalingSequence] sendofferserial number: ${offerMessage.sequence} to  ${toemail}`);
      if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.sendingOffer') || 'sendOffer signaling...'}`;

      // Build email subject; append readme content if present (limit 32 chars)
      let finalSubject = offerSubject;
      if (readme) {
        const truncatedReadme = readme.substring(0, 32);
        finalSubject = `${offerSubject} - ${truncatedReadme}`;
        this.log(`[SignalingSequence] emailsubjectadditional requestcontent: ${truncatedReadme}${readme.length > 32 ? ' (truncate)' : ''}`);
      }

      if (this.context.signalingManager) {
          // Send with custom subject
          await this.context.signalingManager.sendSignalEmailWithSubject(toemail, offerMessage, attachments, finalSubject);
          this.log('📧 OfferemailSent');
          if (this.statusDiv) this.statusDiv.textContent = `@:  ${window.i18n?.t('chat.offerSentWaiting') || 'Offer signalingSent, waitresponse...'}`;
          
          // Confirm avatar has been sent (using the new persistent storage mechanism)
          if (avatarAttachment) {
            if (window.newContactStorage && window.newContactStorage.confirmAvatarSent) {
              window.newContactStorage.confirmAvatarSent(toemail, true);
              this.log(`🗑️ Confirmedavatarsendsucceeded, remove mark: ${toemail}`);
            } else if (window._newContactMap) {
              // Backward compatibility
              window._newContactMap.delete(toemail);
              this.log(`🗑️ Removednewcontactmark(compatibility mode): ${toemail}`);
            }
          }
          
          // Mark offer as pending
          this.sequenceManager.markOfferPending(toemail, offerMessage.sequence);
          
          // [P0 Optimization-Plan 3] Enable high-frequency signaling mode polling (500ms) after sending Offer
          // Principle: after Sender sends Offer, the key is to receive Answer ASAP; increase IMAP polling frequency
          this.log('⚡ [P0 optimization]OfferSent, enable high-frequency polling in signaling mode(500ms)waitAnswer...');
          this._enableSignalingModePolling();
      }

    } catch (e) {
      this.log('❌ create/sendOfferfailed: ' + e.message);
      
      // Send failed, update avatar send status (using the new persistent storage mechanism)
      if (avatarAttachment) {
        if (window.newContactStorage && window.newContactStorage.confirmAvatarSent) {
          window.newContactStorage.confirmAvatarSent(toemail, false);  // false indicates send failure
          this.log(`⚠️ Offeremail sendingfailed, avatarflag retained forretry: ${toemail}`);
        }
      }
      
      this.handshakeInProgress = false;
      this.makingOffer = false;
      this.clearConnectionTimeout(toemail);
    }
  }

  /**
   * Get current user's avatar data
   * @returns {Object|null} Avatar data object {data: base64/svg string, mimeType: string, size: number} or null
   */
  _getMyAvatarData() {
    try {
      let avatar = null;
      
      // Priority 1: check user-configured avatar
      if (typeof window.getSelectedConfig === 'function') {
        const selectedConfig = window.getSelectedConfig();
        if (selectedConfig && selectedConfig.avatar) {
          avatar = selectedConfig.avatar;
        }
      }
      
      // Priority 2: check locally stored avatar
      if (!avatar) {
        const storedConfig = localStorage.getItem('userConfig');
        if (storedConfig) {
          const config = JSON.parse(storedConfig);
          if (config.avatar) {
            avatar = config.avatar;
          }
        }
      }
      
      if (!avatar) {
        return null;
      }
      
      const rawAvatar = String(avatar).trim();
      
      // If it is a Base64 image in data:image format
      if (rawAvatar.startsWith('data:image')) {
        const mimeMatch = rawAvatar.match(/data:([^;]+);base64,/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
        const base64Data = rawAvatar.split(',')[1];
        const size = base64Data ? Math.ceil(base64Data.length * 0.75) : 0;
        
        return {
          data: rawAvatar,
          mimeType: mimeType,
          size: size,
          isBase64: true
        };
      }
      
      // If it is SVG, convert to data:image/svg+xml format
      if (rawAvatar.startsWith('<svg')) {
        const svgData = encodeURIComponent(rawAvatar);
        const dataUrl = `data:image/svg+xml;charset=utf-8,${svgData}`;
        return {
          data: dataUrl,
          mimeType: 'image/svg+xml',
          size: rawAvatar.length,
          isBase64: false
        };
      }
      
      return null;
    } catch (e) {
      this.log(`failed to get avatar data: ${e.message}`);
      return null;
    }
  }

  /**
   * Generate random ID
   */
  _generateRandomId() {
    return Math.random().toString(36).substring(2, 10);
  }

  /**
   * Get file extension
   */
  _getFileExtension(mimeType) {
    const mimeToExt = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
      'image/svg+xml': 'svg'
    };
    return mimeToExt[mimeType] || 'png';
  }

  /**
   * [P0 Optimization-Plan 3] Enable high-frequency signaling mode polling
   * Notify polling scheduler to enter signaling mode (500ms interval) to speed up Answer reception
   */
  _enableSignalingModePolling() {
    try {
      if (typeof window !== 'undefined' && window.pollingScheduler) {
        window.pollingScheduler.postMessage({
          type: 'signalingState',
          data: { active: true }
        });
        this.log('📡 poll scheduler switched to signaling mode(500msinterval)');
      } else if (typeof window !== 'undefined' && window.workerManager) {
        window.workerManager.postMessage('pollingScheduler', {
          type: 'signalingState',
          data: { active: true }
        });
        this.log('📡 poll scheduler switched to signaling mode(500msinterval)');
      }
    } catch (e) {
      this.log(`⚠️ failed to enable signaling mode polling: ${e.message}`);
    }
  }

  /**
   * [P0 Optimization-Plan 3] Close signaling mode polling and restore normal frequency
   */
  _disableSignalingModePolling() {
    try {
      if (typeof window !== 'undefined' && window.pollingScheduler) {
        window.pollingScheduler.postMessage({
          type: 'signalingState',
          data: { active: false }
        });
        this.log('📡 poll scheduler restored normal mode');
      } else if (typeof window !== 'undefined' && window.workerManager) {
        window.workerManager.postMessage('pollingScheduler', {
          type: 'signalingState',
          data: { active: false }
        });
        this.log('📡 poll scheduler restored normal mode');
      }
    } catch (e) {
      this.log(`⚠️ failed to disable signaling mode polling: ${e.message}`);
    }
  }

  // ========== 🎯 WebRTC bidirectional ACK logic ==========

  /**
   * Set up DataChannel handler and ACK message processing
   */
  setupDataChannelHandlers(dataChannel, targetEmail) {
    this.log(`⚙️ setDataChannel handler, target: ${targetEmail}`);
    
    this.currentDataChannel = dataChannel;

    dataChannel.onopen = () => {
      this.log(`🟢 DataChannel opened (label: ${dataChannel.label})`);
      
      // ✅ Key: when DataChannel opens, check whether ACK needs to be sent
      if (this.connectionReadyState === 'ready-to-send') {
        this.log(`📤 detected ICE connected, currentin sendconnection-ack...`);
        this.sendConnectionAck(targetEmail);
      }
    };

    dataChannel.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        
        // 📥 Handle peer's connection-ack
        if (message.type === 'webrtc-ack') {
          this.log(`📨 received peer connection-ack (sequence: ${message.sequence})`);
          this.handleReceivedConnectionAck(message, targetEmail);
        }
        
        // 📥 processpeerconnection-ack-confirm
        else if (message.type === 'webrtc-ack-confirm') {
          this.log(`✅ received peer ack-confirm (sequence: ${message.sequence})`);
          this.handleReceivedAckConfirm(message, targetEmail);
        }
        
        // othermessagetype - not process, bydataChannelManagerprocess
        else {
          // Forward message to dataChannelManager
          if (this.context.dataChannelManager && this.context.dataChannelManager.handleMessage) {
            this.context.dataChannelManager.handleMessage(message);
          }
        }
      } catch (error) {
        this.log(`⚠️ DataChannelmessageparsefailed: ${error.message}`);
      }
    };

    dataChannel.onerror = (error) => {
      this.log(`❌ DataChannelerror: ${error}`);
    };

    dataChannel.onclose = () => {
      this.log(`🔌 DataChannelclose`);
      // If connection already shows success, update state
      if (this.webRTCConnectionStatus === 'connected') {
        this.webRTCConnectionStatus = 'disconnected';
        this.context.eventBus.emit('connection:statusChanged', 'disconnected');
        this.log(`⚠️ DataChannel closedcauseConnectingbreak, Updated as disconnectstatus`);
      }
    };
  }

  /**
   * Send Connection ACK
   */
  sendConnectionAck(targetEmail) {
    if (!this.currentDataChannel || this.currentDataChannel.readyState !== 'open') {
      this.log(`⚠️ DataChannel not open (state: ${this.currentDataChannel?.readyState}), unable to sendack`);
      return;
    }

    // Generate ACK sequence number
    this.ackSequence++;
    
    const ackMessage = {
      type: 'webrtc-ack',
      status: 'ready',
      timestamp: Date.now(),
      sequence: this.ackSequence,
      myEmail: this.context.myEmail,
      targetEmail: targetEmail
    };
    
    try {
      this.currentDataChannel.send(JSON.stringify(ackMessage));
      this.log(`📤 sendconnection-ack (sequence: ${this.ackSequence}, status: ready)`);
      
      // Start ACK timeout monitoring (auto-escalate if no peer confirmation within 15 seconds)
      this.setupAckTimeout(this.ackSequence, targetEmail);
      
    } catch (error) {
      this.log(`❌ sendackfailed: ${error.message}`);
    }
  }

  /**
   * Handle received peer ACK
   */
  handleReceivedConnectionAck(message, targetEmail) {
    this.log(`🎯 processpeerconnection-ack (sequence: ${message.sequence}, status: ${message.status})`);
    
    // Reply immediately with confirmation
    this.sendAckConfirm(message.sequence, targetEmail);
    
    // This means peer is also ready; we can show connected
    if (this.connectionReadyState !== 'ready-confirmed') {
      this.connectionReadyState = 'ready-confirmed';
      this.showConnectionEstablished(targetEmail);
    }
  }

  /**
   * Reply to peer's ACK confirmation
   */
  sendAckConfirm(ackSequence, targetEmail) {
    if (!this.currentDataChannel || this.currentDataChannel.readyState !== 'open') {
      this.log(`⚠️ DataChannel not open, unable to reply ack confirmation`);
      return;
    }
    
    const confirmMessage = {
      type: 'webrtc-ack-confirm',
      status: 'confirmed',
      timestamp: Date.now(),
      sequence: ackSequence,  // reply with same sequence number
      myEmail: this.context.myEmail,
      targetEmail: targetEmail
    };
    
    try {
      this.currentDataChannel.send(JSON.stringify(confirmMessage));
      this.log(`📤 reply ack-confirm (sequence: ${ackSequence}, status: confirmed)`);
    } catch (error) {
      this.log(`❌ reply ack confirmation failed: ${error.message}`);
    }
  }

  /**
   * Handle received peer ACK confirmation
   */
  handleReceivedAckConfirm(message, targetEmail) {
    this.log(`✅ peer confirmed connection-ack (sequence: ${message.sequence})`);
    
    // Clear ACK timeout
    if (this.ackReceiveTimeout) {
      clearTimeout(this.ackReceiveTimeout);
      this.ackReceiveTimeout = null;
      this.log(`⏱️ cleared ACK receive timeout`);
    }
    
    this.lastReceivedAckTimestamp = Date.now();
    
    // Bidirectional confirmation complete
    if (this.connectionReadyState !== 'ready-confirmed') {
      this.connectionReadyState = 'ready-confirmed';
      this.showConnectionEstablished(targetEmail);
    }
  }

  /**
   * ACK receive timeout handling (fallback: auto-escalate after timeout)
   */
  setupAckTimeout(ackSequence, targetEmail) {
    if (this.ackReceiveTimeout) {
      clearTimeout(this.ackReceiveTimeout);
    }
    
    const ACK_TIMEOUT = 15000; // 15 seconds
    
    this.ackReceiveTimeout = setTimeout(() => {
      this.ackReceiveTimeout = null;
      
      if (this.connectionReadyState === 'ready-to-send') {
        this.log(`⚠️ did not receive peer ack-confirm within 15s, autoupgrade as Connected(fallbackprocess)`);
        this.connectionReadyState = 'ready-confirmed';
        this.showConnectionEstablished(targetEmail);
      }
    }, ACK_TIMEOUT);
  }

  /**
   * Show connection success
   */
  showConnectionEstablished(targetEmail) {
    this.log(`🎉 WebRTC connection confirmed established!`);
    
    this.stopPolling();
    this.handshakeInProgress = false;
    this.makingOffer = false;
    this.webRTCConnectionStatus = 'connected';
    
    // ✅ Trigger event to notify UI
    this.context.eventBus.emit('connection:statusChanged', 'connected');
    
    this.connectionRetryCounts.delete(targetEmail);
    this.clearConnectionTimeout(targetEmail);
    
    if (this.statusDiv) {
      this.statusDiv.textContent = `✅ ${window.i18n?.t('chat.connected') || 'Connected'}`;
    }
    
    this.log(`📊 connection state details: readyState=${this.connectionReadyState}, ackSequence=${this.ackSequence}`);
  }

  /**
   * Reset connection ACK state (used for cleanup during reconnect)
   */
  resetConnectionAckState() {
    this.connectionReadyState = 'not-ready';
    this.ackSequence = 0;
    this.currentDataChannel = null;
    
    if (this.ackReceiveTimeout) {
      clearTimeout(this.ackReceiveTimeout);
      this.ackReceiveTimeout = null;
    }
    
    this.ackReceivedMap.clear();
    this.log(`🧹 resetconnectionACKstatus`);
  }

  /**
   * 🆕 Start signaling state reset timeout timer
   * Force clean signaling state when ICE disconnect exceeds 30 seconds without recovery
   * @param {string} targetEmail - Target email
   */
  startSignalingResetTimeout(targetEmail) {
    // Cancel existing timer
    this.cancelSignalingResetTimeout();
    
    this.log(`⏱️ started signaling state reset timeout timer (${this.SIGNALING_RESET_TIMEOUT}ms)...`);
    
    this.signalingResetTimeoutId = setTimeout(() => {
      this.log(`⏱️ signaling state reset timeout (${this.SIGNALING_RESET_TIMEOUT}ms), forcecleansignaling status...`);
      if (this.sequenceManager && targetEmail) {
        this.sequenceManager.resetState(targetEmail);
        this.log(`[SignalingSequence] timeoutafterforceresetsignaling status: ${targetEmail}`);
      }
      this.signalingResetTimeoutId = null;
    }, this.SIGNALING_RESET_TIMEOUT);
  }

  /**
   * 🆕 Cancel signaling state reset timeout timer
   */
  cancelSignalingResetTimeout() {
    if (this.signalingResetTimeoutId) {
      clearTimeout(this.signalingResetTimeoutId);
      this.signalingResetTimeoutId = null;
      this.log(`⏱️ canceled signaling state reset timeout timer`);
    }
  }
}
