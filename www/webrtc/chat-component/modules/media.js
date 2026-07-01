export class MediaCallManager {
  constructor(context) {
    this.context = context;
    this.shadowRoot = context.shadowRoot;

    this.videoCallBtn = this.shadowRoot.getElementById('videoCallBtn');
    this.callBtn = this.shadowRoot.getElementById('callBtn');
    this.toggleVideoBtn = this.shadowRoot.getElementById('toggleVideoBtn');
    this.toggleAudioBtn = this.shadowRoot.getElementById('toggleAudioBtn');
    this.endCallBtn = this.shadowRoot.getElementById('endCallBtn');

    this.videoContainer = this.shadowRoot.getElementById('video-container');
    this.localVideo = this.shadowRoot.getElementById('localVideo');
    this.remoteVideo = this.shadowRoot.getElementById('remoteVideo');
    this.remoteAudio = this.shadowRoot.getElementById('remoteAudio');
    this.callAcceptDialog = this.shadowRoot.getElementById('callAcceptDialog');
    this.incomingCallInfo = this.shadowRoot.getElementById('incomingCallInfo');
    this.acceptCallBtn = this.shadowRoot.getElementById('acceptCallBtn');
    this.rejectCallBtn = this.shadowRoot.getElementById('rejectCallBtn');
    this.overlay = this.shadowRoot.getElementById('overlay');
    this.videoDragHandle = this.shadowRoot.getElementById('video-drag-handle');

    this.isInCall = false;
    this.callMode = null;
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.makingOffer = false;
    this.pendingIncoming = null;
    this.isDragging = false;
    this.dragOffsetX = 0;
    this.dragOffsetY = 0;

    this.onVideoCallClick = this.onVideoCallClick.bind(this);
    this.onAudioCallClick = this.onAudioCallClick.bind(this);
    this.onToggleVideoClick = this.onToggleVideoClick.bind(this);
    this.onToggleAudioClick = this.onToggleAudioClick.bind(this);
    this.onEndCallClick = this.onEndCallClick.bind(this);
    this.onAcceptCallClick = this.onAcceptCallClick.bind(this);
    this.onRejectCallClick = this.onRejectCallClick.bind(this);
    this.onDragStart = this.onDragStart.bind(this);
    this.onDragMove = this.onDragMove.bind(this);
    this.onDragEnd = this.onDragEnd.bind(this);

    this.handleDataChannelMessage = this.handleDataChannelMessage.bind(this);
    this.handleVoiceOffer = this.handleVoiceOffer.bind(this);
    this.handleVideoOffer = this.handleVideoOffer.bind(this);
    this.handleVoiceAnswer = this.handleVoiceAnswer.bind(this);
    this.handleVideoAnswer = this.handleVideoAnswer.bind(this);
    this.handleEndCall = this.handleEndCall.bind(this);
    this.handleConnectionStatus = this.handleConnectionStatus.bind(this);

    if (this.videoCallBtn) this.videoCallBtn.addEventListener('click', this.onVideoCallClick);
    if (this.callBtn) this.callBtn.addEventListener('click', this.onAudioCallClick);
    if (this.toggleVideoBtn) this.toggleVideoBtn.addEventListener('click', this.onToggleVideoClick);
    if (this.toggleAudioBtn) this.toggleAudioBtn.addEventListener('click', this.onToggleAudioClick);
    if (this.endCallBtn) this.endCallBtn.addEventListener('click', this.onEndCallClick);
    if (this.acceptCallBtn) this.acceptCallBtn.addEventListener('click', this.onAcceptCallClick);
    if (this.rejectCallBtn) this.rejectCallBtn.addEventListener('click', this.onRejectCallClick);
    if (this.videoDragHandle) this.videoDragHandle.addEventListener('mousedown', this.onDragStart);
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragEnd);

    if (this.context.eventBus) {
      this.context.eventBus.on('datachannel:messageReceived', this.handleDataChannelMessage);
      this.context.eventBus.on('media:voice-offer', this.handleVoiceOffer);
      this.context.eventBus.on('media:video-offer', this.handleVideoOffer);
      this.context.eventBus.on('media:voice-answer', this.handleVoiceAnswer);
      this.context.eventBus.on('media:video-answer', this.handleVideoAnswer);
      this.context.eventBus.on('media:end-call', this.handleEndCall);
      this.context.eventBus.on('connection:statusChanged', this.handleConnectionStatus);
      this.context.eventBus.on('connection:needReconnect', this.handleConnectionStatus);
    }

    this.resetUI();
  }

  get logger() { return this.context.logger; }
  get eventBus() { return this.context.eventBus; }
  get uiRenderer() { return this.context.uiRenderer; }
  get dataChannelManager() { return this.context.dataChannelManager; }
  get connectionManager() { return this.context.connectionManager; }

  onDragStart(event) {
    if (!this.videoContainer) return;
    if (!event) return;
    event.preventDefault();
    const rect = this.videoContainer.getBoundingClientRect();
    this.dragOffsetX = event.clientX - rect.left;
    this.dragOffsetY = event.clientY - rect.top;
    this.isDragging = true;
    this.videoContainer.style.left = `${rect.left}px`;
    this.videoContainer.style.top = `${rect.top}px`;
    this.videoContainer.style.right = 'auto';
  }

  onDragMove(event) {
    if (!this.isDragging || !this.videoContainer || !event) return;
    const maxLeft = Math.max(0, window.innerWidth - this.videoContainer.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - this.videoContainer.offsetHeight);
    const nextLeft = Math.min(Math.max(0, event.clientX - this.dragOffsetX), maxLeft);
    const nextTop = Math.min(Math.max(0, event.clientY - this.dragOffsetY), maxTop);
    this.videoContainer.style.left = `${nextLeft}px`;
    this.videoContainer.style.top = `${nextTop}px`;
  }

  onDragEnd() {
    if (!this.isDragging) return;
    this.isDragging = false;
  }

  getPeerConnection() {
    const pc = this.connectionManager?.pc;
    if (!pc) return null;
    return pc;
  }

  handleConnectionStatus(status) {
    if (status === 'connected') {
      // Connection restored
      if (!this.isInCall) {
        this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.reconnected') || 'Reconnected'));
      }
      return;
    }
    
    // Connection disconnected
    if (this.pendingIncoming) {
      this.pendingIncoming = null;
      this.hideIncomingCallDialog();
    }
    if (this.isInCall) {
      this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.callDisconnecting') || 'Connection disconnected, ending call...'));
      this.endCall(false);
    } else {
      this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.notConnected') || 'Disconnected'));
      this.resetUI();
    }
  }

  resetUI() {
    if (this.videoCallBtn) this.videoCallBtn.style.display = '';
    if (this.callBtn) this.callBtn.style.display = '';
    if (this.toggleVideoBtn) this.toggleVideoBtn.style.display = 'none';
    if (this.toggleAudioBtn) this.toggleAudioBtn.style.display = 'none';
    if (this.endCallBtn) this.endCallBtn.style.display = 'none';
    if (this.videoContainer) this.videoContainer.style.display = 'none';

    const p2pReady = Boolean(this.uiRenderer?.isP2PReady);
    if (this.videoCallBtn) this.videoCallBtn.disabled = !p2pReady;
    if (this.callBtn) this.callBtn.disabled = !p2pReady;
    if (this.toggleVideoBtn) this.toggleVideoBtn.disabled = true;
    if (this.toggleAudioBtn) this.toggleAudioBtn.disabled = true;
    if (this.endCallBtn) this.endCallBtn.disabled = true;

    if (this.toggleVideoBtn) {
      const el = this.toggleVideoBtn.querySelector('.btn-text');
      if (el) el.textContent = window.i18n?.t('chat.closeVideo') || 'Turn off video';
    }
    if (this.toggleAudioBtn) {
      const el = this.toggleAudioBtn.querySelector('.btn-text');
      if (el) el.textContent = window.i18n?.t('chat.closeAudio') || 'Turn off audio';
    }
  }

  setActiveUI(mode) {
    if (this.videoCallBtn) this.videoCallBtn.style.display = 'none';
    if (this.callBtn) this.callBtn.style.display = 'none';

    if (this.toggleAudioBtn) {
      this.toggleAudioBtn.style.display = '';
      this.toggleAudioBtn.disabled = false;
    }

    if (this.endCallBtn) {
      this.endCallBtn.style.display = '';
      this.endCallBtn.disabled = false;
    }

    if (mode === 'video') {
      if (this.toggleVideoBtn) {
        this.toggleVideoBtn.style.display = '';
        this.toggleVideoBtn.disabled = false;
      }
      if (this.videoContainer) {
        // Reset possible drag position to ensure container displays at default position
        this.videoContainer.style.setProperty('left', '', 'important');
        this.videoContainer.style.setProperty('top', '', 'important');
        this.videoContainer.style.setProperty('right', '', 'important');
        this.videoContainer.style.display = 'block';
        this.logger?.info(`[Media] Video container displayed for mode: ${mode}`);
      }
    } else {
      if (this.toggleVideoBtn) {
        this.toggleVideoBtn.style.display = 'none';
        this.toggleVideoBtn.disabled = true;
      }
      if (this.videoContainer) this.videoContainer.style.display = 'none';
    }

    // Sync uiRenderer state to ensure button disable/enable logic is consistent
    if (this.uiRenderer && typeof this.uiRenderer.setP2PReady === 'function') {
      this.uiRenderer.setP2PReady(this.uiRenderer.isP2PReady);
    }
  }

  updateToggleLabels() {
    if (this.localStream) {
      const videoOn = this.localStream.getVideoTracks().some(t => t.enabled);
      const audioOn = this.localStream.getAudioTracks().some(t => t.enabled);
      if (this.toggleVideoBtn) {
        const el = this.toggleVideoBtn.querySelector('.btn-text');
        if (el) el.textContent = videoOn ? (window.i18n?.t('chat.closeVideo') || 'Turn off video') : (window.i18n?.t('chat.openVideo') || 'Turn on video');
      }
      if (this.toggleAudioBtn) {
        const el = this.toggleAudioBtn.querySelector('.btn-text');
        if (el) el.textContent = audioOn ? (window.i18n?.t('chat.closeAudio') || 'Turn off audio') : (window.i18n?.t('chat.openAudio') || 'Turn on audio');
      }
    }
  }

  async onVideoCallClick() {
    await this.startCall('video');
  }

  async onAudioCallClick() {
    await this.startCall('audio');
  }

  onToggleVideoClick() {
    if (!this.localStream) return;
    const tracks = this.localStream.getVideoTracks();
    for (const t of tracks) t.enabled = !t.enabled;
    this.updateToggleLabels();
  }

  onToggleAudioClick() {
    if (!this.localStream) return;
    const tracks = this.localStream.getAudioTracks();
    for (const t of tracks) t.enabled = !t.enabled;
    this.updateToggleLabels();
  }

  onEndCallClick() {
    this.endCall(true);
  }

  onAcceptCallClick() {
    if (!this.pendingIncoming) return;
    const { mode, sdp } = this.pendingIncoming;
    this.pendingIncoming = null;
    this.hideIncomingCallDialog();
    this.answerCall(mode, sdp);
  }

  onRejectCallClick() {
    if (!this.pendingIncoming) return;
    this.pendingIncoming = null;
    this.hideIncomingCallDialog();
    this.sendSignal({ type: 'end-call' });
    this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.callRejected') || 'Call declined'));
    this.resetUI();
  }

  showIncomingCallDialog(mode) {
    if (this.incomingCallInfo) {
      const incomingVideoCall = window.i18n?.t('chat.incomingVideoCall') || 'Incoming video call request';
      const incomingVoiceCall = window.i18n?.t('chat.incomingVoiceCall') || 'Incoming voice call request';
      this.incomingCallInfo.textContent = mode === 'video' ? incomingVideoCall : incomingVoiceCall;
    }
    if (this.callAcceptDialog) this.callAcceptDialog.style.display = 'block';
    if (this.overlay) this.overlay.style.display = 'block';
  }

  hideIncomingCallDialog() {
    if (this.callAcceptDialog) this.callAcceptDialog.style.display = 'none';
    if (this.overlay) this.overlay.style.display = 'none';
  }

  async ensureLocalStream(mode) {
    const needVideo = mode === 'video';
    const constraints = { audio: true, video: needVideo };
    try {
      if (this.localStream) {
        const hasAudio = this.localStream.getAudioTracks().length > 0;
        const hasVideo = this.localStream.getVideoTracks().length > 0;
        if (hasAudio && (!needVideo || hasVideo)) return this.localStream;
      }
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this.localVideo) {
        this.localVideo.srcObject = this.localStream;
        if (typeof this.localVideo.play === 'function') {
          this.localVideo.play().catch(() => {});
        }
      }
      this.updateToggleLabels();
      return this.localStream;
    } catch (err) {
      // Check if it is a device-in-use error
      if (err.name === 'NotReadableError' && err.message.includes('Device in use')) {
        this.logger?.warn('getUserMedia failed: ' + (window.i18n?.t('chat.deviceInUse') || 'Device in use by another app'), err);
        this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.deviceOccupied') || 'Device in use, local video may be unavailable'));
        // Return existing local stream if available; otherwise return null but continue call flow
        return this.localStream || null;
      }
      this.logger?.error('getUserMedia failed', err);
      this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.mediaPermissionFailed') || 'Media permission failed'));
      throw err;
    }
  }

  ensureRemoteBindings() {
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = this.remoteStream;
      if (typeof this.remoteAudio.play === 'function') {
        this.remoteAudio.play().catch(err => this.logger?.debug('Remote audio play failed:', err));
      }
    }
    if (this.remoteVideo) {
      this.remoteVideo.srcObject = this.remoteStream;
      if (typeof this.remoteVideo.play === 'function') {
        this.remoteVideo.play().catch(err => this.logger?.debug('Remote video play failed:', err));
      }
    }
  }

  attachLocalTracks(pc, stream, mode) {
    // Check if stream exists
    if (!stream) {
      this.logger?.warn('attachLocalTracks: stream is null or undefined');
      return;
    }
    
    const wantVideo = mode === 'video';
    const wantAudio = true;
    const senders = pc.getSenders ? pc.getSenders() : [];
    const senderTrackIds = new Set(senders.map(s => s.track?.id).filter(Boolean));

    for (const track of stream.getTracks()) {
      if (track.kind === 'audio' && !wantAudio) continue;
      if (track.kind === 'video' && !wantVideo) continue;
      if (senderTrackIds.has(track.id)) continue;
      try {
        pc.addTrack(track, stream);
      } catch (e) {
        this.logger?.warn('addTrack failed', e);
      }
    }
  }

  installPeerHandlers(pc) {
    if (!pc) return;
    this.ensureRemoteBindings();

    pc.ontrack = (event) => {
      const tracks = event?.streams?.[0]?.getTracks?.() || [];
      if (tracks.length > 0) {
        const existing = new Set(this.remoteStream.getTracks().map(t => t.id));
        for (const t of tracks) {
          if (existing.has(t.id)) continue;
          this.remoteStream.addTrack(t);
        }
        this.ensureRemoteBindings();
        return;
      }

      const track = event?.track;
      if (track) {
        const existing = new Set(this.remoteStream.getTracks().map(t => t.id));
        if (!existing.has(track.id)) {
          this.remoteStream.addTrack(track);
        }
        this.ensureRemoteBindings();
      }
    };

    if (!pc.__mailinkMediaIceWrapped) {
      const prev = pc.onicecandidate;
      pc.onicecandidate = (evt) => {
        try {
          if (typeof prev === 'function') prev(evt);
        } finally {
          const candidate = evt?.candidate;
          if (!candidate) return;
          // Send ICE candidates whenever in call or initiating/answering a call
          if (!this.isInCall && !this.makingOffer && !this.pendingIncoming) return;
          this.sendSignal({ type: 'media-ice', candidate });
        }
      };
      pc.__mailinkMediaIceWrapped = true;
    }
  }

  sendSignal(payload) {
    if (!this.dataChannelManager?.isOpen?.()) {
      this.logger?.warn('Cannot send media signal: DataChannel not open');
      return false;
    }
    return this.dataChannelManager.sendData(payload);
  }

  async startCall(mode) {
    if (this.isInCall) return;
    const pc = this.getPeerConnection();
    if (!pc) return;
    if (!this.dataChannelManager?.isOpen?.()) return;
    if (pc.signalingState !== 'stable') return;

    this.makingOffer = true;
    this.callMode = mode;

    try {
      const stream = await this.ensureLocalStream(mode);
      // Check if media stream was successfully acquired
      if (!stream) {
        this.logger?.error('Failed to acquire media stream');
        this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.cannotGetMediaStream') || 'Unable to get media stream'));
        this.isInCall = false;
        this.callMode = null;
        this.resetUI();
        return;
      }
      
      this.setActiveUI(mode);
      // Trigger call status change event to ensure UI renderer updates button state
      this.eventBus?.emit('media:callStateChanged', { isInCall: true, callMode: mode });
      const videoCallPreparing = window.i18n?.t('chat.videoCallPreparing') || 'Preparing video call';
      const voiceCallPreparing = window.i18n?.t('chat.voiceCallPreparing') || 'Preparing voice call';
      const videoCallActive = window.i18n?.t('chat.videoCallActive') || 'Video call in progress';
      const voiceCallActive = window.i18n?.t('chat.voiceCallActive') || 'Voice call in progress';
      this.uiRenderer?.updateStatus('@:  ' + (mode === 'video' ? videoCallPreparing : voiceCallPreparing));
      this.installPeerHandlers(pc);
      this.attachLocalTracks(pc, stream, mode);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.isInCall = true;
      this.setActiveUI(mode);
      this.uiRenderer?.updateStatus('@:  ' + (mode === 'video' ? videoCallActive : voiceCallActive));
      // Trigger call status change event again to ensure UI renderer updates button state
      this.eventBus?.emit('media:callStateChanged', { isInCall: true, callMode: mode });

      this.sendSignal({ type: mode === 'video' ? 'video-offer' : 'voice-offer', sdp: pc.localDescription.sdp });
    } catch (err) {
      this.logger?.error('startCall failed', err);
      // Check if it is a device-in-use error
      if (err.name === 'NotReadableError' && err.message.includes('Device in use')) {
        // Device is in use; do not reset UI, keep video container visible
        this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.deviceOccupiedRetry') || 'Device in use, please close other instances and retry'));
      } else {
        this.isInCall = false;
        this.callMode = null;
        this.resetUI();
      }
    } finally {
      this.makingOffer = false;
    }
  }

  async answerCall(mode, sdp) {
    const pc = this.getPeerConnection();
    if (!pc) return;
    if (!this.dataChannelManager?.isOpen?.()) return;

    try {
      this.callMode = mode;
      // Set state and show UI early to ensure immediate feedback on user click and normal ICE candidate sending
      this.isInCall = true;
      this.setActiveUI(mode);
      // Trigger call status change event to ensure UI renderer updates button state
      this.eventBus?.emit('media:callStateChanged', { isInCall: true, callMode: mode });
      const videoCallPreparing2 = window.i18n?.t('chat.videoCallPreparing') || 'Preparing video call';
      const voiceCallPreparing2 = window.i18n?.t('chat.voiceCallPreparing') || 'Preparing voice call';
      const videoCallActive2 = window.i18n?.t('chat.videoCallActive') || 'Video call in progress';
      const voiceCallActive2 = window.i18n?.t('chat.voiceCallActive') || 'Voice call in progress';
      this.uiRenderer?.updateStatus('@:  ' + (mode === 'video' ? videoCallPreparing2 : voiceCallPreparing2));

      const stream = await this.ensureLocalStream(mode);
      // Check if media stream was successfully acquired
      if (!stream) {
        this.logger?.warn(window.i18n?.t('chat.cannotGetLocalStream') || 'Unable to get local media stream, but call continues');
        this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.callContinuesWithoutStream') || 'Unable to get local media stream, call continuing...'));
        // Continue call flow，Do not end call
      } else {
        this.installPeerHandlers(pc);
        this.attachLocalTracks(pc, stream, mode);
      }
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.uiRenderer?.updateStatus('@:  ' + (mode === 'video' ? videoCallActive2 : voiceCallActive2));
      // Call setActiveUI again to ensure final UI state consistency
      this.setActiveUI(mode);
      // Trigger call status change event again to ensure UI renderer updates button state
      this.eventBus?.emit('media:callStateChanged', { isInCall: true, callMode: mode });

      this.sendSignal({ type: mode === 'video' ? 'video-answer' : 'voice-answer', sdp: pc.localDescription.sdp });
    } catch (err) {
      this.logger?.error('answerCall failed', err);
      // Check if it is a device-in-use error
      if (err.name === 'NotReadableError' && err.message.includes('Device in use')) {
        // Device is in use; keep call state and continue subsequent flow
        this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.deviceOccupiedCallContinues') || 'Device in use, call continuing...'));
        // Do not call endCall，Keep call state
      } else {
        this.endCall(false);
      }
    }
  }

  async handleVoiceOffer(data) {
    const sdp = data?.sdp;
    if (typeof sdp !== 'string' || !sdp) return;
    if (this.isInCall) {
      this.endCall(false);
    }
    this.pendingIncoming = { mode: 'audio', sdp };
    this.showIncomingCallDialog('audio');
  }

  async handleVideoOffer(data) {
    const sdp = data?.sdp;
    if (typeof sdp !== 'string' || !sdp) return;
    if (this.isInCall) {
      this.endCall(false);
    }
    this.pendingIncoming = { mode: 'video', sdp };
    this.showIncomingCallDialog('video');
  }

  async handleVoiceAnswer(data) {
    const sdp = data?.sdp;
    if (typeof sdp !== 'string' || !sdp) return;
    const pc = this.getPeerConnection();
    if (!pc) return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (err) {
      this.logger?.error('setRemoteDescription(answer) failed', err);
      this.endCall(false);
    }
  }

  async handleVideoAnswer(data) {
    await this.handleVoiceAnswer(data);
  }

  handleEndCall() {
    this.endCall(false);
  }

  handleDataChannelMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'media-ice') return;
    const candidate = data.candidate;
    if (!candidate) return;
    const pc = this.getPeerConnection();
    if (!pc) return;
    pc.addIceCandidate(candidate).catch((err) => {
      this.logger?.warn('addIceCandidate failed', err);
    });
  }

  endCall(shouldSignal) {
    if (shouldSignal) {
      this.sendSignal({ type: 'end-call' });
    }

    this.isInCall = false;
    this.callMode = null;

    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    if (this.localVideo) this.localVideo.srcObject = null;

    for (const t of this.remoteStream.getTracks()) {
      try { this.remoteStream.removeTrack(t); } catch (_) {}
    }
    this.ensureRemoteBindings();

    const p2pReady = Boolean(this.uiRenderer?.isP2PReady);
    if (p2pReady) {
      this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.connected') || 'Connected'));
    } else {
      this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.notConnected') || 'Disconnected'));
    }
    this.resetUI();
    
    // Trigger call status change event to ensure UI renderer updates button state
    this.eventBus?.emit('media:callStateChanged', { isInCall: false, callMode: null });
  }

  /**
   * Check if device is available
   * @returns {Promise<boolean>} Whether device is available
   */
  async isDeviceAvailable() {
    try {
      this.logger?.info('Checking device availability...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach(track => track.stop());
      this.logger?.info('Device check successful, devices are available');
      return true;
    } catch (err) {
      this.logger?.warn('Device check failed:', err.message);
      return false;
    }
  }

  /**
   * Try to reacquire device
   * @param {string} mode - Call mode 'video' or 'audio'
   * @returns {Promise<MediaStream|null>} Media stream or null
   */
  async tryReacquireDevices(mode) {
    try {
      this.logger?.info(`Attempting to reacquire devices for mode: ${mode}`);
      const available = await this.isDeviceAvailable();
      if (!available) {
        this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.deviceStillOccupied') || 'Device still in use, try again later'));
        return null;
      }
      
      // Try to reacquire media stream
      const stream = await this.ensureLocalStream(mode);
      if (stream) {
        this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.deviceReacquired') || 'Device reacquired successfully'));
      }
      return stream;
    } catch (err) {
      this.logger?.error('Failed to reacquire devices:', err);
      this.uiRenderer?.updateStatus('@:  ' + (window.i18n?.t('chat.deviceReacquireFailed') || 'Device reacquisition failed'));
      return null;
    }
  }
}
