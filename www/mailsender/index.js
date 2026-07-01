import '../utils/avatar-html.js';
import './contact-list-component/index.js';
import '../email-compose-component/index.js';
import { loadTemplate } from './template.js';
import { getMyEmail } from '../utils/common.js';
import { SIGNALING_EMAIL_PREFIX } from '../../shared/config/signaling-constants.js';

export class MailinkSender extends HTMLElement {
    constructor() {
        super();
        this._cssLoaded = false;
        this._pendingOperations = [];
        this._processedUnreadBadgeKeys = new Set();

        // Add duplicate-trigger prevention mechanism
        this._lastSignalingEmailTime = 0;
        this._signalingEmailCooldown = 20000; // 20-second cooldown
        this._autoSelectPending = false;
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
        
        // Wait for i18n to be ready before initializing translation to avoid timing issues causing buttons to show default Chinese
        if (window.i18n?.whenReady) {
            await window.i18n.whenReady();
        }
        if (window.i18n?.initElements) window.i18n.initElements(this.shadowRoot);

        this._initialized = true;
        
        // Execute pending operations
        this._pendingOperations.forEach(op => op());
        this._pendingOperations = [];
    }

    async _loadCSS() {
        try {
            const cssUrl = new URL('./mailink-sender.css', import.meta.url).href;
            const response = await fetch(cssUrl);
            if (response.ok) {
                return await response.text();
            }
            console.warn('[MailinkSender] Failed to load CSS, using empty styles');
            return '';
        } catch (error) {
            console.warn('[MailinkSender] Error loading CSS:', error);
            return '';
        }
    }

    async connectedCallback() {
        await this._initialize();

        this._onLangChanged = () => {
            if (window.i18n?.initElements) window.i18n.initElements(this.shadowRoot);
        };
        window.addEventListener('lang-changed', this._onLangChanged);

        this._bindEvents();
        this._setupContactListListeners();
        this._setupUnreadCountListener();
        this._setupRecvEmailsUpdateListener();
        this._setupMessageListener();
        this._setupMymailListener();
        this._generateWebRTCSignalSubject();
        this._loadContactListComponent();

        const checkAndAutoClick = () => {
            const contactList = this.shadowRoot.getElementById('contact-list');
            if (contactList && contactList.isLoaded) {
                this._handleAutoClick();
            }
        };
        setTimeout(checkAndAutoClick, 2000);

        // Listen to unread count update event and forward to parent window
        this._setupRecvUnreadCountListener();
    }

    disconnectedCallback() {
        if (window.i18n?.unregisterRoot) window.i18n.unregisterRoot(this.shadowRoot);
        if (this._onLangChanged) {
            window.removeEventListener('lang-changed', this._onLangChanged);
            this._onLangChanged = null;
        }
    }

    /**
     * Set unread count update listener
     */
    _setupRecvUnreadCountListener() {
        this._handleRecvUnreadCountUpdated = (e) => {
            const myEmail = getMyEmail();
            if (e.detail && e.detail.myEmail === myEmail) {
                // Forward event to parent window using a different event name to avoid recursion
                window.dispatchEvent(new CustomEvent('unreadCountUpdated', {
                    detail: e.detail
                }));
            }
        };
        window.addEventListener('recvUnreadCountUpdated', this._handleRecvUnreadCountUpdated);
    }

    _loadContactListComponent() {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (!contactList) {
            setTimeout(() => this._loadContactListComponent(), 100);
            return;
        }
        if (contactList.children.length === 0 || !contactList._initialized) {
            setTimeout(() => this._loadContactListComponent(), 100);
        }
    }

    _setupMymailListener() {
        let currentMyMail = getMyEmail();
        setInterval(() => {
            const newMyMail = getMyEmail();
            if (newMyMail !== currentMyMail) {
                this._log(`mymail changed: ${currentMyMail} → ${newMyMail}`);
                currentMyMail = newMyMail;
                const contactList = this.shadowRoot.getElementById('contact-list');
                if (contactList && typeof contactList.refresh === 'function') {
                    contactList.refresh();
                }
            }
        }, 1000);
    }

    _handleAutoClick() {
        this._log('🤖 [debug] _handleAutoClick called');
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (!contactList) {
            console.warn('[debug] contact-list not found');
            return;
        }
        this._log(`[debug] contact-list found, isLoaded=${contactList.isLoaded}`);

        const checkAndClick = () => {
            const contactListShadow = contactList.shadowRoot;
            const firstCard = contactListShadow?.querySelector?.('.contact-card:not(.disabled)') ||
                             contactList.querySelector?.('.contact-card:not(.disabled)');

            this._log(`[debug] Find first contact card: ${firstCard ? 'found' : 'not found'}`);

            if (firstCard) {
                this._log('[debug] 🖱️ Prepare to click first contact');
                this._log(`[debug] Contact info: ${firstCard.textContent?.substring(0, 50)}...`);
                this._autoSelectPending = true;
                firstCard.click?.();
                this._log('✅ [debug] Auto click completed, Waiting for contact selection event');

                // Remove auto-trigger signaling email send logic to avoid duplicate triggers
                // Signaling emails are only triggered by manually selecting a contact
                return true;
            }
            return false;
        };

        const startCheck = () => {
            this._log('[debug] Start checking contact list...');
            if (checkAndClick()) return;

            let attempts = 0;
            const maxAttempts = 50;

            const retry = () => {
                attempts++;
                this._log(`[debug] No. ${attempts} attempt(s) to find contact...`);
                if (checkAndClick()) return;

                if (attempts < maxAttempts) {
                    setTimeout(retry, 100);
                } else {
                    this._log('⚠️ [debug] Auto click timeout, No available contact found');
                }
            };

            setTimeout(retry, 100);
        };

        setTimeout(startCheck, 500);
    }

    _generateWebRTCSignalSubject() {
        const generateRandomString = (length) => {
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            let result = '';
            for (let i = 0; i < length; i++) {
                result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return result;
        };

        const prefix = SIGNALING_EMAIL_PREFIX + 'discover-';
        const timestamp = Date.now();
        const randomStr = generateRandomString(9);
        const subject = `${prefix}${timestamp}-${randomStr}`;

        const subjectEl = this.shadowRoot.getElementById('subject');
        if (subjectEl) {
            subjectEl.value = subject;
        }
    }

    _log(message, type = 'info') {
        const validTypes = ['log', 'info', 'warn', 'error', 'debug'];
        const consoleType = validTypes.includes(type) ? type : 'log';
        console[consoleType](message);

        this.dispatchEvent(new CustomEvent('log', {
            detail: {
                content: message,
                timestamp: Date.now(),
                type: type
            },
            bubbles: true,
            composed: true
        }));
    }

    /**
     * Get current user's nickname
     * @returns {string} User nickname, or the email username part if not set
     */
    _getMyNickname() {
        try {
            const currentConfig = window.getSelectedConfig?.();
            if (currentConfig?.name) {
                return currentConfig.name.split(' (')[0];
            }
            const storedConfig = localStorage.getItem('userConfig');
            if (storedConfig) {
                const config = JSON.parse(storedConfig);
                if (config.name) {
                    return config.name.split(' (')[0];
                }
            }
        } catch (e) {
            console.warn('Failed to get user nickname:', e);
        }
        const myEmail = getMyEmail();
        return myEmail ? myEmail.split('@')[0] : (window.i18n?.t('common.unknownUser') || 'unknown user');
    }

    async sendemail() {
        const subjectEl = this.shadowRoot.getElementById('subject');
        const bodyEl = this.shadowRoot.getElementById('body');

        if (!subjectEl || !subjectEl.value) {
            this._generateWebRTCSignalSubject();
        }

        const contactList = this.shadowRoot.getElementById('contact-list');
        let selectedCard = contactList?.shadowRoot?.querySelector?.('.contact-card.selected') ||
                          contactList?.querySelector?.('.contact-card.selected');
        let to = selectedCard ? selectedCard.dataset.value : window.currentSelectedContactEmail || '';

        const subject = this.shadowRoot.getElementById('subject').value;
        let body = this.shadowRoot.getElementById('body').value;

        if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {
            const myEmail = getMyEmail();

            if (myEmail && to) {
                if (myEmail < to) {
                    this._log(`optimize: I am Sender (${myEmail} < ${to}), skip discover email, generate directly Offer`);
                    this._log('Initiating connection (Sender)...', 'info');

                    this._log('📤 ready to sendtriggerSendOffermessage, toEmail: ' + to);
                    window.postMessage({
                        type: 'triggerSendOffer',
                        toEmail: to
                    }, '*');
                    this._log('✅ triggerSendOffermessage sent');

                    const subjectEl = this.shadowRoot.getElementById('subject');
                    const bodyEl = this.shadowRoot.getElementById('body');
                    if (subjectEl) subjectEl.value = '';
                    if (bodyEl) bodyEl.value = '';

                    this._log('🔓 SenderMode skipdiscover, Release global lock');
                    return;
                } else {
                    this._log(`optimize: I am Receiver (${myEmail} > ${to}), send discover Mail wake-up Sender`);
                }
            }

            let senderName = myEmail ? myEmail.split('@')[0] : (window.i18n?.t('common.unknownUser') || 'unknown user');
            try {
                const currentConfig = window.getSelectedConfig();
                if (currentConfig && currentConfig.name) {
                    senderName = currentConfig.name.split(' (')[0];
                }
            } catch (e) {
                this._log('failed to get config name, use default name: ' + senderName);
            }

            let attachments = [];
            if (window.electronAPI && window.electronAPI.getUnsentMessages) {
                try {
                    const unsentMessages = await window.electronAPI.getUnsentMessages({
                        fromer: myEmail,
                        toer: to
                    });

                    if (unsentMessages && unsentMessages.length > 0) {
                        let earliestImageMsgId = null;
                        for (const msg of unsentMessages) {
                            const match = msg.content.match(/data-copied-path="([^"]+)"/);
                            const mimeMatch = msg.content.match(/data-mime-type="([^"]+)"/);

                            if (match && match[1] && mimeMatch && mimeMatch[1].startsWith('image/')) {
                                if (!earliestImageMsgId) {
                                    earliestImageMsgId = msg.id;
                                    attachments.push({
                                        filename: msg.content.match(/<div class="file-name">([^<]+)<\/div>/)?.[1] || 'image.png',
                                        path: match[1],
                                        cid: String(msg.id)
                                    });
                                }
                            }
                        }
                        if (attachments.length > 0) {
                            this._log(`📋 Discover Mail extracted to ${attachments.length} attachment(s)`);
                        }
                    }
                } catch (e) {
                    this._log('failed to get unsent messages: ' + e.message);
                }
            }

            body = {
                body: JSON.stringify({
                    type: 'discover',
                    version: '1.0',
                    content: '00000',
                    senderName: senderName,
                    messageId: `discover-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    unsentMessages: []
                }),
                attachments: attachments
            };
        }

        if (!to) {
            this.showStatus(window.i18n?.t('errors.pleaseSelectValidFriend') || 'please select a valid contact', 'error');
            return;
        }

        const { isValidEmail } = await import('../utils/index.js');
        if (!isValidEmail(to)) {
            this.showStatus(window.i18n?.t('errors.pleaseEnterValidEmail') || 'please enter a valid email address', 'error');
            return;
        }

        if (!subject) {
            this.showStatus(window.i18n?.t('errors.pleaseFillSubject') || 'please enter email subject', 'error');
            return;
        }

        const config = window.getSelectedConfig();
        if (!config) {
            this.showStatus(window.i18n?.t('errors.pleaseSelectAndLoginConfig') || 'please select and log in to an email config first', 'error');
            this.showConfigSelectionPrompt();
            return;
        }

        try {
            let result;
            if (subject.startsWith(SIGNALING_EMAIL_PREFIX + 'discover-')) {
                result = await window.electronAPI.sendemail(config, {
                    to: to,
                    subject: subject,
                    text: body.body,
                    attachments: body.attachments
                });
            } else {
                result = await window.electronAPI.sendemail(config, {
                    to: to,
                    subject: subject,
                    text: typeof body === 'object' ? body.body : body,
                    attachments: typeof body === 'object' ? body.attachments : []
                });
            }

            this._log(window.i18n?.t('emailCompose.emailSentSuccess') || 'sent successfully', 'success');
            this.showStatus(window.i18n?.t('emailCompose.emailSentSuccess') || 'email sent successfully', 'success');

            subjectEl.value = '';
            bodyEl.value = '';
        } catch (error) {
            this._log((window.i18n?.t('emailCompose.emailSendFailed') || 'failed to send email') + ': ' + error.message, 'error');
            this.showStatus((window.i18n?.t('emailCompose.emailSendFailed') || 'failed to send email') + ': ' + error.message, 'error');
        }
    }

    _dispatchMessage(data) {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (!contactList) return;

        switch (data.type) {
            case 'refreshContacts':
                if (typeof contactList.refresh === 'function') {
                    contactList.refresh();
                }
                break;
            case 'updateContactAvatar':
                const { email, avatar } = data;
                if (contactList._updateContactAvatar) {
                    contactList._updateContactAvatar(email, avatar);
                }
                break;
            case 'updateContactLastMessage':
                const { email: msgEmail } = data;
                if (msgEmail && contactList._refreshContactLastMessage) {
                    contactList._refreshContactLastMessage(msgEmail);
                }
                break;
            case 'webcomActivated':
                const { email: activatedEmail } = data;
                if (contactList._handleWebcomActivated) {
                    contactList._handleWebcomActivated(activatedEmail);
                }
                break;
            case 'addContact':
                if (contactList._handleAddContact) {
                    contactList._handleAddContact(data.contact);
                }
                break;
            case 'contactAdded':
                if (contactList._handleContactAdded) {
                    contactList._handleContactAdded(data.contact);
                }
                break;
            case 'openEditContactModal':
                console.log('[MailinkSender] Received open edit contact message:', data.contact);
                this._openEditContactModal(data.contact);
                break;
            case 'discoverEmailConfirmed':
                const { email: discoverEmail } = data;
                this.dispatchEvent(new CustomEvent('discoverEmailConfirmed', {
                    detail: { email: discoverEmail },
                    bubbles: true,
                    composed: true
                }));
                break;
            case 'autoClick':
                this._handleAutoClick();
                break;
            case 'connectionStatusChange':
                if (window.connectionStatusChange) {
                    window.dispatchEvent(new CustomEvent('connectionStatusChange', {
                        detail: { status: data.isConnected ? 'connected' : 'disconnected' }
                    }));
                }
                break;
        }
    }

    _setupContactListListeners() {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (!contactList) return;

        contactList.addEventListener('contactselected', async (event) => {
            const { email, name } = event.detail;
            this._log(`📋 Contact selection event: ${email}`);
            window.currentSelectedContactEmail = email;

            this.dispatchEvent(new CustomEvent('contactSelected', {
                detail: { email, name },
                bubbles: true,
                composed: true
            }));

            // Uniformly handle signaling email sending (role determination + either/or mechanism)
            await this._handleContactSelectedSignaling(email);
        });

        contactList.addEventListener('contactdeleted', (event) => {
            const { email } = event.detail;
            this.dispatchEvent(new CustomEvent('contactDeleted', {
                detail: { email },
                bubbles: true,
                composed: true
            }));
        });

        contactList.addEventListener('status', (event) => {
            const { message, type } = event.detail;
            this.showStatus(message, type);
        });

        contactList.addEventListener('openEditContactModal', (event) => {
            const { contact } = event.detail;
            console.log('[MailinkSender] Received open edit contact event:', contact);
            this._openEditContactModal(contact);
        });
    }

    /**
     * Uniformly handle signaling email sending after contact selection
     * Implements role determination + either/or mechanism + 20s cooldown
     * @param {string} targetEmail - Target contact email
     */
    async _handleContactSelectedSignaling(targetEmail) {
        try {
            const myEmail = getMyEmail();
            if (!myEmail) {
                this._log('cannot get current user email, Skip signaling send');
                return;
            }

            // Check whether auto-signaling is enabled
            const config = window.getAutoSignalingConfig?.();
            if (config && !config.enabled) {
                this._log('Auto signaling is disabled, Skip send');
                return;
            }

            // Role determination: smaller email lexicographically is Sender
            const isSender = myEmail.trim().toLowerCase() < targetEmail.trim().toLowerCase();

            if (!isSender) {
                this._log(`📥 I am Receiver (${myEmail} > ${targetEmail}), Do not send signaling`);
                return;
            }

            // 20-second cooldown check (unified cooldown time)
            const now = Date.now();
            const timeSinceLastSend = now - this._lastSignalingEmailTime;
            const cooldownMs = this._signalingEmailCooldown; // 20 seconds

            if (timeSinceLastSend < cooldownMs) {
                this._log(`⏱️ Signaling send blocked, Only elapsed since last send ${timeSinceLastSend}ms, Cooldown time: ${cooldownMs}ms`);
                return;
            }

            // Update last send time
            this._lastSignalingEmailTime = now;

            // Either/or mechanism: Sender sends Offer directly (does not send Discover)
            this._log(`📤 I am Sender (${myEmail} < ${targetEmail}), Trigger send Offer`);

            // Dispatch global event to notify webrtc component to send Offer
            window.dispatchEvent(new CustomEvent('autoTriggerSignaling', {
                detail: {
                    type: 'sendOffer',
                    targetEmail: targetEmail,
                    myEmail: myEmail,
                    source: 'contactSelected',
                    isNewContact: false
                }
            }));

            this.showStatus(window.i18n?.t('chat.connectingToFriend') || 'Actively connecting friend...', 'info');
        } catch (error) {
            this._log('Trigger signaling send failed: ' + error.message, 'error');
        }
    }

    _setupUnreadCountListener() {
        this.addEventListener('incrementUnreadCount', (event) => {
            const { email, msgId, count } = event.detail || {};
            const incrementCount = count || 1;
            this._log(`📥 Received unread message increased event: ${email}, count: ${incrementCount}`);
            
            const contactList = this.shadowRoot.getElementById('contact-list');
            if (contactList && contactList.shadowRoot) {
                const targetEmail = email.trim().toLowerCase();
                const normalizedMsgId = msgId ? String(msgId) : null;
                if (normalizedMsgId) {
                    const key = `${targetEmail}|${normalizedMsgId}`;
                    if (this._processedUnreadBadgeKeys.has(key)) {
                        return;
                    }
                    this._processedUnreadBadgeKeys.add(key);
                    setTimeout(() => {
                        this._processedUnreadBadgeKeys.delete(key);
                    }, 10000);
                }
                const contactCards = contactList.shadowRoot.querySelectorAll('.contact-card');
                
                contactCards.forEach(card => {
                    const cardEmail = (card.dataset.value || '').trim().toLowerCase();
                    if (cardEmail === targetEmail) {
                        const badge = card.querySelector('.unread-badge');
                        if (badge) {
                            let currentCount = parseInt(badge.textContent) || 0;
                            if (badge.textContent === '99+') {
                                return;
                            }
                            currentCount += incrementCount;
                            badge.classList.remove('hidden');
                            badge.textContent = currentCount > 99 ? '99+' : currentCount.toString();
                        }
                    }
                });
            }
        });

        this.addEventListener('clearUnreadBadge', (event) => {
            const { email } = event.detail;
            this._log(`📥 Received clear unread badge event: ${email}`);
            
            const contactList = this.shadowRoot.getElementById('contact-list');
            if (contactList && contactList.shadowRoot) {
                const targetEmail = email.trim().toLowerCase();
                const contactCards = contactList.shadowRoot.querySelectorAll('.contact-card');
                
                contactCards.forEach(card => {
                    const cardEmail = (card.dataset.value || '').trim().toLowerCase();
                    if (cardEmail === targetEmail) {
                        const badge = card.querySelector('.unread-badge');
                        if (badge) {
                            badge.classList.add('hidden');
                            badge.textContent = '0';
                        }
                    }
                });
            }
        });
    }

    /**
     * Set recv table email update listener
     * Update unread count display immediately after IMAP fetches new emails and writes to recv table
     */
    _setupRecvEmailsUpdateListener() {
        const api = window.electronAPI;
        if (api && api.onRecvEmailsUpdated) {
            api.onRecvEmailsUpdated((event, data) => {
                const { username, newCount } = data || {};
                this._log(`📬 receivedrecvTable update notification: ${username}, New mail: ${newCount}`);

                // Check if it is the current user
                const myEmail = getMyEmail();
                if (myEmail && username === myEmail) {
                    // Trigger global event to notify main page to update badge
                    window.dispatchEvent(new CustomEvent('recvEmailsUpdated', {
                        detail: { username, newCount }
                    }));
                }
            });
            this._log('📬 recvTable mail update listener set');
        }
    }

    _setupMessageListener() {
        document.addEventListener('refreshContacts', () => {
            this._handleRefreshContacts();
        });

        document.addEventListener('updateContactAvatar', (e) => {
            const { email, avatar } = e.detail;
            this._handleUpdateContactAvatar(email, avatar);
        });

        document.addEventListener('updateContactLastMessage', (e) => {
            const { email } = e.detail;
            this._handleUpdateContactLastMessage(email);
        });

        document.addEventListener('webcomActivated', (e) => {
            const { email } = e.detail;
            this._handleWebcomActivated(email);
        });

        document.addEventListener('addContact', (e) => {
            const { contact } = e.detail;
            this._handleAddContact(contact);
        });

        document.addEventListener('contactAdded', (e) => {
            const { contact } = e.detail;
            this._handleContactAdded(contact);
        });

        document.addEventListener('autoClick', () => {
            this._handleAutoClick();
        });

        document.addEventListener('contactsLoaded', () => {
            this._handleAutoClick();
        });

        document.addEventListener('connectionStatusChange', (e) => {
            const { status } = e.detail;
            this._log(`📡 Connection status changed: ${status}`);
        });
    }

    _handleRefreshContacts() {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (contactList && typeof contactList.refresh === 'function') {
            contactList.refresh();
        }
    }

    _handleUpdateContactAvatar(email, avatar) {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (contactList && contactList._updateContactAvatar) {
            contactList._updateContactAvatar(email, avatar);
        }
    }

    _handleUpdateContactLastMessage(email) {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (contactList && email && contactList._refreshContactLastMessage) {
            contactList._refreshContactLastMessage(email);
        }
    }

    _handleWebcomActivated(email) {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (contactList && contactList._handleWebcomActivated) {
            contactList._handleWebcomActivated(email);
        }
    }

    _handleAddContact(contact) {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (contactList && contactList._handleAddContact) {
            contactList._handleAddContact(contact);
        }
    }

    _handleContactAdded(contact) {
        const contactList = this.shadowRoot.getElementById('contact-list');
        if (contactList && contactList._handleContactAdded) {
            contactList._handleContactAdded(contact);
        }
    }

    postMessage(data) {
        this._dispatchMessage(data);
    }

    // Public API: Refresh contacts
    refreshContacts() {
        this._handleRefreshContacts();
    }

    // Public API: Handle webcom activated
    handleWebcomActivated(email) {
        this._handleWebcomActivated(email);
    }

    // Public API: Update contact avatar
    updateContactAvatar(email, avatar) {
        this._handleUpdateContactAvatar(email, avatar);
    }

    // Public API: Update contact last message
    updateContactLastMessage(email) {
        this._handleUpdateContactLastMessage(email);
    }

    // Public API: Add contact
    addContact(contact) {
        this._handleAddContact(contact);
    }

    // Public API: Handle contact added
    handleContactAdded(contact) {
        this._handleContactAdded(contact);
    }

    // Public API: Handle auto click
    handleAutoClick() {
        this._handleAutoClick();
    }

    _bindEvents() {
        const modal = this.shadowRoot.getElementById('add-contact-modal');
        const editModal = this.shadowRoot.getElementById('edit-contact-modal');
        const closeBtns = this.shadowRoot.querySelectorAll('.close');
        const cancelBtn = this.shadowRoot.getElementById('cancel-contact-btn');
        const cancelEditBtn = this.shadowRoot.getElementById('cancel-edit-contact-btn');
        const addContactBtn = this.shadowRoot.getElementById('add-contact-btn');
        const saveContactBtn = this.shadowRoot.getElementById('save-contact-btn');
        const updateContactBtn = this.shadowRoot.getElementById('update-contact-btn');
        const composeEmailBtn = this.shadowRoot.getElementById('compose-email-btn');
        const inboxBtn = this.shadowRoot.getElementById('inbox-btn');

        if (addContactBtn) {
            addContactBtn.addEventListener('click', () => {
                modal.classList.add('show');
                // Set default "request to add as friend" content
                const readmeInput = this.shadowRoot.getElementById('contact-readme');
                if (readmeInput) {
                    const myNickname = this._getMyNickname();
                    const iAmPrefix = window.i18n?.t('sender.readmePlaceholder') || 'I am：';
                    readmeInput.value = `${iAmPrefix}${myNickname}`;
                }
            });
        }

        if (composeEmailBtn) {
            composeEmailBtn.addEventListener('click', () => {
                this._openComposeEmail();
            });
        }

        if (inboxBtn) {
            inboxBtn.addEventListener('click', () => {
                this._openInbox();
            });
        }

        closeBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const modalId = btn.dataset.modal;
                if (modalId) {
                    const targetModal = this.shadowRoot.getElementById(modalId);
                    if (targetModal) {
                        targetModal.classList.remove('show');
                    }
                }
            });
        });

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                modal.classList.remove('show');
            });
        }

        if (cancelEditBtn) {
            cancelEditBtn.addEventListener('click', () => {
                editModal.classList.remove('show');
            });
        }

        if (saveContactBtn) {
            saveContactBtn.addEventListener('click', () => {
                const contactList = this.shadowRoot.getElementById('contact-list');
                const name = this.shadowRoot.getElementById('contact-name').value;
                const email = this.shadowRoot.getElementById('contact-email').value;
                const readme = this.shadowRoot.getElementById('contact-readme').value;
                if (contactList && name && email) {
                    contactList.addContact({
                        rmkname: name,
                        username: email,
                        readme: readme
                    });
                }
                modal.classList.remove('show');
                this.shadowRoot.getElementById('contact-name').value = '';
                this.shadowRoot.getElementById('contact-email').value = '';
                this.shadowRoot.getElementById('contact-readme').value = '';
            });
        }

        if (updateContactBtn) {
            updateContactBtn.addEventListener('click', () => {
                const contactList = this.shadowRoot.getElementById('contact-list');
                const name = this.shadowRoot.getElementById('edit-contact-name').value;
                const email = this.shadowRoot.getElementById('edit-contact-email').value;
                if (contactList && name && email) {
                    contactList.updateContact({
                        rmkname: name,
                        username: email
                    });
                }
                editModal.classList.remove('show');
                this.shadowRoot.getElementById('edit-contact-name').value = '';
                this.shadowRoot.getElementById('edit-contact-email').value = '';
            });
        }
    }

    _openComposeEmail() {
        const emailCompose = this.shadowRoot.getElementById('email-compose');
        if (emailCompose) {
            // Get currently selected contact email (if any)
            const contactList = this.shadowRoot.getElementById('contact-list');
            let defaultTo = '';
            if (contactList) {
                const selectedCard = contactList.shadowRoot?.querySelector?.('.contact-card.selected') ||
                                     contactList.querySelector?.('.contact-card.selected');
                if (selectedCard) {
                    defaultTo = selectedCard.dataset.value || '';
                }
            }
            emailCompose.showNewEmailCompose(defaultTo);
        } else {
            console.warn('[MailinkSender] Compose mail component not found');
        }
    }

    _openEditContactModal(contact) {
        console.log('[MailinkSender] _openEditContactModal called:', contact);
        const editModal = this.shadowRoot.getElementById('edit-contact-modal');
        console.log('[MailinkSender] Edit modal element:', editModal);
        if (editModal) {
            const nameInput = this.shadowRoot.getElementById('edit-contact-name');
            const nicknameInput = this.shadowRoot.getElementById('edit-contact-nickname');
            const emailInput = this.shadowRoot.getElementById('edit-contact-email');
            console.log('[MailinkSender] Form element:', { nameInput, nicknameInput, emailInput });
            if (nameInput) nameInput.value = contact.name || '';
            if (nicknameInput) nicknameInput.value = contact.nickname || '';
            if (emailInput) emailInput.value = contact.email || '';
            editModal.classList.add('show');
            console.log('[MailinkSender] Modal shown');
        }
    }

    _openInbox() {
        // Find or create inbox panel
        let inboxPanel = document.getElementById('globalInboxPanel');
        if (!inboxPanel) {
            inboxPanel = document.createElement('mailink-inbox-panel');
            inboxPanel.id = 'globalInboxPanel';
            document.body.appendChild(inboxPanel);
        }
        if (inboxPanel) {
            // If panel is minimized, restore to default size first
            if (inboxPanel._isMinimized) {
                console.log('[MailinkSender] Mailbox panel is minimized, Restore first');
                inboxPanel._restorePosition();
                inboxPanel._isMinimized = false;
                const panel = inboxPanel._shadow?.querySelector('.inbox-panel');
                if (panel) {
                    panel.classList.remove('minimized', 'minimized-dragged');
                }
            }
            if (typeof inboxPanel.show === 'function') {
                inboxPanel.show();
            } else {
                console.warn('[MailinkSender] Mailbox panel show Method unavailable');
            }
        } else {
            console.warn('[MailinkSender] Mailbox panel not found or unavailable');
        }
    }

    showStatus(message, type = 'info') {
        const statusArea = this.shadowRoot.getElementById('statusArea');
        if (statusArea) {
            statusArea.innerHTML = `<span class="status status-${type} status-animation">${message}</span>`;
            setTimeout(() => {
                statusArea.innerHTML = '';
            }, 2000);
        }
    }

    showConfigSelectionPrompt() {
        this.dispatchEvent(new CustomEvent('showConfigSelectionPrompt', {
            bubbles: true,
            composed: true
        }));
    }
}

customElements.define('mailink-sender', MailinkSender);
