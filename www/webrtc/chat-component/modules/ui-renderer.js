import { getFileIcon } from '../../../components/file-display/utils/file-type-resolver.js';

export class UIRenderer {
  constructor(context) {
    this.context = context;
    this.shadowRoot = context.shadowRoot;
    
    this.chatDisplay = this.shadowRoot.getElementById('chatDisplay');
    this.chatlog = this.shadowRoot.getElementById('chatlog');
    this.msgInput = this.shadowRoot.getElementById('msgInput');
    this.msgInputContainer = this.shadowRoot.getElementById('msgInputContainer');
    this.composerArea = this.shadowRoot.getElementById('composerArea');
    this.sendBtn = this.shadowRoot.getElementById('sendBtn');
    this.statusDiv = this.shadowRoot.getElementById('status');
    this.videoCallBtn = this.shadowRoot.getElementById('videoCallBtn');
    this.callBtn = this.shadowRoot.getElementById('callBtn');
    this.toggleVideoBtn = this.shadowRoot.getElementById('toggleVideoBtn');
    this.toggleAudioBtn = this.shadowRoot.getElementById('toggleAudioBtn');
    this.endCallBtn = this.shadowRoot.getElementById('endCallBtn');
    this.isComposerExpanded = false;
    this.baseMsgInputHeight = null;
    this.isP2PReady = false;
    this.natInfo = null;
    
    // [Optimization 2] NAT display state management
    this._natDisplayState = {
      detected: false,      // Whether NAT type has been detected
      displayed: false,     // Whether it has been shown in the title bar
      cachedInfo: null,     // Cached NAT information
      connectionEstablished: false  // Whether the connection has been established
    };

    // Worker-related properties
    this.messageFormatterWorker = null;
    this.pendingMessages = new Map();
    this.messageSequence = 0;
    this.renderQueue = [];
    this.isProcessingQueue = false;

    // Bind methods
    this.log = this.log.bind(this);
    this.displayMessage = this.displayMessage.bind(this);
    this.markMessageAsConfirmed = this.markMessageAsConfirmed.bind(this);
    this.markMessageAsSending = this.markMessageAsSending.bind(this);
    this.toggleChatlogVisibility = this.toggleChatlogVisibility.bind(this);
    this.handleSendClick = this.handleSendClick.bind(this);
    this.handleInputKeydown = this.handleInputKeydown.bind(this);
    this.expandComposer = this.expandComposer.bind(this);
    this.collapseComposer = this.collapseComposer.bind(this);
    this.setP2PReady = this.setP2PReady.bind(this);
    this._handleUserActivity = this._handleUserActivity.bind(this);

    // Bind events
    if (this.statusDiv) {
      this.statusDiv.addEventListener('click', this.toggleChatlogVisibility);
    }
    if (this.sendBtn) {
        this.sendBtn.addEventListener('click', this.handleSendClick);
    }
    if (this.msgInput) {
        this.msgInput.addEventListener('keydown', this.handleInputKeydown);
        this.msgInput.addEventListener('click', this.expandComposer);
        this.msgInput.addEventListener('focus', this.expandComposer);
        this.msgInput.style.overflowY = 'auto';
    }
    if (this.msgInputContainer) {
        this.msgInputContainer.addEventListener('mousedown', this.expandComposer);
        this.msgInputContainer.addEventListener('mouseleave', this.collapseComposer);
    }
    
    this._initMsgInputContextMenu();
    
    // Setup user activity tracking
    this._setupUserActivityTracking();
    
    // File buttons
    const selectFileBtn = this.shadowRoot.getElementById('selectFileBtn');
    if (selectFileBtn) {
        selectFileBtn.addEventListener('click', () => {
            if (this.context.fileTransferManager) {
                this.context.fileTransferManager.selectAndSendFile();
            }
        });
    }

    // Emoji picker - use the standalone emoji-picker component
    this._initEmojiPickerComponent();

    // Subscribe to log events
    if (this.context.eventBus) {
        this.context.eventBus.on('log', (data) => {
            // Avoid displaying debug logs in UI if needed, or just display all
            // formattedMessage in Logger already includes timestamp and level
            if (data.message) {
                 this.log(data.message);
            }
        });

        this.context.eventBus.on('datachannel:open', () => {
            this.setP2PReady(true);
            // [Optimization 2] DataChannel open indicates the connection is established; trigger delayed NAT type display
            this.onConnectionEstablished();
        });

        this.context.eventBus.on('connection:statusChanged', (status) => {
            if (status === 'connected') {
                // [Optimization 2] Connection state changed to connected; trigger delayed NAT type display
                this.onConnectionEstablished();
            } else {
                this.setP2PReady(false);
                this.updateStatus('@:  ' + (window.i18n?.t('chat.notConnected') || 'Disconnected'));
            }
        });

        this.context.eventBus.on('connection:needReconnect', () => {
            this.setP2PReady(false);
            this.updateStatus('@:  ' + (window.i18n?.t('chat.connectionDisconnected') || 'Connection disconnected'));
            // [Optimization 2] Reset NAT display state when the connection disconnects
            this._resetNatDisplayState();
        });
        
        // Listen for UI button status update events
        this.context.eventBus.on('ui:videoBtnState', (isConnected) => {
            this.setP2PReady(isConnected);
        });
        
        // Listen for media call state changes
        this.context.eventBus.on('media:callStateChanged', (callState) => {
            this.updateMediaCallButtons(callState);
        });
        
        // Listen for NAT type detection completion events
        this.context.eventBus.on('nat:detected', (natInfo) => {
            this.updateNatDisplay(natInfo);
        });
    }

    const initialStatus = this.context?.connectionManager?.webRTCConnectionStatus;
    this.setP2PReady(initialStatus === 'connected');
  }

  _setupUserActivityTracking() {
    const activityEvents = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart'];
    
    activityEvents.forEach(eventType => {
      this.shadowRoot.addEventListener(eventType, this._handleUserActivity, { passive: true });
    });

    // [Fix] Email image message click event delegation
    // Use event delegation to handle clicks on email image messages, avoiding lost event listeners when historical messages are reloaded
    this.shadowRoot.addEventListener('click', (e) => {
      // Check whether the click target is inside an email-image-message container
      const emailImageMessage = e.target.closest('.email-image-message');
      if (!emailImageMessage) {
        return;
      }

      // Check whether an image was clicked (if so, do not trigger email details)
      const clickedImg = e.target.closest('img');
      if (clickedImg) {
        console.log('[UIRenderer] event delegation: email image message click ignored (clicked image)');
        return;
      }

      // Get the email ID
      const emailEmid = emailImageMessage.dataset.emid;
      if (!emailEmid) {
        console.warn('[UIRenderer] event delegation: email image message has no emid, unable to open detail');
        return;
      }

      console.log('[UIRenderer] event delegation: email image message click triggered, emid:', emailEmid, 'target:', e.target.tagName, 'class:', e.target.className);
      e.stopPropagation();

      // Update email message style (blue to black)
      const emailSubjectLine = emailImageMessage.querySelector('.email-subject-line');

      if (emailSubjectLine) {
        emailSubjectLine.style.color = '#333';
        emailSubjectLine.classList.remove('email-msg-unread');
        emailSubjectLine.classList.add('email-msg-read');
      }

      // Update database is_read and open email details
      this._markEmailMessageRead(emailEmid);
      this.openEmailDetail(emailEmid);
    });
  }

  async _handleUserActivity() {
    if (this.context.updateUserActivity) {
      this.context.updateUserActivity();
    }

    const targetEmail = this.context.targetEmail;
    const myEmail = this.context.myEmail;
    
    if (targetEmail && myEmail) {
      await this._markCurrentChatAsRead(myEmail, targetEmail);
    }
  }

  async _markCurrentChatAsRead(myEmail, targetEmail) {
    try {
      if (window.electronAPI && window.electronAPI.markAllMessagesRead) {
        await window.electronAPI.markAllMessagesRead({
          myEmail: myEmail,
          targetEmail: targetEmail
        });

        this.context.element.dispatchEvent(new CustomEvent('clear-unread-badge', {
          detail: {
            email: targetEmail
          },
          bubbles: true,
          composed: true
        }));
      }
    } catch (err) {
      console.error('Failed to mark messages as read on user activity:', err);
    }
  }

  setP2PReady(isReady) {
    this.isP2PReady = Boolean(isReady);
    if (this.videoCallBtn) this.videoCallBtn.disabled = !this.isP2PReady;
    if (this.callBtn) this.callBtn.disabled = !this.isP2PReady;

    const isInCall = Boolean(this.context?.mediaCallManager?.isInCall);

    // During a call, ensure the end call button is available and the initiate button is hidden
    if (isInCall) {
      if (this.videoCallBtn) this.videoCallBtn.style.display = 'none';
      if (this.callBtn) this.callBtn.style.display = 'none';
      if (this.toggleVideoBtn) this.toggleVideoBtn.disabled = false;
      if (this.toggleAudioBtn) this.toggleAudioBtn.disabled = false;
      if (this.endCallBtn) this.endCallBtn.disabled = false;
      if (this.toggleVideoBtn) this.toggleVideoBtn.style.display = this.context?.mediaCallManager?.callMode === 'video' ? '' : 'none';
      if (this.endCallBtn) this.endCallBtn.style.display = '';
    } else if (this.isP2PReady) {
      // If not in a call but P2P is ready, keep the default state of other buttons
      if (this.videoCallBtn) this.videoCallBtn.style.display = '';
      if (this.callBtn) this.callBtn.style.display = '';
      if (this.toggleVideoBtn) this.toggleVideoBtn.disabled = true;
      if (this.toggleAudioBtn) this.toggleAudioBtn.disabled = true;
      if (this.endCallBtn) this.endCallBtn.disabled = true;
      if (this.toggleVideoBtn) this.toggleVideoBtn.style.display = 'none';
      if (this.endCallBtn) this.endCallBtn.style.display = 'none';
    } else {
      // P2P not ready
      if (this.videoCallBtn) this.videoCallBtn.style.display = '';
      if (this.callBtn) this.callBtn.style.display = '';
      if (this.videoCallBtn) this.videoCallBtn.disabled = true;
      if (this.callBtn) this.callBtn.disabled = true;
      if (this.toggleVideoBtn) this.toggleVideoBtn.disabled = true;
      if (this.toggleAudioBtn) this.toggleAudioBtn.disabled = true;
      if (this.endCallBtn) this.endCallBtn.disabled = true;
      if (this.toggleVideoBtn) this.toggleVideoBtn.style.display = 'none';
      if (this.endCallBtn) this.endCallBtn.style.display = 'none';
    }
  }
  
  updateMediaCallButtons(callState) {
    const { isInCall, callMode } = callState;
    
    if (isInCall) {
      if (this.videoCallBtn) this.videoCallBtn.style.display = 'none';
      if (this.callBtn) this.callBtn.style.display = 'none';
      if (this.endCallBtn) this.endCallBtn.style.display = '';
      if (this.endCallBtn) this.endCallBtn.disabled = false;
      
      if (callMode === 'video') {
        if (this.toggleVideoBtn) this.toggleVideoBtn.style.display = '';
        if (this.toggleVideoBtn) this.toggleVideoBtn.disabled = false;
      } else {
        if (this.toggleVideoBtn) this.toggleVideoBtn.style.display = 'none';
        if (this.toggleVideoBtn) this.toggleVideoBtn.disabled = true;
      }
      
      if (this.toggleAudioBtn) this.toggleAudioBtn.style.display = '';
      if (this.toggleAudioBtn) this.toggleAudioBtn.disabled = false;
    } else {
      if (this.videoCallBtn) this.videoCallBtn.style.display = '';
      if (this.callBtn) this.callBtn.style.display = '';
      if (this.endCallBtn) this.endCallBtn.style.display = 'none';
      if (this.endCallBtn) this.endCallBtn.disabled = true;
      if (this.toggleVideoBtn) this.toggleVideoBtn.style.display = 'none';
      if (this.toggleVideoBtn) this.toggleVideoBtn.disabled = true;
      if (this.toggleAudioBtn) this.toggleAudioBtn.style.display = 'none';
      if (this.toggleAudioBtn) this.toggleAudioBtn.disabled = true;
    }
  }

  expandComposer() {
    if (this.isComposerExpanded) return;
    if (this.composerArea && this.chatDisplay) {
      this.chatDisplay.style.flex = '0 0 40%';
      this.composerArea.style.flex = '0 0 60%';
      this.isComposerExpanded = true;
      return;
    }

    if (!this.msgInput) return;

    if (this.baseMsgInputHeight === null) {
      const rect = this.msgInput.getBoundingClientRect();
      if (rect && rect.height) {
        this.baseMsgInputHeight = rect.height;
      } else {
        const h = Number.parseFloat(getComputedStyle(this.msgInput).height);
        this.baseMsgInputHeight = Number.isFinite(h) && h > 0 ? h : 0;
      }
    }

    if (this.baseMsgInputHeight > 0) {
      this.msgInput.style.height = `${this.baseMsgInputHeight * 1.5}px`;
      this.isComposerExpanded = true;
    }
  }

  collapseComposer() {
    if (!this.isComposerExpanded) return;
    if (this.composerArea && this.chatDisplay) {
      this.chatDisplay.style.flex = '';
      this.composerArea.style.flex = '';
      this.isComposerExpanded = false;
      return;
    }

    if (!this.msgInput) return;
    if (this.baseMsgInputHeight === null) return;
    if (this.baseMsgInputHeight > 0) {
      this.msgInput.style.height = `${this.baseMsgInputHeight}px`;
    } else {
      this.msgInput.style.height = '';
    }
    this.isComposerExpanded = false;
  }

  updateStatus(message) {
    if (this.statusDiv) {
        this.statusDiv.textContent = message;
    }
  }

  updateNatDisplay(natInfo) {
    this.natInfo = natInfo;
    
    // [Optimization 2] Cache NAT information
    this._natDisplayState.detected = true;
    this._natDisplayState.cachedInfo = natInfo;
    
    // Determine whether to display immediately
    const shouldDisplayImmediately = !natInfo.isEarlyDetection || this._natDisplayState.connectionEstablished;
    
    if (shouldDisplayImmediately && natInfo && natInfo.type !== 'unknown' && !this._natDisplayState.displayed) {
      this._doDisplayNatType(natInfo);
    } else if (natInfo.isEarlyDetection && !this._natDisplayState.connectionEstablished) {
      // Detected early but connection not yet established; delay display
      this.log?.(`[NAT] ${(window.i18n?.t('chat.natDetectedWaiting') || 'detected {type}, wait for connection to display...').replace('{type}', natInfo.typeName)}`);
    }
  }
  
  /**
   * [Optimization 2] Actually display the NAT type in the title bar
   * @private
   */
  _doDisplayNatType(natInfo) {
    if (!natInfo || natInfo.type === 'unknown' || this._natDisplayState.displayed) {
      return;
    }
    
    this._natDisplayState.displayed = true;
    
    // Dispatch a custom event to window so the main page title bar displays the NAT type
    window.dispatchEvent(new CustomEvent('nat-type-detected', {
      detail: { natType: natInfo.typeName }
    }));
    
    this.log?.(`[NAT] ${(window.i18n?.t('chat.natDisplayedInTitle') || 'NAT type displayed in title bar: {type}').replace('{type}', natInfo.typeName)}`);
  }
  
  /**
   * [Optimization 2] Called when the connection is established, used to delay displaying the NAT type
   * @public
   */
  onConnectionEstablished() {
    this._natDisplayState.connectionEstablished = true;
    
    // If NAT information is already cached but not yet displayed, show it now
    if (this._natDisplayState.detected && !this._natDisplayState.displayed && this._natDisplayState.cachedInfo) {
      this.log?.(`[NAT] ${(window.i18n?.t('chat.natDelayedDisplay') || 'connection established, delay display NAT type: {type}').replace('{type}', this._natDisplayState.cachedInfo.typeName)}`);
      this._doDisplayNatType(this._natDisplayState.cachedInfo);
    }
  }
  
  /**
   * [Optimization 2] Reset NAT display state, called when the connection disconnects or the contact switches
   * @private
   */
  _resetNatDisplayState() {
    this._natDisplayState = {
      detected: false,
      displayed: false,
      cachedInfo: null,
      connectionEstablished: false
    };
    this.natInfo = null;
    this.log?.('[NAT] ' + (window.i18n?.t('chat.natDisplayReset') || 'NAT display status reset'));
  }

  handleSendClick() {
      const plainTextMsg = this.msgInput.value.trim();
      const hasStagedFile = this.context.fileTransferManager && this.context.fileTransferManager.stagedFile;

      if (!plainTextMsg && !hasStagedFile) {
        alert(window.i18n?.t('chat.pleaseEnterMessageOrFile') || 'Please enter a message or select a file');
        return;
      }

      if (!this.context.targetEmail) {
        alert(window.i18n?.t('chat.pleaseConnectRecipient') || 'Please connect to the recipient first');
        return;
      }
      
      // Prevent double click - disable the button for 1 second
      this.sendBtn.disabled = true;
      setTimeout(() => {
        this.sendBtn.disabled = false;
      }, 1000);

      // A. Send File
      if (hasStagedFile) {
        this.context.fileTransferManager.sendStagedFile();
      }

      // B. Send Text
      if (plainTextMsg) {
          this.context.chatManager.sendMessage(plainTextMsg);
          this.msgInput.value = '';
      }
  }

  handleInputKeydown(e) {
    // Ctrl+Enter for new line
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      const start = this.msgInput.selectionStart;
      const end = this.msgInput.selectionEnd;
      const value = this.msgInput.value;
      this.msgInput.value = value.substring(0, start) + '\n' + value.substring(end);
      this.msgInput.selectionStart = this.msgInput.selectionEnd = start + 1;
      return;
    }

    // Enter to send
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.handleSendClick();
    }
  }

  log(msg) {
    let simplifiedMsg = msg;
    const t = window.i18n?.t || ((k) => k);
    if (simplifiedMsg.includes('ICE candidate')) {
      if (simplifiedMsg.includes('collected ICE candidate')) simplifiedMsg = simplifiedMsg.replace(/Collected ICE candidate \((\d+)\): .+/, t('chat.iceCandidateCollecting').replace('{count}', '$1'));
      if (simplifiedMsg.includes('ICE candidate pool size:')) simplifiedMsg = simplifiedMsg.replace(/📊 ICE candidate pool size: \d+/, '📊 ' + t('chat.iceCandidatePoolReady'));
      if (simplifiedMsg.includes('ICE candidate filter:')) simplifiedMsg = simplifiedMsg.replace(/📋 ICE candidate filter: \d+ → \d+/, '📋 ' + t('chat.iceCandidateFilterComplete'));
      if (simplifiedMsg.includes('ICE candidate add:')) simplifiedMsg = simplifiedMsg.replace(/✅ ICE candidate added: \d+\/\d+ succeeded/, '✅ ' + t('chat.iceCandidateAddComplete'));
      if (simplifiedMsg.includes('Offer ICE candidate:')) simplifiedMsg = simplifiedMsg.replace(/📥 Offer ICE candidate: \d+ received/, '📥 ' + t('chat.offerIceCandidateReceived'));
    }
    if (simplifiedMsg.includes('ICE gathering strategy:')) simplifiedMsg = simplifiedMsg.replace(/🔧 ICE gathering strategy: .+/, '🔧 ' + t('chat.iceCollectStrategySet'));
    if (simplifiedMsg.includes('ICE gathering state changed:')) simplifiedMsg = simplifiedMsg.replace(/🧊 ICE gathering state changed: .+/, '🧊 ' + t('chat.iceStateUpdated'));
    if (simplifiedMsg.includes('ICE connection@: ')) simplifiedMsg = simplifiedMsg.replace(/🧊 ICE connection@:  .+/, '🧊 ' + t('chat.iceConnectionUpdated'));
    if (simplifiedMsg.includes('parse offer data')) {
      if (simplifiedMsg.includes('succeeded')) simplifiedMsg = simplifiedMsg.replace(/📋 Parse offer data succeeded: .+/, '📋 ' + t('chat.offerParseSuccess'));
      else if (simplifiedMsg.includes('failed')) simplifiedMsg = simplifiedMsg.replace(/❌ Parse offer data failed: .+/, '❌ ' + t('chat.offerParseFailed'));
    }
    if (simplifiedMsg.includes('original offer data:')) simplifiedMsg = simplifiedMsg.replace(/📋 Original offer data: .+/, '📋 ' + t('chat.offerDataReceived'));
    if (simplifiedMsg.includes('ICE gathering completed')) simplifiedMsg = simplifiedMsg.replace(/✅ ICE gathering completed: .+/, '✅ ' + t('chat.iceCollectComplete'));
    if (simplifiedMsg.includes('ICE gathering timeout')) simplifiedMsg = simplifiedMsg.replace(/⚠️ ICE gathering timeout, .+/, '⚠️ ' + t('chat.iceCollectTimeout'));

    const timeStr = window.utils && window.utils.format ? window.utils.format.formatTimeFull(new Date()) : new Date().toISOString();
    if (this.chatlog) {
      this.chatlog.value += `[${timeStr}] ${simplifiedMsg}\n`;
      this.chatlog.scrollTop = this.chatlog.scrollHeight;
    }
  }

  toggleChatlogVisibility() {
    if (this.chatlog) {
      const isVisible = this.chatlog.style.display !== 'none';
      this.chatlog.style.display = isVisible ? 'none' : 'block';
    }
  }

  displayMessage(sender, msg, id = null, timestamp = null, senderEmail = null, status = 100, emid = '', isRead = 0) {
    try {
      // Determine the message type and generate preview text
      let msgPreview;
      if (msg instanceof HTMLElement) {
        msgPreview = `[HTMLElement: ${msg.tagName}]`;
      } else if (typeof msg === 'string') {
        msgPreview = msg.substring(0, 50);
      } else {
        msgPreview = `[${typeof msg}: ${JSON.stringify(msg).substring(0, 50)}]`;
      }
      
      console.log('[UIRenderer] displayMessage called:', { sender, msg: msgPreview, id, timestamp, senderEmail, status, emid, isRead });
      
      if (msg instanceof HTMLElement) {
        console.log('[UIRenderer] Message is HTMLElement, using displayMessageElement');
        this.displayMessageElement(sender, msg, id, timestamp, senderEmail, status);
        return;
      }

      // If it is neither a string nor an HTMLElement, try converting it to a string
      if (typeof msg !== 'string') {
        console.warn('[UIRenderer] Message is not a string, converting:', typeof msg);
        msg = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
      }

      if (!this.messageFormatterWorker) {
        console.log('[UIRenderer] Worker not initialized, initializing...');
        this.initMessageFormatterWorker();
      }

      if (!this.messageFormatterWorker) {
        console.warn('[UIRenderer] Worker not available, using fallback');
        this.displayMessageFallback(sender, msg, id, timestamp, senderEmail, status, emid, isRead);
        return;
      }

      const sequence = ++this.messageSequence;
      console.log('[UIRenderer] Sending message to worker, sequence:', sequence);

      this.renderQueue.push({
        sequence,
        sender,
        id,
        timestamp,
        senderEmail,
        status,
        emid,
        isRead
      });

      this.messageFormatterWorker.postMessage({
        id: sequence,
        message: msg,
        timestamp,
        sender,
        senderEmail,
        httpPort: this.context.httpServerPort || 8080,
        isSender: sender === 'Me',
        status,
        emid,
        isRead
      });
    } catch (error) {
      console.error('[UIRenderer] displayMessage error:', error);
      // Use a fallback when an error occurs
      if (!(msg instanceof HTMLElement)) {
        // If msg is not a string, try converting it
        if (typeof msg !== 'string') {
          msg = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
        }
        this.displayMessageFallback(sender, msg, id, timestamp, senderEmail, status, emid, isRead);
      }
    }
  }

  displayMessageFallback(sender, msg, id = null, timestamp = null, senderEmail = null, status = 100, emid = '', isRead = 0) {
    let formattedTime = '';
    try {
      let msTimestamp;
      if (this.context.utils && this.context.utils.convertToMilliseconds) {
        msTimestamp = this.context.utils.convertToMilliseconds(timestamp);
      } else if (typeof timestamp === 'string' && timestamp.length > 15) {
        msTimestamp = Number(BigInt(timestamp) / BigInt(1000000));
      } else {
        msTimestamp = timestamp ? new Date(timestamp).getTime() : Date.now();
      }

      const date = isNaN(msTimestamp) ? new Date() : new Date(msTimestamp);
      const day = date.getDate().toString().padStart(2, '0');
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const seconds = date.getSeconds().toString().padStart(2, '0');
      const daySuffix = window.i18n?.t('common.daySuffix') || 'd';
      formattedTime = `${day}${daySuffix} ${hours}:${minutes}:${seconds}`;
    } catch (e) {
      console.error('Format time failed:', e);
      formattedTime = new Date().toLocaleString(window.i18n?.getLocale?.() || 'zh-CN');
    }

    if (id) {
      if (this.context.displayedMessageIds.has(id)) {
        return;
      }
      this.context.displayedMessageIds.add(id);
    }

    const msgContainer = document.createElement('div');
    msgContainer.className = 'message-container';
    if (id) {
      msgContainer.id = 'msg-container-' + id;
    }

    if (sender === 'Me') {
      msgContainer.classList.add('message-sent');
    } else {
      msgContainer.classList.add('message-received');
    }

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar avatar';
    avatarDiv.dataset.email = String(senderEmail || (sender === 'Me' ? this.context.myEmail : this.context.targetEmail) || '').trim().toLowerCase();

    if (this.context.avatarManager && this.context.avatarManager.getAvatar) {
      const email = avatarDiv.dataset.email;
      this.context.avatarManager.getAvatar(email).then(avatar => {
        const html = this.context.avatarManager.buildAvatarHtml
          ? this.context.avatarManager.buildAvatarHtml(avatar)
          : '';
        if (html) {
          avatarDiv.innerHTML = html;
        } else {
          avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
        }
      }).catch(e => {
        console.error('Load avatar failed:', e);
        avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
      });
    } else {
      avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
    }

    const msgContent = document.createElement('div');
    msgContent.className = 'message-content';

    const msgText = document.createElement('div');
    msgText.className = 'message-text';

    let finalMsg = msg;
    if (finalMsg.includes('http://127.0.0.1:')) {
      const currentPort = this.context.httpServerPort || 8080;
      const isMe = (sender === 'Me');

      finalMsg = finalMsg.replace(/http:\/\/127\.0\.0\.1:\d+\//g, `http://127.0.0.1:${currentPort}/`);

      if (!isMe && finalMsg.includes('/sends/')) {
        finalMsg = finalMsg.replace(/\/sends\//g, '/recvs/');
      }
      if (isMe && finalMsg.includes('/recvs/')) {
        finalMsg = finalMsg.replace(/\/recvs\//g, '/sends/');
      }
    }

    if (sender === 'Me' && status < 100) {
      if (finalMsg.includes('<img')) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = finalMsg;
        const images = tempDiv.querySelectorAll('img');
        images.forEach(img => {
          img.classList.add('sending-image');
          if (!img.hasAttribute('title') || !img.getAttribute('title')) {
            img.setAttribute('title', window.i18n?.t('chat.sending') || 'Sending');
          }
        });
        finalMsg = tempDiv.innerHTML;
      }
    }

    if (sender !== 'Me' && finalMsg.includes('file-path')) {
      finalMsg = finalMsg.replace(/<div class="file-path"[^>]*>[\s\S]*?<\/div>/g, '');
    }

    finalMsg = finalMsg.replace(/<image-file-display[^>]*>.*?<\/image-file-display>/gs, (match) => {
      let imgSrc = '';
      let thumbnailSrc = '';
      let imgAlt = window.i18n?.t('common.image') || 'image';
      let imgTitle = '';

      let offerStr = null;
      const brokenMatch = match.match(/offer=["']?(\{.*?\})["']?(?:\s+[a-zA-Z0-9\-]+=|>)/);
      if (brokenMatch) {
        offerStr = brokenMatch[1];
      } else {
        const normalMatch = match.match(/offer='([^']*)'/) || match.match(/offer="([^"]*)"/);
        if (normalMatch) offerStr = normalMatch[1];
      }
      
      const isSenderMatch = match.match(/is-sender/);
      
      const altMatch = match.match(/alt="([^"]*)"/);
      const titleMatch = match.match(/title="([^"]*)"/);

      imgAlt = altMatch ? altMatch[1] : (window.i18n?.t('common.image') || 'image');
      imgTitle = titleMatch ? titleMatch[1] : '';

      if (offerStr) {
         try {
           const offer = JSON.parse(offerStr.replace(/&quot;/g, '"'));
           const isSender = !!isSenderMatch;
           const originalFileName = offer.storedFileName || offer.filename || '';
           const fileName = encodeURIComponent(originalFileName);
           const thumbFileName = encodeURIComponent(originalFileName.substring(0, originalFileName.lastIndexOf('.')) + '_thumb.jpg');
           
           if (!altMatch) {
             imgAlt = offer.filename || (window.i18n?.t('common.image') || 'image');
           }
           
           const currentPort = this.context.httpServerPort || 8080;
           const folder = isSender ? 'sends' : 'recvs';
           imgSrc = `http://127.0.0.1:${currentPort}/${folder}/${fileName}`;
           thumbnailSrc = `http://127.0.0.1:${currentPort}/${folder}/${thumbFileName}`;
         } catch (e) {
           console.error('[UIRenderer] parse image-file-display offer failed:', e);
         }
      }

      const isSenderFlag = !!isSenderMatch;
      let safeStoredFileName = '';
      if (offerStr) {
         try {
           const o = JSON.parse(offerStr.replace(/&quot;/g, '"'));
           safeStoredFileName = o.storedFileName || o.filename || '';
         } catch(e) {}
      } else {
         safeStoredFileName = imgAlt;
      }
      
      const displaySrc = thumbnailSrc || imgSrc;
      const originalSrcAttr = imgSrc ? `data-original-src="${imgSrc}"` : '';
      
      return `<div class="image-message file-request transfer-completed" data-stored-filename="${encodeURIComponent(safeStoredFileName)}" data-is-sender="${isSenderFlag}" style="margin-top: 8px;">
        <img src="${displaySrc}" ${originalSrcAttr} alt="${imgAlt}" title="${imgTitle}" style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" onclick="window.open(this.dataset.originalSrc || this.src, '_blank');" onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}else{this.onerror=null;this.alt='${window.i18n?.t('chat.imageLoadFailed') || 'image(load failed)'}';}">
      </div>`;
    });

    finalMsg = finalMsg.replace(/<normal-file-display[^>]*>.*?<\/normal-file-display>/gs, (match) => {
      let offerStr = null;
      const brokenMatch = match.match(/offer=["']?(\{.*?\})["']?(?:\s+[a-zA-Z0-9\-]+=|>)/);
      if (brokenMatch) {
        offerStr = brokenMatch[1];
      } else {
        const normalMatch = match.match(/offer='([^']*)'/) || match.match(/offer="([^"]*)"/);
        if (normalMatch) offerStr = normalMatch[1];
      }
      
      let fileName = window.i18n?.t('common.file') || 'file';
      let fileSize = '';
      let transferId = null;
      let storedFileName = '';
      let mimeType = '';
      let fileSizeBytes = null;
      if (offerStr) {
        try {
          const offer = JSON.parse(offerStr.replace(/&quot;/g, '"'));
          fileName = offer.filename || (window.i18n?.t('common.file') || 'file');
          transferId = offer.id || null;
          storedFileName = offer.storedFileName || offer.filename || '';
          mimeType = offer.mimeType || '';
          fileSizeBytes = typeof offer.size === 'number' ? offer.size : null;

          if (fileName && transferId && fileName.includes(transferId)) {
            const lastDashIndex = fileName.lastIndexOf('-');
            if (lastDashIndex > 0) {
              const originalFileName = fileName.substring(lastDashIndex + 1);
              if (originalFileName) {
                this.context.logger.info?.(`[UIRenderer] extract original filename from stored filename: ${fileName} -> ${originalFileName}`);
                fileName = originalFileName;
              }
            }
          }

          if (offer.size) {
            const size = offer.size;
            if (size < 1024) {
              fileSize = `${size} B`;
            } else if (size < 1024 * 1024) {
              fileSize = `${(size / 1024).toFixed(1)} KB`;
            } else {
              fileSize = `${(size / (1024 * 1024)).toFixed(1)} MB`;
            }
          }
        } catch (e) {
        }
      }
      const isSenderFlag = /is-sender/.test(match);
      const attrParts = [];
      if (transferId) attrParts.push(`id="file-request-${transferId}"`);
      if (storedFileName) attrParts.push(`data-stored-filename="${storedFileName}"`);
      if (mimeType) attrParts.push(`data-mime-type="${mimeType}"`);
      if (Number.isFinite(fileSizeBytes)) attrParts.push(`data-file-size="${fileSizeBytes}"`);
      attrParts.push(`data-is-sender="${isSenderFlag}"`);
      const attrs = attrParts.length ? ' ' + attrParts.join(' ') : '';
      const fileIcon = getFileIcon(mimeType);
      return `<div class="file-request transfer-completed"${attrs}><div class="file-info"><span class="file-icon">${fileIcon}</span><div class="file-details"><div class="file-name" title="${fileName}">${fileName}</div><div class="file-meta"><span class="file-size">${fileSize}</span></div></div></div></div>`;
    });

    finalMsg = finalMsg.replace(/<video-file-display[^>]*>.*?<\/video-file-display>/gs, (match) => {
      let offerStr = null;
      const brokenMatch = match.match(/offer=["']?(\{.*?\})["']?(?:\s+[a-zA-Z0-9\-]+=|>)/);
      if (brokenMatch) {
        offerStr = brokenMatch[1];
      } else {
        const normalMatch = match.match(/offer='([^']*)'/) || match.match(/offer="([^"]*)"/);
        if (normalMatch) offerStr = normalMatch[1];
      }

      let fileName = window.i18n?.t('common.video') || 'video';
      let storedFileName = '';
      let transferId = null;
      let isSenderFlag = false;

      if (offerStr) {
        try {
          const offer = JSON.parse(offerStr.replace(/&quot;/g, '"'));
          fileName = offer.filename || (window.i18n?.t('common.video') || 'video');
          storedFileName = offer.storedFileName || offer.filename || '';
          transferId = offer.id || null;
        } catch (e) {
          console.error('[UIRenderer] parse video-file-display offer failed:', e);
        }
      }

      isSenderFlag = /is-sender/.test(match);

      const currentPort = this.context.httpServerPort || 8080;
      const folder = isSenderFlag ? 'sends' : 'recvs';
      const videoFileName = storedFileName || fileName;
      const encodedFileName = encodeURIComponent(videoFileName);
      const videoUrl = `http://127.0.0.1:${currentPort}/${folder}/${encodedFileName}`;

      const containerId = transferId ? `id="file-request-${transferId}"` : '';
      const storedFileAttr = storedFileName ? `data-stored-filename="${storedFileName}"` : '';
      const isSenderAttr = `data-is-sender="${isSenderFlag}"`;

      return `<div class="streaming-video-message file-request transfer-completed" ${containerId} ${storedFileAttr} ${isSenderAttr}>
        <div class="video-container" ${transferId ? `id="video-container-${transferId}"` : ''}>
          <video
            controls
            preload="metadata"
            style="max-width: 100%; width: 400px; border-radius: 8px; background: #000;"
            poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='225' viewBox='0 0 400 225'%3E%3Crect fill='%23333' width='400' height='225'/%3E%3Ctext fill='%23666' font-family='sans-serif' font-size='20' dy='10.5' font-weight='bold' x='50%25' y='50%25' text-anchor='middle'%3E${encodeURIComponent(window.i18n?.t('chat.videoLoading') || 'Video loading...')}%3C/text%3E%3C/svg%3E"
          >
            <source src="${videoUrl}" type="video/mp4">
            <p>${window.i18n?.t('chat.videoNotSupported') || 'Your browser does not support video playback'}</p>
          </video>
          <div class="video-overlay">
            <span class="stream-status playable">${window.i18n?.t('chat.canPlay') || 'Can play'}</span>
            <span class="file-name" title="${fileName}">${fileName}</span>
          </div>
          <div class="stream-progress-container">
            <div class="stream-progress" style="width: 100%"></div>
          </div>
        </div>
      </div>`;
    });

    finalMsg = finalMsg.replace(/<audio-file-display[^>]*>.*?<\/audio-file-display>/gs, (match) => {
      let offerStr = null;
      const brokenMatch = match.match(/offer=["']?(\{.*?\})["']?(?:\s+[a-zA-Z0-9\-]+=|>)/);
      if (brokenMatch) {
        offerStr = brokenMatch[1];
      } else {
        const normalMatch = match.match(/offer='([^']*)'/) || match.match(/offer="([^"]*)"/);
        if (normalMatch) offerStr = normalMatch[1];
      }

      let fileName = window.i18n?.t('common.audio') || 'audio';
      let storedFileName = '';
      let transferId = null;
      let isSenderFlag = false;
      let fileSize = '';
      let mimeType = 'audio/mpeg';

      if (offerStr) {
        try {
          const offer = JSON.parse(offerStr.replace(/&quot;/g, '"'));
          fileName = offer.filename || (window.i18n?.t('common.audio') || 'audio');
          storedFileName = offer.storedFileName || offer.filename || '';
          transferId = offer.id || null;
          mimeType = offer.mimeType || 'audio/mpeg';
          if (offer.size) {
            const size = offer.size;
            if (size < 1024) {
              fileSize = `${size} B`;
            } else if (size < 1024 * 1024) {
              fileSize = `${(size / 1024).toFixed(1)} KB`;
            } else {
              fileSize = `${(size / (1024 * 1024)).toFixed(1)} MB`;
            }
          }
        } catch (e) {
          console.error('[UIRenderer] parse audio-file-display offer failed:', e);
        }
      }

      isSenderFlag = /is-sender/.test(match);

      const currentPort = this.context.httpServerPort || 8080;
      const folder = isSenderFlag ? 'sends' : 'recvs';
      const audioFileName = storedFileName || fileName;
      const encodedFileName = encodeURIComponent(audioFileName);
      const audioUrl = `http://127.0.0.1:${currentPort}/${folder}/${encodedFileName}`;

      let audioMimeType = mimeType;
      if (fileName.toLowerCase().endsWith('.mp3') && !mimeType) {
        audioMimeType = 'audio/mpeg';
      } else if (fileName.toLowerCase().endsWith('.ogg') && !mimeType) {
        audioMimeType = 'audio/ogg';
      }

      const containerId = transferId ? `id="file-request-${transferId}"` : '';
      const storedFileAttr = storedFileName ? `data-stored-filename="${storedFileName}"` : '';
      const isSenderAttr = `data-is-sender="${isSenderFlag}"`;

      return `<div class="audio-message file-request transfer-completed" ${containerId} ${storedFileAttr} ${isSenderAttr}>
        <div class="audio-container">
          <div class="audio-info">
            <span class="file-icon">🎵</span>
            <div class="file-details">
              <div class="file-name" title="${fileName}">${fileName}</div>
              <div class="file-meta">
                <span class="file-size">${fileSize}</span>
                <span class="file-status">${window.i18n?.t('chat.received') || 'Receive completed'}</span>
              </div>
            </div>
          </div>
          <div class="audio-player-container">
            <audio
              controls
              preload="metadata"
              style="width: 100%; height: 40px; border-radius: 20px;"
            >
              <source src="${audioUrl}" type="${audioMimeType}">
              <p>${window.i18n?.t('chat.audioNotSupported') || 'Your browser does not support audio playback'}</p>
            </audio>
          </div>
        </div>
      </div>`;
    });

    msgText.innerHTML = `${finalMsg}`;
    msgContainer.title = formattedTime;

    // Email message: detect 📧 prefix or email-image-message class
    const isEmailMsg = finalMsg.trimStart().startsWith('📧') || 
                       finalMsg.includes('email-image-message') ||
                       finalMsg.includes('email-subject-line');
    const hasImageMessage = finalMsg.includes('image-message') || finalMsg.includes('file-request');
    const hasEmailImageMessage = finalMsg.includes('email-image-message');
    
    if (isEmailMsg) {
      const isAlreadyRead = isRead === 1;
      
      if (hasEmailImageMessage) {
        // New email image message structure: outer email-image-message container
        const emailImageMessage = msgText.querySelector('.email-image-message');
        console.log('[UIRenderer] processemailimage message:', { hasEmailImageMessage, emailImageMessage: !!emailImageMessage, emid, isRead, isAlreadyRead });
        if (emailImageMessage) {
          // Prefer passed emid parameter; get from dataset if not provided
          const emailEmid = emid || emailImageMessage.dataset.emid;
          console.log('[UIRenderer] emailimage message emid:', emailEmid, 'dataset.emid:', emailImageMessage.dataset.emid);
          
          // Subject line style settings
          const emailSubjectLine = emailImageMessage.querySelector('.email-subject-line');
          
          if (emailSubjectLine) {
            emailSubjectLine.style.color = isAlreadyRead ? '#333' : '#1890ff';
            emailSubjectLine.classList.add(isAlreadyRead ? 'email-msg-read' : 'email-msg-unread');
          }
          
          // Bind click event to entire container (open email details)
          if (emailEmid) {
            emailImageMessage.dataset.emid = emailEmid;
            console.log('[UIRenderer] bindemailimage messageclickevent, emid:', emailEmid);
            emailImageMessage.addEventListener('click', (e) => {
              // If image is clicked, do not trigger email details (image has its own click event)
              // Use closest to check if click target is an image or inside an image
              const clickedImg = e.target.closest('img');
              const isImageClick = clickedImg || e.target.tagName === 'IMG';
              if (isImageClick) {
                console.log('[UIRenderer] emailimage messageclickevent by ignore(clickimage)');
                return;
              }
              console.log('[UIRenderer] email image message click event triggered, emid:', emailEmid, 'target:', e.target.tagName, 'class:', e.target.className);
              e.stopPropagation();

              // Blue turns black after click
              if (emailSubjectLine) {
                emailSubjectLine.style.color = '#333';
                emailSubjectLine.classList.remove('email-msg-unread');
                emailSubjectLine.classList.add('email-msg-read');
              }

              // Update database is_read
              this._markEmailMessageRead(emailEmid);
              this.openEmailDetail(emailEmid);
            });

            // [New] Listen for image load completion event to auto-mark email as read
            // Only trigger when message is currently unread
            if (!isAlreadyRead) {
              const emailImage = emailImageMessage.querySelector('img');
              if (emailImage) {
                console.log('[UIRenderer] bindemail imageLoad completedevent, emid:', emailEmid);
                
                // Use one-time event listener to auto-mark as read after image loads
                const onImageLoad = () => {
                  console.log('[UIRenderer] email imageLoad completed, auto mark as read, emid:', emailEmid);
                  
                  // Update UI style (blue turns black)
                  if (emailSubjectLine) {
                    emailSubjectLine.style.color = '#333';
                    emailSubjectLine.classList.remove('email-msg-unread');
                    emailSubjectLine.classList.add('email-msg-read');
                  }
                  
                  // Update database is_read (message and recv tables) and sync IMAP server
                  this._markEmailMessageRead(emailEmid);
                };
                
                // Check if image has finished loading
                if (emailImage.complete && emailImage.naturalWidth > 0) {
                  // Image has already loaded, trigger directly
                  console.log('[UIRenderer] email imagealreadyLoad completed, mark as read immediately, emid:', emailEmid);
                  onImageLoad();
                } else {
                  // Image has not finished loading, bind load event
                  emailImage.addEventListener('load', onImageLoad, { once: true });
                  // Also bind error event; mark as read even if loading fails (user has seen placeholder)
                  emailImage.addEventListener('error', () => {
                    console.log('[UIRenderer] emailimage load failed, still mark as read, emid:', emailEmid);
                    onImageLoad();
                  }, { once: true });
                }
              }
            }
          } else {
            console.warn('[UIRenderer] email image message has no emid, unable to bind click event');
          }
        }
      } else {
        // Plain text email message: apply email style overall
        msgText.style.color = isAlreadyRead ? '#333' : '#1890ff';
        msgText.style.border = '1px solid #ccc';
        msgText.style.borderRadius = '4px';
        msgText.style.padding = '2px 6px';
        msgText.style.cursor = 'pointer';
        if (emid) {
          msgText.dataset.emid = emid;
          msgText.classList.add(isAlreadyRead ? 'email-msg-read' : 'email-msg-unread');
          msgText.addEventListener('click', () => {
            // Blue turns black after click
            msgText.style.color = '#333';
            msgText.classList.remove('email-msg-unread');
            msgText.classList.add('email-msg-read');
            // Update database is_read
            this._markEmailMessageRead(emid);
            this.openEmailDetail(emid);
          });
        }
      }
    }

    msgContent.appendChild(msgText);

    const isFileOrImage = finalMsg.includes('file-request') || finalMsg.includes('image-message') || finalMsg.includes('streaming-video-message') || finalMsg.includes('audio-message');

    if (id && status < 100 && !isFileOrImage) {
      const statusSpan = document.createElement('span');
      statusSpan.id = 'msg-status-' + id;
      statusSpan.className = 'message-status';
      statusSpan.textContent = sender === 'Me' ? ' (' + (window.i18n?.t('chat.sending') || 'Sending...') + ')' : ' (' + (window.i18n?.t('chat.receiving') || 'Receiving...') + ')';
      msgContent.appendChild(statusSpan);
    }

    if (this.context.fileTransferManager && this.context.fileTransferManager.uiManager) {
      this.context.fileTransferManager.uiManager.rebindFileTransferEvents(msgText);
    }

    if (sender === 'Me') {
      msgContainer.appendChild(msgContent);
      msgContainer.appendChild(avatarDiv);
    } else {
      msgContainer.appendChild(avatarDiv);
      msgContainer.appendChild(msgContent);
    }

    this.chatDisplay.appendChild(msgContainer);
    this.chatDisplay.scrollTop = this.chatDisplay.scrollHeight;
  }

  /**
   * Display a message (HTMLElement version)
   * Used to display Web Components directly
   * @public
   */
  displayMessageElement(sender, element, id = null, timestamp = null, senderEmail = null, status = 100) {
    let formattedTime = '';
    try {
      let msTimestamp;
      if (this.context.utils && this.context.utils.convertToMilliseconds) {
        msTimestamp = this.context.utils.convertToMilliseconds(timestamp);
      } else if (typeof timestamp === 'string' && timestamp.length > 15) {
        msTimestamp = Number(BigInt(timestamp) / BigInt(1000000));
      } else {
        msTimestamp = timestamp ? new Date(timestamp).getTime() : Date.now();
      }

      const date = isNaN(msTimestamp) ? new Date() : new Date(msTimestamp);
      const day = date.getDate().toString().padStart(2, '0');
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const seconds = date.getSeconds().toString().padStart(2, '0');
      const daySuffix2 = window.i18n?.t('common.daySuffix') || 'd';
      formattedTime = `${day}${daySuffix2} ${hours}:${minutes}:${seconds}`;
    } catch (e) {
      console.error('Format time failed:', e);
      formattedTime = new Date().toLocaleString(window.i18n?.getLocale?.() || 'zh-CN');
    }

    if (id) {
      if (this.context.displayedMessageIds.has(id)) {
        return;
      }
      this.context.displayedMessageIds.add(id);
    }

    const msgContainer = document.createElement('div');
    msgContainer.className = 'message-container';
    if (id) {
      msgContainer.id = 'msg-container-' + id;
    }

    if (sender === 'Me') {
      msgContainer.classList.add('message-sent');
    } else {
      msgContainer.classList.add('message-received');
    }

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar avatar';
    avatarDiv.dataset.email = String(senderEmail || (sender === 'Me' ? this.context.myEmail : this.context.targetEmail) || '').trim().toLowerCase();

    // Async avatar loading
    if (this.context.avatarManager && this.context.avatarManager.getAvatar) {
      const email = avatarDiv.dataset.email;
      this.context.avatarManager.getAvatar(email).then(avatar => {
        const html = this.context.avatarManager.buildAvatarHtml
          ? this.context.avatarManager.buildAvatarHtml(avatar)
          : '';
        if (html) {
          avatarDiv.innerHTML = html;
        } else {
          avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
        }
      }).catch(e => {
        console.error('Load avatar failed:', e);
        avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
      });
    } else {
      avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
    }

    const msgContent = document.createElement('div');
    msgContent.className = 'message-content';

    msgContent.appendChild(element);

    const isFileComponent = element.tagName === 'NORMAL-FILE-DISPLAY' ||
                           element.tagName === 'IMAGE-FILE-DISPLAY' ||
                           element.tagName === 'VIDEO-FILE-DISPLAY' ||
                           element.tagName === 'AUDIO-FILE-DISPLAY' ||
                           element.classList?.contains('file-request');

    if (id && status < 100 && !isFileComponent) {
      const statusSpan = document.createElement('span');
      statusSpan.id = 'msg-status-' + id;
      statusSpan.className = 'message-status';
      statusSpan.textContent = sender === 'Me' ? ' (' + (window.i18n?.t('chat.sending') || 'Sending...') + ')' : ' (' + (window.i18n?.t('chat.receiving') || 'Receiving...') + ')';
      msgContent.appendChild(statusSpan);
    }

    // Rebind event listeners for file transfer buttons (for Web Component)
    // Execute with a delay to ensure the Web Component has fully rendered
    if (this.context.fileTransferManager && this.context.fileTransferManager.uiManager) {
      const bindEvents = () => {
        this.context.fileTransferManager.uiManager.rebindFileTransferEvents(element);
      };
      
      // Check whether it is a Web Component
      const isWebComponent = element.tagName === 'NORMAL-FILE-DISPLAY' || 
                            element.tagName === 'IMAGE-FILE-DISPLAY' || 
                            element.tagName === 'VIDEO-FILE-DISPLAY';
      
      if (isWebComponent) {
        // For Web Components, wait for shadowRoot rendering to complete
        setTimeout(bindEvents, 100);
      } else {
        // For plain HTML, bind immediately
        bindEvents();
      }
    }

    msgContainer.title = formattedTime;

    if (sender === 'Me') {
      msgContainer.appendChild(msgContent);
      msgContainer.appendChild(avatarDiv);
    } else {
      msgContainer.appendChild(avatarDiv);
      msgContainer.appendChild(msgContent);
    }

    this.chatDisplay.appendChild(msgContainer);
    this.chatDisplay.scrollTop = this.chatDisplay.scrollHeight;
  }

  async markMessageAsConfirmed(id) {
    // [FIX] Add retry mechanism to ensure message container exists before updating status
    const maxRetries = 10;
    const retryDelay = 300;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const statusSpan =
        this.shadowRoot.getElementById('msg-status-' + id) ||
        this.shadowRoot.querySelector(`#msg-container-${id} .message-status`) ||
        this.shadowRoot.querySelector(`#status-${id}.message-status`);
      
      const container = this.shadowRoot.getElementById('msg-container-' + id);
      
      if (statusSpan || container) {
        // Find the element and perform the update
        if (statusSpan) {
          // [FIX] If the message has already been marked as "transfer incomplete", do not overwrite it as "recipient received"
          // File transfer interruption takes priority over message-level ACK confirmation
          if (statusSpan.dataset.transferIncomplete === 'true') {
            return;
          }
          statusSpan.textContent = ' (' + (window.i18n?.t('chat.peerReceived') || 'Peer received') + ')';
          statusSpan.style.color = 'green';
        }

        if (container) {
          const images = container.querySelectorAll('.sending-image, img[class*="sending-image"]');
          images.forEach(img => {
            img.classList.remove('sending-image');
            img.style.opacity = '1';
            // Do not overwrite the original title; only update when the title is "sending"
            const currentTitle = img.getAttribute('title');
            const sendingTitle = window.i18n?.t('chat.sending') || 'Sending';
            const viewOriginalTitle = window.i18n?.t('chat.viewOriginal') || 'view original';
            if (currentTitle === sendingTitle || !currentTitle) {
              img.title = viewOriginalTitle;
            }
          });
          
          // [FIX] Message confirmed received; synchronously mark file transfer as complete
          this._markFileTransferCompleteIfExists(id, container);
        }
        
        return; // Update succeeded, return directly
      }
      
      // Element not found, wait and retry
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    // Still not found after retries, log it
    console.warn(`[UIRenderer] markMessageAsConfirmed: message container does not exist, unable toupdatestatus: ${id}`);
  }

  /**
   * If the message contains a file transfer, mark the transfer as complete
   * When the message status is "recipient received", the file transfer must be complete
   *
   * [Note] If the file is already shown as "transfer interrupted", do not mark it as complete,
   * to preserve the resumable transfer progress information
   *
   * @private
   * @param {string} msgId - Message ID
   * @param {HTMLElement} container - Message container element
   */
  _markFileTransferCompleteIfExists(msgId, container) {
    // Check the Web Components file display component
    const fileComponents = container.querySelectorAll('normal-file-display, image-file-display, video-file-display, audio-file-display');
    fileComponents.forEach(component => {
      const innerId = component.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
      if (innerId) {
        const transferId = innerId.replace('file-request-', '');
        
        // [FIX] Check if already shown as transfer-interrupted state, skip if so
        const statusText = component.shadowRoot?.querySelector('.file-status');
        if (statusText && statusText.textContent?.includes(window.i18n?.t('chat.transferInterrupted') || 'Transfer interrupted')) {
          return; // Keep the transfer-interrupted state, do not mark as complete
        }
        
        // Call the component's markTransferComplete method
        if (component.markTransferComplete) {
          component.markTransferComplete();
        }
        // Synchronize to FileTransferUIManager to prevent subsequent status updates from overwriting
        if (this.context.fileTransferManager?.uiManager) {
          this.context.fileTransferManager.uiManager.markTransferComplete(transferId);
        }
      }
    });
    
    // Check legacy HTML file request elements
    const fileRequest = container.querySelector('.file-request[id^="file-request-"]');
    if (fileRequest) {
      // [FIX] Check if already shown as transfer-interrupted state, skip if so
      const statusText = fileRequest.querySelector('.file-status');
      if (statusText && statusText.textContent?.includes(window.i18n?.t('chat.transferInterrupted') || 'Transfer interrupted')) {
        return; // Keep the transfer-interrupted state, do not mark as complete
      }
      
      const transferId = fileRequest.id.replace('file-request-', '');
      fileRequest.classList.add('transfer-completed');
      if (this.context.fileTransferManager?.uiManager) {
        this.context.fileTransferManager.uiManager.markTransferComplete(transferId);
      }
    }
  }

  /**
   * Mark the message as "sent (email)" status
   * Used for text messages successfully sent via email when WebRTC is not connected
   * Different from markMessageAsConfirmed (recipient received):
   * - markMessageAsSentViaEmail: email has been sent, but the recipient may not have received it yet
   * - markMessageAsConfirmed: recipient confirmed receipt (via WebRTC or status synchronization)
   */
  async markMessageAsSentViaEmail(id) {
    // [FIX] Add retry mechanism to ensure message container exists before updating status
    const maxRetries = 10;
    const retryDelay = 300;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const statusSpan =
        this.shadowRoot.getElementById('msg-status-' + id) ||
        this.shadowRoot.querySelector(`#msg-container-${id} .message-status`) ||
        this.shadowRoot.querySelector(`#status-${id}.message-status`);
      
      const container = this.shadowRoot.getElementById('msg-container-' + id);
      
      if (statusSpan || container) {
        // Find the element and perform the update
        if (statusSpan) {
          // [FIX] If the message has already been marked as "transfer incomplete", do not overwrite
          if (statusSpan.dataset.transferIncomplete === 'true') {
            return;
          }
          // If it has already been marked as "recipient received" by markMessageAsConfirmed, do not downgrade to "sent"
          if (statusSpan.textContent.includes(window.i18n?.t('chat.peerReceived') || 'Peer received')) {
            return;
          }
          statusSpan.textContent = ' (' + (window.i18n?.t('chat.sent') || 'Sent') + ')';
          statusSpan.style.color = '#4CAF50'; // Green but slightly lighter than confirmed
        }

        if (container) {
          const images = container.querySelectorAll('.sending-image, img[class*="sending-image"]');
          images.forEach(img => {
            img.classList.remove('sending-image');
            img.style.opacity = '1';
            const currentTitle = img.getAttribute('title');
            const sendingTitle2 = window.i18n?.t('chat.sending') || 'Sending';
            const viewOriginalTitle2 = window.i18n?.t('chat.viewOriginal') || 'view original';
            if (currentTitle === sendingTitle2 || !currentTitle) {
              img.title = viewOriginalTitle2;
            }
          });
        }
        
        return; // Update succeeded, return directly
      }
      
      // Element not found, wait and retry
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    // Still not found after retries, log it
    console.warn(`[UIRenderer] markMessageAsSentViaEmail: message container does not exist, unable toupdatestatus: ${id}`);
  }

  markMessageAsSending(id) {
    const statusSpan =
      this.shadowRoot.getElementById('msg-status-' + id) ||
      this.shadowRoot.querySelector(`#msg-container-${id} .message-status`) ||
      this.shadowRoot.querySelector(`#status-${id}.message-status`);
    if (statusSpan) {
      // [FIX] If it is a file transfer and already showing complete or interrupted, do not overwrite the status
      const container = this.shadowRoot.getElementById('msg-container-' + id);
      const isFile = container?.querySelector('.file-request, normal-file-display, image-file-display, video-file-display, audio-file-display');
      
      if (isFile) {
        // For file messages, status is usually managed internally by the component; externally do not display "(sending...)"
        statusSpan.textContent = '';
        return;
      }
      
      statusSpan.textContent = ' (' + (window.i18n?.t('chat.sending') || 'Sending...') + ')';
      statusSpan.style.color = 'gray';
    }
  }

  clearChatDisplay() {
    this.chatDisplay.innerHTML = '';
    this.context.displayedMessageIds.clear();
    this._resetNatDisplayState();
  }

  showLoadingIndicator(show, message = window.i18n?.t('common.loading') || 'Loading...') {
    let loadingEl = this.shadowRoot.getElementById('history-loading-indicator');
    
    if (show) {
      if (!loadingEl) {
        loadingEl = document.createElement('div');
        loadingEl.id = 'history-loading-indicator';
        loadingEl.style.cssText = `
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: rgba(0, 0, 0, 0.7);
          color: white;
          padding: 12px 24px;
          border-radius: 8px;
          font-size: 14px;
          z-index: 1000;
          display: flex;
          align-items: center;
          gap: 8px;
        `;
        this.chatDisplay.style.position = 'relative';
        this.chatDisplay.appendChild(loadingEl);
      }
      
      loadingEl.innerHTML = `
        <span class="loading-spinner" style="
          width: 16px;
          height: 16px;
          border: 2px solid #ffffff40;
          border-top-color: #ffffff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        "></span>
        <span>${message}</span>
      `;
      loadingEl.style.display = 'flex';
    } else {
      if (loadingEl) {
        loadingEl.style.display = 'none';
        loadingEl.remove();
      }
    }
  }

  _initEmojiPickerComponent() {
    const emojiPickerBtn = this.shadowRoot.getElementById('emojiPickerBtn');
    if (!emojiPickerBtn) return;

    // Listen for emoji selection events
    emojiPickerBtn.addEventListener('emoji-select', (e) => {
      const { emoji } = e.detail;
      this._insertEmoji(emoji);
    });
  }

  _insertEmoji(emoji) {
    if (!this.msgInput) return;
    const start = this.msgInput.selectionStart;
    const end = this.msgInput.selectionEnd;
    const value = this.msgInput.value;
    this.msgInput.value = value.substring(0, start) + emoji + value.substring(end);
    this.msgInput.selectionStart = this.msgInput.selectionEnd = start + emoji.length;
    this.msgInput.focus();
  }

  _initMsgInputContextMenu() {
    const contextMenu = this.shadowRoot.getElementById('msgInputContextMenu');
    if (!contextMenu || !this.msgInput) {
      console.log('[UIRenderer] Context menu or msgInput not found');
      return;
    }

    this.msgInput.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._showContextMenu(e.clientX, e.clientY);
    });

    contextMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.context-menu-item');
      if (!item) return;

      const action = item.dataset.action;
      if (action === 'clear') {
        this._clearMsgInput();
      } else if (action === 'paste') {
        this._handlePaste();
      } else if (action === 'clearChatHistory') {
        this._clearChatHistory();
      }
      this._hideContextMenu();
    });

    this.shadowRoot.addEventListener('click', (e) => {
      if (!contextMenu.contains(e.target)) {
        this._hideContextMenu();
      }
    });

    this.msgInput.addEventListener('blur', () => {
      setTimeout(() => {
        const activeElement = this.shadowRoot.activeElement;
        if (!contextMenu.contains(activeElement)) {
          this._hideContextMenu();
        }
      }, 200);
    });
  }

  _showContextMenu(x, y) {
    const contextMenu = this.shadowRoot.getElementById('msgInputContextMenu');
    if (!contextMenu) return;

    contextMenu.style.display = 'block';
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    const menuRect = contextMenu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (menuRect.right > viewportWidth) {
      contextMenu.style.left = `${x - menuRect.width}px`;
    }
    if (menuRect.bottom > viewportHeight) {
      contextMenu.style.top = `${y - menuRect.height}px`;
    }
  }

  _hideContextMenu() {
    const contextMenu = this.shadowRoot.getElementById('msgInputContextMenu');
    if (contextMenu) {
      contextMenu.style.display = 'none';
    }
  }

  _clearMsgInput() {
    if (this.msgInput) {
      this.msgInput.value = '';
      this.msgInput.focus();
    }
    if (this.context.fileTransferManager && this.context.fileTransferManager.stagedFile) {
      this.context.fileTransferManager.stagedFile = null;
      const fileInfo = this.shadowRoot.getElementById('fileInfo');
      if (fileInfo) {
        fileInfo.innerHTML = '';
      }
    }
  }

  async _clearChatHistory() {
    const myEmail = this.context.myEmail;
    const targetEmail = this.context.targetEmail;

    if (!myEmail || !targetEmail) {
      console.warn('[UIRenderer] unable to clear chat history: missing email info');
      return;
    }

    if (!window.electronAPI || !window.electronAPI.clearChatHistory) {
      console.warn('[UIRenderer] clearChatHistory API unavailable');
      return;
    }

    try {
      const result = await window.electronAPI.clearChatHistory({
        myEmail,
        targetEmail
      });

      if (result.success) {
        this.clearChatDisplay();
        console.log(`[UIRenderer] cleared chat history with ${targetEmail}, deleted ${result.deleted} messages`);
      } else {
        console.error('[UIRenderer] failed to clear chat history:', result.error);
      }
    } catch (error) {
      console.error('[UIRenderer] error clearing chat history:', error);
    }
  }

  async _handlePaste() {
    // Prefer Electron's clipboard API (supports files)
    if (window.electronAPI && window.electronAPI.clipboardReadFiles) {
      try {
        const result = await window.electronAPI.clipboardReadFiles();
        if (result.success) {
          await this._handleElectronClipboardResult(result);
          return;
        }
      } catch (err) {
        console.error('[UIRenderer] Electron clipboard read failed:', err);
      }
    }

    // Fall back to the Web Clipboard API
    await this._handleWebClipboardPaste();
  }

  async _handleElectronClipboardResult(result) {
    // Handle the file list
    if (result.files && result.files.length > 0) {
      for (const fileInfo of result.files) {
        // Create a File object from the file path
        try {
          const response = await fetch(`file://${fileInfo.path}`);
          const blob = await response.blob();
          const file = new File([blob], fileInfo.name, { 
            type: blob.type || 'application/octet-stream',
            lastModified: Date.now()
          });
          // Preserve path information
          file.path = fileInfo.path;
          
          if (this.context.fileTransferManager && this.context.fileTransferManager.sender) {
            await this.context.fileTransferManager.sender.handlePasteFile(file);
          }
        } catch (err) {
          console.error('[UIRenderer] readfilefailed:', err);
        }
      }
      return;
    }

    // Handle image data
    if (result.image) {
      const byteCharacters = atob(result.image.data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: result.image.type });
      const file = new File([blob], result.image.name, { type: result.image.type });
      
      if (this.context.fileTransferManager && this.context.fileTransferManager.sender) {
        await this.context.fileTransferManager.sender.handlePasteFile(file);
      }
      return;
    }

    // Handle text
    if (result.text && this.msgInput) {
      const start = this.msgInput.selectionStart;
      const end = this.msgInput.selectionEnd;
      const value = this.msgInput.value;
      this.msgInput.value = value.substring(0, start) + result.text + value.substring(end);
      this.msgInput.selectionStart = this.msgInput.selectionEnd = start + result.text.length;
      this.msgInput.focus();
    }
  }

  async _handleWebClipboardPaste() {
    try {
      const clipboardItems = await navigator.clipboard.read();
      let handled = false;

      for (const item of clipboardItems) {
        // Handle image type
        if (item.types.includes('image/png') || item.types.includes('image/jpeg') || item.types.includes('image/gif')) {
          const imageType = item.types.find(t => t.startsWith('image/'));
          const blob = await item.getType(imageType);
          const file = new File([blob], `pasted-image-${Date.now()}.png`, { type: imageType });
          
          if (this.context.fileTransferManager && this.context.fileTransferManager.sender) {
            await this.context.fileTransferManager.sender.handlePasteFile(file);
            handled = true;
          }
          break;
        }

        // Handle text type
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();
          if (this.msgInput) {
            const start = this.msgInput.selectionStart;
            const end = this.msgInput.selectionEnd;
            const value = this.msgInput.value;
            this.msgInput.value = value.substring(0, start) + text + value.substring(end);
            this.msgInput.selectionStart = this.msgInput.selectionEnd = start + text.length;
            this.msgInput.focus();
            handled = true;
          }
          break;
        }
      }

      if (!handled) {
        const text = await navigator.clipboard.readText();
        if (text && this.msgInput) {
          const start = this.msgInput.selectionStart;
          const end = this.msgInput.selectionEnd;
          const value = this.msgInput.value;
          this.msgInput.value = value.substring(0, start) + text + value.substring(end);
          this.msgInput.selectionStart = this.msgInput.selectionEnd = start + text.length;
          this.msgInput.focus();
        }
      }
    } catch (err) {
      console.error('[UIRenderer] Web Clipboard API paste failed:', err);
      this.msgInput.focus();
      document.execCommand('paste');
    }
  }

  initMessageFormatterWorker() {
    if (this.messageFormatterWorker) {
      return;
    }

    try {
      const currentPath = import.meta.url;
      const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
      const workerPath = new URL('./file-transfer/message-formatter.worker.js', basePath).href;
      
      this.messageFormatterWorker = new Worker(workerPath, { type: 'module' });

      this.messageFormatterWorker.onmessage = (event) => {
        this.handleWorkerResponse(event.data);
      };

      this.messageFormatterWorker.onerror = (error) => {
        console.error('[UIRenderer] Message formatter worker error:', error);
        this.messageFormatterWorker = null;
      };

      console.log('[UIRenderer] Message formatter worker initialized');
    } catch (error) {
      console.error('[UIRenderer] Failed to initialize message formatter worker:', error);
      this.messageFormatterWorker = null;
    }
  }

  handleWorkerResponse(response) {
    console.log('[UIRenderer] Worker response received:', response);
    
    if (!response || !response.id) {
      console.error('[UIRenderer] Invalid worker response:', response);
      return;
    }

    this.pendingMessages.set(response.id, response);
    console.log('[UIRenderer] Message stored in pendingMessages, id:', response.id);
    this.processQueue();
  }

  async processQueue() {
    console.log('[UIRenderer] Processing queue, queue length:', this.renderQueue.length, 'pending messages:', this.pendingMessages.size);
    
    if (this.isProcessingQueue) {
      console.log('[UIRenderer] Queue already being processed, skipping');
      return;
    }

    this.isProcessingQueue = true;

    while (this.renderQueue.length > 0) {
      const item = this.renderQueue[0];
      console.log('[UIRenderer] Processing queue item, sequence:', item.sequence);
      
      const formatted = this.pendingMessages.get(item.sequence);

      if (!formatted) {
        console.log('[UIRenderer] No formatted message found for sequence:', item.sequence, 'waiting...');
        break;
      }

      console.log('[UIRenderer] Found formatted message, rendering to DOM');
      this.renderQueue.shift();
      this.pendingMessages.delete(item.sequence);

      this.renderMessageToDOM(
        item.sender,
        formatted.formattedMsg,
        item.id,
        formatted.formattedTime,
        item.senderEmail,
        item.status,
        formatted.hasFileOrImage,
        item.emid || '',
        item.isRead || 0
      );
    }

    this.isProcessingQueue = false;
    console.log('[UIRenderer] Queue processing completed');
  }

  renderMessageToDOM(sender, formattedMsg, id, formattedTime, senderEmail, status, hasFileOrImage, emid = '', isRead = 0) {
    if (id && this.context.displayedMessageIds.has(id)) {
      return;
    }

    if (id) {
      this.context.displayedMessageIds.add(id);
    }

    const msgContainer = document.createElement('div');
    msgContainer.className = 'message-container';
    if (id) {
      msgContainer.id = 'msg-container-' + id;
    }

    if (sender === 'Me') {
      msgContainer.classList.add('message-sent');
    } else {
      msgContainer.classList.add('message-received');
    }

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar avatar';
    avatarDiv.dataset.email = String(senderEmail || (sender === 'Me' ? this.context.myEmail : this.context.targetEmail) || '').trim().toLowerCase();

    if (this.context.avatarManager && this.context.avatarManager.getAvatar) {
      const email = avatarDiv.dataset.email;
      this.context.avatarManager.getAvatar(email).then(avatar => {
        const html = this.context.avatarManager.buildAvatarHtml
          ? this.context.avatarManager.buildAvatarHtml(avatar)
          : '';
        if (html) {
          avatarDiv.innerHTML = html;
        } else {
          avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
        }
      }).catch(e => {
        console.error('Load avatar failed:', e);
        avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
      });
    } else {
      avatarDiv.textContent = sender === 'Me' ? (window.i18n?.t('common.me') || 'Me') : (window.i18n?.t('common.peer') || 'Peer');
    }

    const msgContent = document.createElement('div');
    msgContent.className = 'message-content';

    const msgText = document.createElement('div');
    msgText.className = 'message-text';

    if (sender === 'Me' && status < 100) {
      if (formattedMsg.includes('<img')) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = formattedMsg;
        const images = tempDiv.querySelectorAll('img');
        images.forEach(img => {
          img.classList.add('sending-image');
          if (!img.hasAttribute('title') || !img.getAttribute('title')) {
            img.setAttribute('title', window.i18n?.t('chat.sending') || 'Sending');
          }
        });
        formattedMsg = tempDiv.innerHTML;
      }
    }

    msgText.innerHTML = `${formattedMsg}`;
    msgContainer.title = formattedTime;

    // Email message: detect 📧 prefix or email-image-message class
    const isEmailMsg = formattedMsg.trimStart().startsWith('📧') || 
                       formattedMsg.includes('email-image-message') ||
                       formattedMsg.includes('email-subject-line');
    const hasImageMessage = formattedMsg.includes('image-message') || formattedMsg.includes('file-request');
    const hasEmailImageMessage = formattedMsg.includes('email-image-message');
    
    if (isEmailMsg) {
      const isAlreadyRead = isRead === 1;
      
      if (hasEmailImageMessage) {
        // New email image message structure: outer email-image-message container
        const emailImageMessage = msgText.querySelector('.email-image-message');
        console.log('[UIRenderer] renderMessageToDOM processemailimage message:', { hasEmailImageMessage, emailImageMessage: !!emailImageMessage, emid, isRead, isAlreadyRead });
        if (emailImageMessage) {
          // Prefer passed emid parameter; get from dataset if not provided
          const emailEmid = emid || emailImageMessage.dataset.emid;
          console.log('[UIRenderer] renderMessageToDOM emailimage message emid:', emailEmid, 'dataset.emid:', emailImageMessage.dataset.emid);
          
          // Apply unified style settings for subject and file info lines
          const emailSubjectLine = emailImageMessage.querySelector('.email-subject-line');
          const emailFileInfoLine = emailImageMessage.querySelector('.email-file-info-line');
          
          if (emailSubjectLine) {
            emailSubjectLine.style.color = isAlreadyRead ? '#333' : '#1890ff';
            emailSubjectLine.classList.add(isAlreadyRead ? 'email-msg-read' : 'email-msg-unread');
          }
          
          if (emailFileInfoLine) {
            emailFileInfoLine.style.color = isAlreadyRead ? '#333' : '#1890ff';
            emailFileInfoLine.classList.add(isAlreadyRead ? 'email-msg-read' : 'email-msg-unread');
          }
          
          // Bind click event to entire container (open email details)
          if (emailEmid) {
            emailImageMessage.dataset.emid = emailEmid;
            console.log('[UIRenderer] renderMessageToDOM bindemailimage messageclickevent, emid:', emailEmid);
            emailImageMessage.addEventListener('click', (e) => {
              // If image is clicked, do not trigger email details (image has its own click event)
              // Use closest to check if click target is an image or inside an image
              const clickedImg = e.target.closest('img');
              const isImageClick = clickedImg || e.target.tagName === 'IMG';
              if (isImageClick) {
                console.log('[UIRenderer] emailimage messageclickevent by ignore(clickimage)');
                return;
              }
              console.log('[UIRenderer] email image message click event triggered, emid:', emailEmid, 'target:', e.target.tagName, 'class:', e.target.className);
              e.stopPropagation();

              // Blue turns black after click
              if (emailSubjectLine) {
                emailSubjectLine.style.color = '#333';
                emailSubjectLine.classList.remove('email-msg-unread');
                emailSubjectLine.classList.add('email-msg-read');
              }
              if (emailFileInfoLine) {
                emailFileInfoLine.style.color = '#333';
                emailFileInfoLine.classList.remove('email-msg-unread');
                emailFileInfoLine.classList.add('email-msg-read');
              }

              // Update database is_read
              this._markEmailMessageRead(emailEmid);
              this.openEmailDetail(emailEmid);
            });

            // [New] Listen for image load completion event to auto-mark email as read
            // Only trigger when message is currently unread
            if (!isAlreadyRead) {
              const emailImage = emailImageMessage.querySelector('img');
              if (emailImage) {
                console.log('[UIRenderer] bindemail imageLoad completedevent, emid:', emailEmid);
                
                // Use one-time event listener to auto-mark as read after image loads
                const onImageLoad = () => {
                  console.log('[UIRenderer] email imageLoad completed, auto mark as read, emid:', emailEmid);
                  
                  // Update UI style (blue turns black)
                  if (emailSubjectLine) {
                    emailSubjectLine.style.color = '#333';
                    emailSubjectLine.classList.remove('email-msg-unread');
                    emailSubjectLine.classList.add('email-msg-read');
                  }
                  if (emailFileInfoLine) {
                    emailFileInfoLine.style.color = '#333';
                    emailFileInfoLine.classList.remove('email-msg-unread');
                    emailFileInfoLine.classList.add('email-msg-read');
                  }
                  
                  // Update database is_read (message and recv tables) and sync IMAP server
                  this._markEmailMessageRead(emailEmid);
                };
                
                // Check if image has finished loading
                if (emailImage.complete && emailImage.naturalWidth > 0) {
                  // Image has already loaded, trigger directly
                  console.log('[UIRenderer] email imagealreadyLoad completed, mark as read immediately, emid:', emailEmid);
                  onImageLoad();
                } else {
                  // Image has not finished loading, bind load event
                  emailImage.addEventListener('load', onImageLoad, { once: true });
                  // Also bind error event; mark as read even if loading fails (user has seen placeholder)
                  emailImage.addEventListener('error', () => {
                    console.log('[UIRenderer] emailimage load failed, still mark as read, emid:', emailEmid);
                    onImageLoad();
                  }, { once: true });
                }
              }
            }
          } else {
            console.warn('[UIRenderer] renderMessageToDOM email image message has no emid, unable to bind click event');
          }
        }
      } else {
        // Plain text email message: apply email style overall
        const isAlreadyRead = isRead === 1;
        msgText.style.color = isAlreadyRead ? '#333' : '#1890ff';
        msgText.style.border = '1px solid #ccc';
        msgText.style.borderRadius = '4px';
        msgText.style.padding = '2px 6px';
        msgText.style.cursor = 'pointer';
        if (emid) {
          msgText.dataset.emid = emid;
          msgText.classList.add(isAlreadyRead ? 'email-msg-read' : 'email-msg-unread');
          msgText.addEventListener('click', () => {
            // Blue turns black after click
            msgText.style.color = '#333';
            msgText.classList.remove('email-msg-unread');
            msgText.classList.add('email-msg-read');
            // Update database is_read
            this._markEmailMessageRead(emid);
            this.openEmailDetail(emid);
          });
        }
      }
    }

    msgContent.appendChild(msgText);

    if (id && status < 100 && !hasFileOrImage) {
      const statusSpan = document.createElement('span');
      statusSpan.id = 'msg-status-' + id;
      statusSpan.className = 'message-status';
      statusSpan.textContent = sender === 'Me' ? ' (' + (window.i18n?.t('chat.sending') || 'Sending...') + ')' : ' (' + (window.i18n?.t('chat.receiving') || 'Receiving...') + ')';
      msgContent.appendChild(statusSpan);
    }

    if (this.context.fileTransferManager && this.context.fileTransferManager.uiManager) {
      this.context.fileTransferManager.uiManager.rebindFileTransferEvents(msgText);
    }

    if (sender === 'Me') {
      msgContainer.appendChild(msgContent);
      msgContainer.appendChild(avatarDiv);
    } else {
      msgContainer.appendChild(avatarDiv);
      msgContainer.appendChild(msgContent);
    }

    this.chatDisplay.appendChild(msgContainer);
    this.chatDisplay.scrollTop = this.chatDisplay.scrollHeight;
  }

  /**
   * [Optimization] Batch read-request buffering manager
   * Used to merge multiple read requests within a short time, reducing IMAP server pressure
   */
  _initBatchReadManager() {
    if (this._batchReadManager) return;
    
    this._batchReadManager = {
      // Set of pending emids
      pendingEmids: new Set(),
      // Debounce timer
      debounceTimer: null,
      // Buffer time in milliseconds
      debounceDelay: 300,
      // Maximum buffer size (execute immediately if exceeded)
      maxBatchSize: 10,
      // Whether processing is in progress
      isProcessing: false
    };
  }

  /**
   * [Optimization] Batch mark emails as read
   * Merge multiple requests within a short time using a debounce mechanism
   * @param {string} emid - Email Message-ID
   */
  async _markEmailMessageRead(emid) {
    try {
      if (!emid) {
        console.warn('[UIRenderer] _markEmailMessageRead: emid is empty');
        return;
      }

      const username = this.context.myEmail;
      if (!username) {
        console.warn('[UIRenderer] _markEmailMessageRead: myEmail not available');
        return;
      }

      // Initialize the batch manager
      this._initBatchReadManager();
      const manager = this._batchReadManager;
      
      // Add to the pending set
      manager.pendingEmids.add(emid);
      console.log(`[UIRenderer] read request added to buffer queue: emid=${emid}, currentQueueSize=${manager.pendingEmids.size}`);
      
      // Execute immediately if the maximum batch size is reached
      if (manager.pendingEmids.size >= manager.maxBatchSize) {
        console.log(`[UIRenderer] buffer queue reached max count ${manager.maxBatchSize}, execute batch update immediately`);
        if (manager.debounceTimer) {
          clearTimeout(manager.debounceTimer);
          manager.debounceTimer = null;
        }
        await this._processBatchReadRequests();
        return;
      }
      
      // Clear previous timer
      if (manager.debounceTimer) {
        clearTimeout(manager.debounceTimer);
      }
      
      // Set a new timer
      manager.debounceTimer = setTimeout(async () => {
        await this._processBatchReadRequests();
      }, manager.debounceDelay);
      
    } catch (error) {
      console.error('[UIRenderer] _markEmailMessageRead error:', error);
    }
  }

  /**
   * [Optimization] Process batch read requests
   * Actually execute the batch update operation
   */
  async _processBatchReadRequests() {
    const manager = this._batchReadManager;
    
    // Prevent duplicate execution
    if (manager.isProcessing || manager.pendingEmids.size === 0) {
      return;
    }
    
    manager.isProcessing = true;
    
    // Copy the current pending emid list and clear the queue
    const emidsToProcess = Array.from(manager.pendingEmids);
    manager.pendingEmids.clear();
    manager.debounceTimer = null;
    
    console.log(`[UIRenderer] start executing batch read update: count=${emidsToProcess.length}, emids=${emidsToProcess.join(', ')}`);
    
    try {
      const username = this.context.myEmail;
      if (!username) {
        console.warn('[UIRenderer] _processBatchReadRequests: myEmail not available');
        return;
      }

      // 1. Batch update the message table
      const messageUpdatePromises = emidsToProcess.map(emid => 
        window.electronAPI?.markEmailMessageRead?.({
          emid: emid,
          dbUser: username
        }).then(result => {
          console.log('[UIRenderer] batch update: message table updated, emid:', emid, 'result:', result);
          return { emid, table: 'message', success: true, result };
        }).catch(err => {
          console.warn('[UIRenderer] batch update: failed to update message table, emid:', emid, 'error:', err);
          return { emid, table: 'message', success: false, error: err };
        })
      );

      // 2. Batch update the recv table (need to get each email's uid first)
      const recvUpdatePromises = [];
      
      for (const emid of emidsToProcess) {
        if (window.electronAPI?.getLocalEmailByMessageId) {
          try {
            const email = await window.electronAPI.getLocalEmailByMessageId({
              username,
              messageId: emid
            });

            if (email && email.uid && window.electronAPI?.markRecvEmailRead) {
              recvUpdatePromises.push(
                window.electronAPI.markRecvEmailRead({
                  myEmail: username,
                  emailId: email.uid,
                  imapConfig: null
                }).then(result => {
                  console.log('[UIRenderer] batch update: recv table updated, emid:', emid, 'uid:', email.uid, 'result:', result);
                  return { emid, table: 'recv', success: true, result };
                }).catch(err => {
                  console.warn('[UIRenderer] batch update: failed to update recv table, emid:', emid, 'error:', err);
                  return { emid, table: 'recv', success: false, error: err };
                })
              );
            }
          } catch (err) {
            console.warn('[UIRenderer] batch update: failed to get email by message id, emid:', emid, 'error:', err);
          }
        }
      }

      // Execute all updates in parallel
      const [messageResults, recvResults] = await Promise.all([
        Promise.all(messageUpdatePromises),
        Promise.all(recvUpdatePromises)
      ]);

      const successCount = messageResults.filter(r => r.success).length + recvResults.filter(r => r.success).length;
      const failCount = messageResults.filter(r => !r.success).length + recvResults.filter(r => !r.success).length;
      
      console.log(`[UIRenderer] batch read update completed: succeeded=${successCount}, failed=${failCount}, total=${emidsToProcess.length}`);

    } catch (error) {
      console.error('[UIRenderer] _processBatchReadRequests error:', error);
    } finally {
      manager.isProcessing = false;
      
      // Continue processing if new requests are added during handling
      if (manager.pendingEmids.size > 0) {
        console.log(`[UIRenderer] new requests added during processing, continue processing: count=${manager.pendingEmids.size}`);
        setTimeout(() => this._processBatchReadRequests(), 0);
      }
    }
  }

  /**
   * Open the email detail popup
   * Find the email by emid (Message-ID) and display the email detail component
   */
  async openEmailDetail(emid) {
    try {
      console.log('[UIRenderer] openEmailDetail called, emid:', emid);

      if (!emid) {
        console.warn('[UIRenderer] openEmailDetail: emid is empty');
        return;
      }

      // Get the current username (myEmail) for database queries
      const username = this.context.myEmail;
      if (!username) {
        console.warn('[UIRenderer] openEmailDetail: myEmail not available');
        return;
      }

      // Get email data via IPC
      if (!window.electronAPI || !window.electronAPI.getLocalEmailByMessageId) {
        console.warn('[UIRenderer] openEmailDetail: electronAPI.getLocalEmailByMessageId not available');
        return;
      }

      const email = await window.electronAPI.getLocalEmailByMessageId({
        username,
        messageId: emid
      });

      if (!email) {
        console.warn('[UIRenderer] openEmailDetail: email not found for emid:', emid);
        return;
      }

      console.log('[UIRenderer] openEmailDetail: email found, uid:', email.uid, 'subject:', email.subject);

      // Dynamically import the email detail component
      await import('../../../email-detail-component/index.js');

      // Find or create the email detail component
      let emailDetail = document.getElementById('globalEmailDetail');
      if (!emailDetail) {
        emailDetail = document.createElement('mailink-email-detail');
        emailDetail.id = 'globalEmailDetail';
        document.body.appendChild(emailDetail);
      }

      // Wait for component initialization to complete (connectedCallback is asynchronous)
      if (emailDetail._initPromise) {
        await emailDetail._initPromise;
      }

      // Call the showEmail method to display the email detail popup
      emailDetail.showEmail(email);
    } catch (error) {
      console.error('[UIRenderer] openEmailDetail error:', error);
    }
  }
}
