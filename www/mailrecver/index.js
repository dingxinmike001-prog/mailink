import { getMyEmail } from '../utils/common.js';
import { SIGNALING_EMAIL_PREFIX } from '../../shared/config/signaling-constants.js';

async function loadTemplate() {
    try {
        const htmlUrl = new URL('./mailink-recver.html', import.meta.url).href;
        const response = await fetch(htmlUrl);
        if (response.ok) {
            return await response.text();
        }
        console.warn('[MailinkRecver] Failed to load HTML template, using fallback');
        return '';
    } catch (error) {
        console.warn('[MailinkRecver] Error loading HTML template:', error);
        return '';
    }
}

export class MailinkRecver extends HTMLElement {
    constructor() {
        super();
        this._initialized = false;
    }

    async _initialize() {
        if (this._initialized) return;
        
        // Create Shadow DOM
        this.attachShadow({ mode: 'open' });
        
        // Load external CSS and HTML
        const [cssContent, htmlContent] = await Promise.all([
            this._loadCSS(),
            loadTemplate()
        ]);
        
        // Create style element
        const styleElement = document.createElement('style');
        styleElement.textContent = cssContent;
        this.shadowRoot.appendChild(styleElement);
        
        // Add template content
        const templateElement = document.createElement('template');
        templateElement.innerHTML = htmlContent;
        this.shadowRoot.appendChild(templateElement.content.cloneNode(true));

        if (window.i18n?.registerRoot) window.i18n.registerRoot(this.shadowRoot);
        
        // Wait for i18n to be ready before initializing translation to avoid timing issues
        if (window.i18n?.whenReady) {
            await window.i18n.whenReady();
        }
        if (window.i18n?.initElements) window.i18n.initElements(this.shadowRoot);

        this._boundFetchEmails = this._fetchEmails.bind(this);
        this.onFetchEmails = null;
        this.onWebRTCSignal = null;
        this.onForwardLog = null;
        
        this._initialized = true;
    }

    async _loadCSS() {
        try {
            const cssUrl = new URL('./mailink-recver.css', import.meta.url).href;
            const response = await fetch(cssUrl);
            if (response.ok) {
                return await response.text();
            }
            console.warn('[MailinkRecver] Failed to load CSS, using empty styles');
            return '';
        } catch (error) {
            console.warn('[MailinkRecver] Error loading CSS:', error);
            return '';
        }
    }

    async connectedCallback() {
        await this._initialize();
        this._bindEvents();
        this._setupMessageListener();
        this._boundOnLangChanged = this._onLangChanged.bind(this);
        window.addEventListener('lang-changed', this._boundOnLangChanged);
    }

    disconnectedCallback() {
        if (window.i18n?.unregisterRoot) window.i18n.unregisterRoot(this.shadowRoot);
        window.removeEventListener('lang-changed', this._boundOnLangChanged);
    }

    _onLangChanged() {
        if (window.i18n?.initElements) window.i18n.initElements(this.shadowRoot);
    }

    _bindEvents() {
        const fetchBtn = this.shadowRoot.getElementById('fetchBtn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', this._boundFetchEmails);
        }
    }

    _setupMessageListener() {
        window.addEventListener('message', (event) => {
            const { data } = event;
            if (!data) return;

            if (data.type === 'emailsData') {
                this._handleEmailsData(data.emails);
            } else if (data.type === 'fetchError') {
                this._handleFetchError(data.error);
            }
        });

        window.addEventListener('connectionStatusChange', (event) => {
            if (event.detail && typeof event.detail.isConnected === 'boolean') {
                this._handleConnectionStatusChange(event.detail.isConnected);
            }
        });
    }

    _handleConnectionStatusChange(isConnected) {
        if (isConnected) {
            this._log(window.i18n?.t('recver.connectionRestored') || '✅ Connection restored');
        } else {
            this._log(window.i18n?.t('recver.connectionLost') || '❌ Connection disconnected');
        }
    }

    _handleEmailsData(emails) {
        // If 0 emails are fetched, only log to console.log without showing a prompt
        if (emails.length === 0) {
            console.log('successfully obtained 0 email(s)');
        } else {
            this._showStatus((window.i18n?.t('recver.fetchSuccess') || 'successfully obtained {count} email(s)').replace('{count}', emails.length), 'success');
        }
        this._renderEmails(emails);
    }

    _handleFetchError(error) {
        this._showStatus(`${window.i18n?.t('recver.fetchFailed') || 'Failed to fetch email'}: ${error}`, 'error');
    }

    _fetchEmails() {
        try {
            this._showStatus('<div class="loading"><div class="spinner"></div><p>loading...</p></div>', 'info');
            if (this.onFetchEmails) {
                this.onFetchEmails({ minutes: 2 });
            }
        } catch (error) {
            this._log(`Email fetch failed: ${error.message}`, 'error');
            this._showStatus(`Email fetch failed: ${error.message}`, 'error');
        }
    }

    _renderEmails(emails) {
        if (sessionStorage.getItem(this._getWebRTCStorageKey()) === 'ok') {
            return;
        }

        // Handle WebRTC signaling emails
        emails.forEach(email => {
            this._processWebRTCSignalingEmail(email);
        });

        // Only output email statistics via logs
        this._log(`Email processing completed，total ${emails.length} email(s)`);
    }

    _getWebRTCStorageKey() {
        const myEmail = getMyEmail();
        const targetEmail = sessionStorage.getItem('targetEmail') || '';
        return `${myEmail}_to_${targetEmail}_connect_fromwebrtc`;
    }

    _processWebRTCSignalingEmail(email) {
        const subject = email.subject;
        const fromEmail = email.from;
        const body = email.body || email.text || '';

        this._log(`[WebRTC] =================== Start processing signaling email ===================`);
        this._log(`[WebRTC] Email info: subject: ${subject}, from: ${fromEmail}`);

        if (!sessionStorage.getItem('targetEmail')) {
            sessionStorage.setItem('targetEmail', fromEmail);
            this._log(`[WebRTC] Auto setting targetEmail: ${fromEmail}`);
        }

        if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'offer-complete-')) {
            this._log('[WebRTC] 🎯 detected offer email，Start parsing...');

            try {
                const offerData = JSON.parse(body);
                this._log(`[WebRTC] offer data parsing successful: hasSdp=${!!offerData.sdp}`);

                const messageData = {
                    type: 'WEBRTC_SIGNAL',
                    event: 'recv_offer',
                    data: {
                        from: fromEmail,
                        offerData: body
                    }
                };

                this._log(`[WebRTC] send recv_offer Signal to main window`);
                if (this.onWebRTCSignal) {
                    this.onWebRTCSignal({
                        type: 'WEBRTC_SIGNAL',
                        event: 'recv_offer',
                        data: {
                            from: fromEmail,
                            offerData: body
                        }
                    });
                }
                this._log('[WebRTC] ✅ offer signal sent');
                this._showStatus(window.i18n?.t('recver.offerReceived') || '✅ received WebRTC offer signaling，processing...', 'success');

            } catch (error) {
                this._log(`[WebRTC] ❌ offer parsing failed: ${error.message}`, 'error');
                this._showStatus(`${window.i18n?.t('recver.offerParseFailed') || '❌ offer signaling parsing failed'}: ${error.message}`, 'error');
            }

        } else if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'answer-')) {
            this._log('[WebRTC] 🎯 detected answer email...');

            try {
                const answerData = JSON.parse(body);
                this._log(`[WebRTC] answer data parsing successful: hasSdp=${!!answerData.sdp}`);

                if (this.onWebRTCSignal) {
                    this.onWebRTCSignal({
                        type: 'WEBRTC_SIGNAL',
                        event: 'recv_answer',
                        data: {
                            from: fromEmail,
                            answerData: body
                        }
                    });
                }

                this._log('[WebRTC] ✅ answer signal sent');
                this._showStatus(window.i18n?.t('recver.answerReceived') || '✅ received WebRTC answer signaling，processing...', 'success');

            } catch (error) {
                this._log(`[WebRTC] ❌ answer parsing failed: ${error.message}`, 'error');
                this._showStatus(`${window.i18n?.t('recver.answerParseFailed') || '❌ answer signaling parsing failed'}: ${error.message}`, 'error');
            }

        } else if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {
            this._log('[WebRTC] 🎯 detected discover email...');

            if (this.onWebRTCSignal) {
                this.onWebRTCSignal({
                    type: 'WEBRTC_SIGNAL',
                    event: 'discover',
                    data: {
                        from: fromEmail,
                        role: subject.includes('sender') ? 'sender' : 'receiver'
                    }
                });
            }

            this._log('[WebRTC] ✅ discover signal sent');
            this._showStatus(window.i18n?.t('recver.discoverReceived') || '✅ received WebRTC discover signaling', 'success');

        } else {
            this._log(`[WebRTC] ⏭️  Unrecognized WebRTC Signaling type: ${subject}`);
        }

        this._log('[WebRTC] =================== Signaling email processing completed ===================');
    }

    _log(message, type = 'info') {
        const validTypes = ['log', 'info', 'warn', 'error', 'debug'];
        const consoleType = validTypes.includes(type) ? type : 'log';
        console[consoleType](message);

        if (this.onForwardLog) {
            this.onForwardLog({
                content: message,
                timestamp: Date.now(),
                type: type
            });
        }
    }

    _showStatus(message, type = 'info') {
        const statusArea = this.shadowRoot.getElementById('statusArea');
        if (statusArea) {
            statusArea.innerHTML = `<span class="status status-${type} status-animation">${message}</span>`;
            setTimeout(() => {
                statusArea.innerHTML = '';
            }, 2000);
        }
    }

    postMessage(data) {
        if (data.type === 'emailsData') {
            this._handleEmailsData(data.emails);
        } else if (data.type === 'fetchError') {
            this._handleFetchError(data.error);
        }
    }
}

customElements.define('mailink-recver', MailinkRecver);
