
import { loadChatTemplate } from './chat-template.js';
import { ChatContext } from './chat-context.js';
import { Utils } from './modules/utils.js';
import Config from './modules/config.js';
import { EventBus } from './modules/event-bus.js';
import { Logger } from './modules/logger.js';
import { UIRenderer } from './modules/ui-renderer.js';
import { SignalingManager } from './modules/signaling.js';
import { ConnectionManager } from './modules/connection/connection-attachments.js';
import { ChatManager } from './modules/chat.js';
import { FileTransferManager } from './modules/file-transfer/index.js';
import { AvatarManager } from './modules/avatar.js';
import { DataChannelManager } from './modules/data-channel.js';
import { MediaCallManager } from './modules/media.js';
import { EmojiPicker } from './components/emoji-picker.js';

export class MailinkChat extends HTMLElement {
    constructor() {
        super();
        this._context = null;
        this._pendingOperations = [];
        this._initialized = false;
    }

    async connectedCallback() {
        if (this.shadowRoot) return; // Prevent double initialization

        try {
            // 1. Initialize Shadow DOM
            const shadow = this.attachShadow({ mode: 'open' });
            
            // Load external CSS and HTML files
            const [cssContent, htmlContent] = await Promise.all([
                this._loadCSS(),
                loadChatTemplate()
            ]);
            shadow.innerHTML = `<style>${cssContent}</style>${htmlContent}`;

            // 2. Create Context
            this._context = new ChatContext(this, shadow);
            
            // Get my-email from attribute (priority over other sources)
            const myEmailFromAttr = this.getAttribute('my-email');
            if (myEmailFromAttr) {
                this._context.myEmail = myEmailFromAttr;
            }

            // 3. Initialize Modules
            this._initModules();
            
            // Notify logger that myEmail is set after logger creation
            if (myEmailFromAttr && this._context.logger) {
                this._context.logger.setMyEmail(myEmailFromAttr);
            }

            // 4. Start
            this._context.logger.info('MailinkChat component initialized');
            
            // 5. Initialize HTTP Port
            this._initHttpServerPort();

            // 6. Notify readiness (optional)
            this._initialized = true;
            this.dispatchEvent(new CustomEvent('ready'));

            // 7. Initialize i18n for shadow DOM and listen for language changes
            // Wait for i18n to be ready before initializing translation to avoid timing issues
            if (window.i18n?.whenReady) {
                await window.i18n.whenReady();
            }
            if (window.i18n?.initElements) {
                window.i18n.initElements(shadow);
            }
            if (window.i18n?.registerRoot) {
                window.i18n.registerRoot(shadow);
            }
            this._onLangChanged = () => {
                if (window.i18n?.initElements) window.i18n.initElements(shadow);
            };
            window.addEventListener('lang-changed', this._onLangChanged);

            // Execute pending operations
            this._pendingOperations.forEach(op => {
                try {
                    op();
                } catch (e) {
                    console.error('[MailinkChat] Error executing pending operation:', e);
                }
            });
            this._pendingOperations = [];
        } catch (error) {
            console.error('[MailinkChat] connectedCallback error:', error);
        }
    }

    async _initHttpServerPort() {
        const initPort = async () => {
            try {
                if (window.electronAPI && window.electronAPI.getHttpServerPort) {
                    const result = await window.electronAPI.getHttpServerPort();
                    if (result.success && result.port) {
                        this._context.httpServerPort = result.port;
                        this._context.logger.info(`📡 HTTP service port obtained: ${result.port}`);
                        return true;
                    }
                }
                return false;
            } catch (e) {
                console.error('Failed to get HTTP port:', e);
                return false;
            }
        };

        let success = await initPort();
        if (!success) {
            const retryInterval = setInterval(async () => {
                success = await initPort();
                if (success) {
                    clearInterval(retryInterval);
                }
            }, 3000);

            setTimeout(() => {
                if (!this._context.httpServerPort) {
                    this._context.httpServerPort = 8080; // Default
                    clearInterval(retryInterval);
                }
            }, 30000);
        }
    }

    disconnectedCallback() {
        // 🎯 Clean up BackupScenarios resources
        if (this._context && this._context.connectionManager) {
            try {
                if (this._context.connectionManager.backupScenarioManager) {
                    this._context.connectionManager.backupScenarioManager.cleanupAllScenarios();
                }
            } catch (e) {
                console.error('[MailinkChat] Error cleaning up BackupScenarios:', e);
            }
        }

        // 🎯 Clean up i18n listeners
        if (window.i18n?.unregisterRoot && this.shadowRoot) {
            window.i18n.unregisterRoot(this.shadowRoot);
        }
        if (this._onLangChanged) {
            window.removeEventListener('lang-changed', this._onLangChanged);
            this._onLangChanged = null;
        }

        if (this._context) {
            this._context = null;
        }
    }

    async _loadCSS() {
        try {
            const cssUrl = new URL('./chat-component.css', import.meta.url).href;
            const response = await fetch(cssUrl);
            if (response.ok) {
                return await response.text();
            }
            console.warn('[MailinkChat] Failed to load CSS, using empty styles');
            return '';
        } catch (error) {
            console.warn('[MailinkChat] Error loading CSS:', error);
            return '';
        }
    }

    static get observedAttributes() {
        return ['contact-email', 'my-email'];
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'contact-email' && oldValue !== newValue) {
            if (this._context) {
                this._context.setTargetEmail(newValue);
                this._context.logger.info(`Contact changed to: ${newValue}`);
                // Trigger soft reset or re-initialization if needed
                // For now, we rely on the external 'contactSelected' message or similar
            }
        } else if (name === 'my-email' && oldValue !== newValue) {
            if (this._context) {
                this._context.myEmail = newValue;
                // Notify logger that myEmail is set
                if (this._context.logger && newValue) {
                    this._context.logger.setMyEmail(newValue);
                }
                console.log(`[MailinkChat] my-email changed to: ${newValue}`);
            }
        }
    }

    _initModules() {
        const ctx = this._context;

        // Order matters for dependencies
        ctx.utils = new Utils();
        ctx.config = Config; // Static config
        ctx.eventBus = new EventBus();
        ctx.logger = new Logger(ctx);
        
        ctx.uiRenderer = new UIRenderer(ctx);
        ctx.signalingManager = new SignalingManager(ctx);
        ctx.connectionManager = new ConnectionManager(ctx);
        ctx.chatManager = new ChatManager(ctx);
        // Bridge methods expected by chat-history.js on context object.
        ctx._renderHistoryFileMessage = (...args) => ctx.chatManager._renderHistoryFileMessage(...args);
        ctx.checkAndUpdateFileTransfers = (...args) => ctx.chatManager.checkAndUpdateFileTransfers(...args);
        ctx.fileTransferManager = new FileTransferManager(ctx);
        ctx.avatarManager = new AvatarManager(ctx);
        window._webp2pAvatar = ctx.avatarManager;
        ctx.dataChannelManager = new DataChannelManager(ctx);
        ctx.mediaCallManager = new MediaCallManager(ctx);

        // Alias for easier access
        ctx.connection = ctx.connectionManager; 
        ctx.ui = ctx.uiRenderer;
        ctx.ui.fileTransferUI = ctx.fileTransferManager.uiManager;

        // Listen for title update events
        ctx.eventBus.on('title:update', (data) => {
            this._updateTitle(data);
        });

        // Start connection polling if target email is set
        if (ctx.targetEmail) {
            // ctx.connectionManager.start(); // If such method exists
        }
    }

    _updateTitle(data) {
        const targetEmail = this._context?.targetEmail;
        if (!targetEmail) return;
        
        const chatTitle = window.i18n?.t ? window.i18n.t('chat.chatTitle') : 'Chat';
        let title = `${chatTitle} - ${targetEmail}`;
        const unknownNat = window.i18n?.t ? window.i18n.t('chat.unknownNat') : 'Unknown';
        if (data.natType && data.natType !== unknownNat && data.natType !== 'unknown') {
            title += ` | ${data.natType}`;
        }
        
        this.setAttribute('title', title);
        
        this.dispatchEvent(new CustomEvent('title-updated', {
            detail: { title, natType: data.natType },
            bubbles: true,
            composed: true
        }));
        
        const titleUpdatedMsg = window.i18n?.t ? window.i18n.t('chat.titleUpdated') : '📌 Title updated: {title}';
        this._context?.logger?.info(titleUpdatedMsg.replace('{title}', title));
    }

    // Public API to replace webcom.contentWindow.postMessage
    postMessage(data) {
        if (this._context && this._context.signalingManager) {
            this._context.signalingManager.handleMessage({ data });
        } else {
            console.warn('MailinkChat: postMessage called before initialization');
        }
    }

    // Public API: Set my email (for delayed initialization)
    setMyEmail(email) {
        if (!this._context) {
            console.warn('MailinkChat: setMyEmail called before initialization');
            return;
        }
        if (email && this._context.logger) {
            this._context.myEmail = email;
            this._context.logger.setMyEmail(email);
            console.log(`[MailinkChat] setMyEmail called: ${email}`);
        }
    }

    // Public API: Select contact
    selectContact(email) {
        if (!this._initialized || !this._context) {
            // Queue operations if component is not yet initialized
            this._pendingOperations.push(() => this.selectContact(email));
            console.warn('MailinkChat: selectContact called before initialization, queued for later execution');
            return;
        }
        this._context.setTargetEmail(email);
        if (this._context.signalingManager) {
            this._context.signalingManager.handleContactSelected({ email });
        }
        this._context.logger.info(`Contact selected via API: ${email}`);
    }

    // Public API: Update user activity timestamp
    updateUserActivity() {
        if (this._context) {
            this._context.updateUserActivity();
        }
    }

    // Public API: Send WebRTC offer
    sendOffer(toEmail, options = {}) {
        if (!this._context) {
            console.warn('MailinkChat: sendOffer called before initialization');
            return;
        }
        if (this._context.connectionManager) {
            this._context.connectionManager.sendoffer(toEmail, options);
            this._context.logger.info(`Send offer via API: ${toEmail}`);
        }
    }

    // Public API: Send WebRTC signal
    sendSignal(event, data) {
        if (!this._context) {
            console.warn('MailinkChat: sendSignal called before initialization');
            return;
        }
        if (this._context.signalingManager) {
            this._context.signalingManager.handleWebRTCSignal(event, data, {
                type: 'WEBRTC_SIGNAL',
                event: event,
                dataSize: JSON.stringify(data).length
            }, Date.now());
            this._context.logger.info(`Send signal via API: ${event}`);
        }
    }

    // Public API: Reset WebRTC connection
    resetConnection() {
        if (!this._context) {
            console.warn('MailinkChat: resetConnection called before initialization');
            return;
        }
        this._context.eventBus.emit('webrtc:reset');
        this._context.logger.info('WebRTC connection reset via API');
    }

    // Public API: Load history messages
    async loadHistoryMessages(email) {
        if (!this._context) {
            console.warn('MailinkChat: loadHistoryMessages called before initialization');
            return;
        }
        if (this._context.chatManager) {
            await this._context.chatManager.loadHistoryMessages(email);
            this._context.logger.info(`Load history messages via API: ${email}`);
        }
    }

    // Public API: Forward log to UI
    forwardLog(logData) {
        if (!this._context) {
            console.warn('MailinkChat: forwardLog called before initialization');
            return;
        }
        if (this._context.ui) {
            const { content, type } = logData;
            this._context.ui.log(content);
        }
    }

    // Public API: Check connection status
    get webRTCConnectionStatus() {
        return this._context?.connectionManager?.webRTCConnectionStatus || 'disconnected';
    }
}
