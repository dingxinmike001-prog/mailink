/**
 * Email Details Component
 * Displays the detailed information of a specific email, floating at the top in a popup
 *
 * Integrated with the file display component library, supporting independent component display of attachments
 */

import {
  registerAllComponents,
  createFileDisplayComponent,
  createEmailAttachmentComponent,
  isImageFile
} from '../components/file-display/index.js?v=3';
import '../email-compose-component/index.js';
import { playCloseAnimation, playOpenAnimation } from '../shared/close-animation.js';

async function loadTemplate() {
    try {
        const htmlUrl = new URL('./email-detail.html', import.meta.url).href;
        const response = await fetch(htmlUrl);
        if (response.ok) {
            return await response.text();
        }
        console.warn('[MailinkEmailDetail] Failed to load HTML template');
        return '';
    } catch (error) {
        console.warn('[MailinkEmailDetail] Error loading HTML template:', error);
        return '';
    }
}

export class MailinkEmailDetail extends HTMLElement {
    constructor() {
        super();
        this._shadow = null;
        this._email = null;
        this._isLoading = false;
        this._isVisible = false;
        this._isMaximized = false;
        this._isDragging = false;
        this._dragOffset = { x: 0, y: 0 };
        this._modalPosition = { x: 0, y: 0 };
        this._composeComponent = null;
        // Initialize the Promise mechanism
        this._isInitialized = false;
        this._initPromise = null;
        // Batch marking as read buffering mechanism
        this._pendingMarkAsRead = {
            emailIds: [],
            timer: null,
            imapConfig: null
        };
    }

    async connectedCallback() {
        if (this._shadow) return;

        // Create an initialized Promise
        this._initPromise = this._initialize();
        await this._initPromise;
    }

    async _initialize() {
        // Create Shadow DOM
        this._shadow = this.attachShadow({ mode: 'open' });

        // Load CSS and HTML
        const [cssContent, htmlContent] = await Promise.all([
            this._loadCSS(),
            loadTemplate()
        ]);

        // Create style element
        const styleElement = document.createElement('style');
        styleElement.textContent = cssContent;
        this._shadow.appendChild(styleElement);

        // Add template content
        const templateElement = document.createElement('template');
        templateElement.innerHTML = htmlContent;
        this._shadow.appendChild(templateElement.content.cloneNode(true));

        if (window.i18n?.registerRoot) window.i18n.registerRoot(this.shadowRoot);
        
        // Wait for i18n to be ready before initializing translation to avoid timing issues
        if (window.i18n?.whenReady) {
            await window.i18n.whenReady();
        }
        if (window.i18n?.initElements) window.i18n.initElements(this.shadowRoot);

        // Bind events
        this._bindEvents();

        this._handleLangChanged = () => {
            if (window.i18n?.initElements) window.i18n.initElements(this.shadowRoot);
        };
        document.addEventListener('lang-changed', this._handleLangChanged);

        // Register file display component
        await this._registerFileDisplayComponents();

        // Create writing component
        this._createComposeComponent();

        this._isInitialized = true;
        console.log('[MailinkEmailDetail] Component initialized');
    }

    /**
     * Register file display component
     * @private
     */
    async _registerFileDisplayComponents() {
        try {
            await registerAllComponents();
            console.log('[MailinkEmailDetail] File display components registered successfully');
        } catch (error) {
            console.error('[MailinkEmailDetail] Failed to register file display components:', error);
        }
    }

    async _loadCSS() {
        try {
            const cssUrl = new URL('./email-detail.css', import.meta.url).href;
            const response = await fetch(cssUrl);
            if (response.ok) {
                return await response.text();
            }
            console.warn('[MailinkEmailDetail] Failed to load CSS');
            return '';
        } catch (error) {
            console.warn('[MailinkEmailDetail] Error loading CSS:', error);
            return '';
        }
    }

    _bindEvents() {
        // Bind click event to popup and check position constraints
        const modal = this._shadow.getElementById('modal');
        if (modal) {
            modal.addEventListener('click', () => {
                this._enforcePositionLimit();
            });
        }

        // Maximize/Restore button
        const maximizeBtn = this._shadow.getElementById('maximizeBtn');
        if (maximizeBtn) {
            maximizeBtn.addEventListener('click', () => {
                this.toggleMaximize();
            });
        }

        // Close button
        const closeBtn = this._shadow.getElementById('closeBtn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.close();
            });
        }

        // Reply button
        const replyBtn = this._shadow.getElementById('replyBtn');
        if (replyBtn) {
            replyBtn.addEventListener('click', () => {
                this._handleReplyClick();
            });
        }

        // Click the overlay to close
        const overlay = this._shadow.getElementById('overlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.close();
                }
            });
        }

        // Close on ESC key
        this._handleEscKey = (e) => {
            if (e.key === 'Escape' && this._isVisible) {
                this.close();
            }
        };
        document.addEventListener('keydown', this._handleEscKey);

        // Bind title bar drag event
        this._bindDragEvents();
    }

    /**
     * Bind title bar drag event
     */
    _bindDragEvents() {
        const modalHeader = this._shadow.getElementById('modalHeader');
        if (!modalHeader) return;

        // Start dragging when the mouse is pressed
        modalHeader.addEventListener('mousedown', (e) => {
            // If a button is clicked, do not start dragging
            if (e.target.closest('button')) return;
            // Cannot be dragged when maximized
            if (this._isMaximized) return;

            this._isDragging = true;
            const modal = this._shadow.getElementById('modal');
            
            // Get the current popup position
            const rect = modal.getBoundingClientRect();
            this._dragOffset = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };

            // Add drag style
            modal.classList.add('dragging');

            // Prevent text selection
            e.preventDefault();
        });

        // Drag when the mouse moves
        this._handleMouseMove = (e) => {
            if (!this._isDragging) return;

            const modal = this._shadow.getElementById('modal');
            const overlay = this._shadow.getElementById('overlay');

            // Calculate new position
            const overlayRect = overlay.getBoundingClientRect();
            let newX = e.clientX - overlayRect.left - this._dragOffset.x;
            let newY = e.clientY - overlayRect.top - this._dragOffset.y;

            // Get popup size
            const modalRect = modal.getBoundingClientRect();
            const modalWidth = modalRect.width;
            const modalHeight = modalRect.height;
            const overlayWidth = overlayRect.width;
            const overlayHeight = overlayRect.height;

            // Title bar height is 32px; restrict top from crossing title bar
            const titlebarHeight = 32;

            // Limit drag range: left/right/bottom cannot exceed the application boundary, the top cannot go beyond the title bar
            // Left: Cannot exceed the left boundary of the overlay
            newX = Math.max(0, newX);
            // Right side: cannot exceed the right boundary of the overlay
            newX = Math.min(newX, overlayWidth - modalWidth);
            // Top: Cannot go over the title bar
            newY = Math.max(titlebarHeight, newY);
            // Below: cannot exceed the bottom boundary of the overlay
            newY = Math.min(newY, overlayHeight - modalHeight);

            // Application Location
            modal.style.position = 'absolute';
            modal.style.left = `${newX}px`;
            modal.style.top = `${newY}px`;
            modal.style.transform = 'none';
            modal.style.margin = '0';

            this._modalPosition = { x: newX, y: newY };
        };

        // Mouse release ends dragging
        this._handleMouseUp = () => {
            if (!this._isDragging) return;
            
            this._isDragging = false;
            const modal = this._shadow.getElementById('modal');
            if (modal) {
                modal.classList.remove('dragging');
            }
        };

        // Bind to document so that dragging can be stopped even when released outside the popup
        document.addEventListener('mousemove', this._handleMouseMove);
        document.addEventListener('mouseup', this._handleMouseUp);
    }

    /**
     * Create writing component
     */
    _createComposeComponent() {
        if (this._composeComponent) return;

        this._composeComponent = document.createElement('mailink-email-compose');
        document.body.appendChild(this._composeComponent);

        // Listen for email sent success event
        this._composeComponent.addEventListener('emailSent', (e) => {
            if (e.detail.success) {
                console.log('[MailinkEmailDetail] Email sent successfully:', e.detail);
            }
        });

        // Listen for the close event of the writing component
        this._composeComponent.addEventListener('composeClosed', () => {
            console.log('[MailinkEmailDetail] Compose component closed');
        });
    }

    /**
     * Handle reply button click
     */
    _handleReplyClick() {
        if (!this._email) {
            console.warn('[MailinkEmailDetail] No email to reply to');
            return;
        }

        // Get the complete email detail data
        const emailData = this._getEmailDataForCompose();

        // Display writing component
        if (this._composeComponent) {
            this._composeComponent.showCompose(emailData);
        }

        // Automatically close the mail details component (with animation)
        this.close();
    }

    /**
     * Get the email data used for composing
     */
    _getEmailDataForCompose() {
        // Extract data from the currently displayed email details
        const fromField = this._shadow.getElementById('fromField');
        const toField = this._shadow.getElementById('toField');
        const subjectField = this._shadow.getElementById('subjectField');
        const dateField = this._shadow.getElementById('dateField');
        const contentBody = this._shadow.getElementById('contentBody');

        return {
            from: fromField ? fromField.textContent : (this._email.from || ''),
            to: toField ? toField.textContent : (this._email.to || ''),
            subject: subjectField ? subjectField.textContent : (this._email.subject || ''),
            date: this._email.date || (dateField ? dateField.textContent : ''),
            html: this._email.html || '',
            text: this._email.text || (contentBody ? contentBody.innerText : '')
        };
    }

    /**
     * Show email detail popup
     * @param {Object} email - Basic email information (from the email list)
     */
    async showEmail(email) {
        console.warn('[MailinkEmailDetail] showEmail called, email:', email?.subject, 'UID:', email?.uid);
        
        if (!email) {
            console.warn('[MailinkEmailDetail] Invalid email data');
            return;
        }

        // Wait for the component to finish initializing
        if (!this._isInitialized) {
            console.log('[MailinkEmailDetail] Waiting for component initialization...');
            await this._initPromise;
        }

        this._email = email;
        this._isVisible = true;

        // Show popup (with animation, maximized by default)
        await this._showModal();
        this.maximize();
        this._showLoading();

        try {
            // Get the full email details
            const detail = await this._fetchEmailDetail(email.uid);
            if (detail) {
                this._renderEmailDetail(detail);
                // If already waiting for download and the details area is already displayed, there is no need to call _showDetail() again
                if (!detail._waitingForDownload) {
                    this._showDetail();
                }

                // Mark the email as read
                await this._markEmailAsRead(email.uid);
            } else {
                this._showError(window.i18n?.t('emailDetail.fetchDetailFailed') || 'Unable to fetch email details');
            }
        } catch (error) {
            console.error('[MailinkEmailDetail] Failed to load email detail:', error);
            this._showError(window.i18n?.t('emailDetail.loadDetailFailed') || 'Failed to load email details');
        }
    }

    /**
     * Mark emails as read (batch buffered version)
     */
    async _markEmailAsRead(emailId) {
        try {
            const config = window.selectedConfig;
            if (!config || !config.username) {
                console.warn('[MailinkEmailDetail] No email config available');
                return;
            }

            // Build IMAP configuration (remove sensitive info like password)
            const imapConfig = {
                username: config.username,
                host: config.host,
                port: config.port,
                tls: config.tls
            };

            // Add to buffer queue
            this._pendingMarkAsRead.emailIds.push(emailId);
            this._pendingMarkAsRead.imapConfig = imapConfig;

            // Trigger the email read event, notify the list and unread count update (update UI immediately)
            this.dispatchEvent(new CustomEvent('emailMarkedAsRead', {
                detail: { emailId, myEmail: config.username },
                bubbles: true,
                composed: true
            }));

            // If there is already a timer, clear it and reset
            if (this._pendingMarkAsRead.timer) {
                clearTimeout(this._pendingMarkAsRead.timer);
            }

            // Set a new timer to batch send after a 300ms delay
            this._pendingMarkAsRead.timer = setTimeout(async () => {
                await this._flushPendingMarkAsRead();
            }, 300);
        } catch (error) {
            console.error('[MailinkEmailDetail] Failed to mark email as read:', error);
        }
    }

    /**
     * Refresh pending batch mark-as-read requests
     */
    async _flushPendingMarkAsRead() {
        const { emailIds, imapConfig } = this._pendingMarkAsRead;
        
        if (emailIds.length === 0 || !imapConfig) {
            return;
        }

        try {
            const config = window.selectedConfig;
            if (!config || !config.username) {
                return;
            }

            // Clear buffer
            this._pendingMarkAsRead.emailIds = [];
            this._pendingMarkAsRead.timer = null;

            if (window.electronAPI && window.electronAPI.batchMarkRecvEmailsRead) {
                // Using batch interface
                const result = await window.electronAPI.batchMarkRecvEmailsRead({
                    myEmail: config.username,
                    emailIds: emailIds,
                    imapConfig: imapConfig
                });

                if (result && result.success) {
                    console.log('[MailinkEmailDetail] Batch marked emails as read:', emailIds.length, 'Server synced:', result.serverSyncedCount);
                }
            } else if (window.electronAPI && window.electronAPI.markRecvEmailRead) {
                // Downgrade: send one by one
                for (const eid of emailIds) {
                    await window.electronAPI.markRecvEmailRead({
                        myEmail: config.username,
                        emailId: eid,
                        imapConfig: imapConfig
                    });
                }
            }
        } catch (error) {
            console.error('[MailinkEmailDetail] Failed to flush pending mark as read:', error);
        }
    }

    /**
     * Show popup (with animation: zoom in from top-left and fade in)
     */
    async _showModal() {
        const overlay = this._shadow.getElementById('overlay');
        if (overlay) {
            // Clean up residual styles
            overlay.style.opacity = '';
            overlay.style.pointerEvents = '';
            const modal = this._shadow.getElementById('modal');
            if (modal) {
                modal.style.opacity = '';
                modal.style.transform = '';
                modal.style.transformOrigin = '';
            }
            overlay.classList.add('show');
            // Play open animation
            await playOpenAnimation(overlay, '#modal');
        }
    }

    /**
     * Hide popup
     */
    _hideModal() {
        const overlay = this._shadow.getElementById('overlay');
        if (overlay) {
            overlay.classList.remove('show');
        }
    }

    /**
     * Toggle maximize/restore
     */
    toggleMaximize() {
        if (this._isMaximized) {
            this.restore();
        } else {
            this.maximize();
        }
    }

    /**
     * Maximize popup
     */
    maximize() {
        const modal = this._shadow.getElementById('modal');
        const maximizeBtn = this._shadow.getElementById('maximizeBtn');
        const overlay = this._shadow.getElementById('overlay');

        if (!modal) return;

        // Add maximize style
        modal.classList.add('maximized');

        // Update button icon
        if (maximizeBtn) {
            maximizeBtn.classList.add('restore');
            maximizeBtn.title = window.i18n?.t('common.restore') || 'Restore';
        }

        // Remove the padding of the mask layer so that the popup occupies the full screen
        if (overlay) {
            overlay.style.padding = '0';
        }

        this._isMaximized = true;
        console.log('[MailinkEmailDetail] Maximized');
    }

    /**
     * Restore popup
     */
    restore() {
        const modal = this._shadow.getElementById('modal');
        const maximizeBtn = this._shadow.getElementById('maximizeBtn');
        const overlay = this._shadow.getElementById('overlay');

        if (!modal) return;

        // Remove maximized style
        modal.classList.remove('maximized');

        // Update button icon
        if (maximizeBtn) {
            maximizeBtn.classList.remove('restore');
            maximizeBtn.title = window.i18n?.t('common.maximize') || 'Maximize';
        }

        // Restore the padding of the mask layer
        if (overlay) {
            overlay.style.padding = '20px';
        }

        // Reset popup position
        modal.style.position = '';
        modal.style.left = '';
        modal.style.top = '';
        modal.style.transform = '';
        modal.style.margin = '';
        this._modalPosition = { x: 0, y: 0 };

        this._isMaximized = false;
        console.log('[MailinkEmailDetail] Restored');
    }

    /**
     * Get email details
     */
    /**
     * Get global download state manager (supports event notifications)
     */
    _getDownloadManager() {
        if (!window._mailinkDownloadManager) {
            window._mailinkDownloadManager = {
                downloadingEmails: new Set(),
                _listeners: new Map(), // emailId -> Set of callbacks
                
                // Subscribe to download completion event
                subscribe(emailId, callback) {
                    if (!this._listeners.has(emailId)) {
                        this._listeners.set(emailId, new Set());
                    }
                    this._listeners.get(emailId).add(callback);
                },
                
                // Unsubscribe
                unsubscribe(emailId, callback) {
                    if (this._listeners.has(emailId)) {
                        this._listeners.get(emailId).delete(callback);
                        if (this._listeners.get(emailId).size === 0) {
                            this._listeners.delete(emailId);
                        }
                    }
                },
                
                // Notify download complete
                notifyComplete(emailId, success) {
                    if (this._listeners.has(emailId)) {
                        const callbacks = this._listeners.get(emailId);
                        callbacks.forEach(callback => {
                            try {
                                callback(success);
                            } catch (e) {
                                console.error('[DownloadManager] Listener error:', e);
                            }
                        });
                        this._listeners.delete(emailId);
                    }
                    this.downloadingEmails.delete(emailId);
                }
            };
        }
        return window._mailinkDownloadManager;
    }

    async _fetchEmailDetail(emailId) {
        try {
            const config = window.selectedConfig;
            if (!config) {
                console.warn('[MailinkEmailDetail] No email config available');
                return null;
            }

            if (window.electronAPI && window.electronAPI.getLocalEmailDetail) {
                let detail = await window.electronAPI.getLocalEmailDetail({
                    username: config.username,
                    emailId: emailId
                });

                // If the main content is not loaded (both text and html are empty), and there is an imap_uid, automatically load the main content
                if (detail && 
                    ((detail.text === '' || detail.text === null || detail.text === undefined) && 
                     (detail.html === '' || detail.html === null || detail.html === undefined)) && 
                    window.electronAPI.fetchEmailBody && 
                    detail.imap_uid) {
                    const emailIdStr = String(emailId);
                    const downloadManager = this._getDownloadManager();
                    
                    // Check if it is already downloading (to prevent duplicate downloads)
                    if (downloadManager.downloadingEmails.has(emailIdStr)) {
                        console.log('[MailinkEmailDetail] Email body already downloading, waiting for completion...');
                        detail.text = window.i18n?.t('emailDetail.loadingBody') || 'Loading email body...';
                        // Add a flag to tell _renderEmailDetail not to overwrite contentBody
                        detail._waitingForDownload = true;
                        
                        const self = this;
                        const targetEmailId = self._email ? self._email.uid : null;
                        const contentBody = self._shadow.getElementById('contentBody');
                        
                        // First display the details area (otherwise the CSS animation won't be visible)
                        const loadingState = self._shadow.getElementById('loadingState');
                        const detailBody = self._shadow.getElementById('detailBody');
                        const emptyState = self._shadow.getElementById('emptyState');
                        if (loadingState) loadingState.style.display = 'none';
                        if (detailBody) detailBody.style.display = 'flex';
                        if (emptyState) emptyState.style.display = 'none';
                        
                        // Show loading state
                        if (contentBody) {
                            contentBody.innerHTML = `
                                <div class="email-loading-wrapper">
                                    <p class="email-loading-text" style="color: #1890ff; font-weight: 600;">${window.i18n?.t('emailDetail.loadingBody') || 'Loading email body...'}</p>
                                    <div class="email-loading-dots">
                                        <div class="email-loading-dot"></div>
                                        <div class="email-loading-dot"></div>
                                        <div class="email-loading-dot"></div>
                                    </div>
                                </div>
                            `;
                            console.log('[MailinkEmailDetail] Loading content set, contentBody.innerHTML:', contentBody.innerHTML);
                        }
                        
                        // Timeout timer (2 minutes)
                        let timeoutId = null;
                        
                        // Download complete callback
                        const onDownloadComplete = async (success) => {
                            // Clear timeout timer
                            if (timeoutId) {
                                clearTimeout(timeoutId);
                                timeoutId = null;
                            }
                            
                            // Check if the email has switched
                            if (!self._email || self._email.uid !== targetEmailId) {
                                console.log('[MailinkEmailDetail] Email changed while waiting, aborting');
                                return;
                            }
                            
                            if (success) {
                                // Download successful, retrieve the latest data from the database
                                const updatedDetail = await window.electronAPI.getLocalEmailDetail({
                                    username: config.username,
                                    emailId: emailId
                                });
                                
                                if (updatedDetail && 
                                    ((updatedDetail.text !== '' && updatedDetail.text !== null && updatedDetail.text !== undefined) || 
                                     (updatedDetail.html !== '' && updatedDetail.html !== null && updatedDetail.html !== undefined))) {
                                    // Display content
                                    detail.html = updatedDetail.html;
                                    detail.text = updatedDetail.text;
                                    if (updatedDetail.attachments) {
                                        detail.attachments = updatedDetail.attachments;
                                    }
                                    if (contentBody) {
                                        contentBody.innerHTML = self._formatContent(detail);
                                        self._renderAttachments(detail.attachments || [], detail.imap_uid || detail.id, detail.id);
                                    }
                                } else {
                                    // Data not updated, start a new download
                                    console.log('[MailinkEmailDetail] Download success but data not updated, starting new download');
                                    startNewDownload();
                                }
                            } else {
                                // Download failed, start a new download
                                console.log('[MailinkEmailDetail] Download failed, starting new download');
                                startNewDownload();
                            }
                        };
                        
                        const startNewDownload = () => {
                            downloadManager.downloadingEmails.add(emailIdStr);
                            
                            const maxRetries = 3;
                            const retryDelay = 5000;
                            let retryCount = 0;
                            
                            const self = this;
                            
                            // Save target email ID for later verification
                            const targetEmailId = self._email ? self._email.uid : null;
                            
                            const downloadWithRetry = async () => {
                                // Verify current email is still the target email
                                if (!self._email || self._email.uid !== targetEmailId) {
                                    console.log('[MailinkEmailDetail] Email changed during body download, aborting');
                                    downloadManager.notifyComplete(emailIdStr, false);
                                    return;
                                }
                                
                                const contentBody = self._shadow.getElementById('contentBody');
                                if (!contentBody) {
                                    downloadManager.notifyComplete(emailIdStr, false);
                                    return;
                                }
                                
                                const displayLoading = (text, retryInfo = null) => {
                                    let retryHtml = '';
                                    if (retryInfo) {
                                        const { current, max, waitSeconds } = retryInfo;
                                        const retryLine = window.i18n?.t('emailDetail.retryProgress', { current, max }) || `Retry ${current}/${max}`;
                                        const waitLine = waitSeconds ? (window.i18n?.t('emailDetail.retryWait', { seconds: waitSeconds }) || `, continuing in ${waitSeconds}s...`) : '';
                                        retryHtml = `
                                            <p style="color: #faad14; margin-top: 8px; font-size: 13px;">
                                                ${retryLine}${waitLine}
                                            </p>
                                        `;
                                    }
                                    contentBody.innerHTML = `
                                        <div class="email-loading-wrapper">
                                            <p class="email-loading-text" style="color: #1890ff; font-weight: 600;">${text}</p>
                                            <div class="email-loading-dots">
                                                <div class="email-loading-dot"></div>
                                                <div class="email-loading-dot"></div>
                                                <div class="email-loading-dot"></div>
                                            </div>
                                            ${retryHtml}
                                        </div>
                                    `;
                                };
                                
                                const displayFailure = () => {
                                    contentBody.innerHTML = `
                                        <div style="display: flex; flex-direction: column; align-items: center; padding: 40px 0;">
                                            <p style="color: red; margin-bottom: 10px;">${window.i18n?.t('emailDetail.loadBodyFailed') || 'Failed to load email body'}</p>
                                            <button id="manualRetryBtn" style="color: #1890ff; background: none; border: none; cursor: pointer; text-decoration: underline; font-size: 14px;">
                                                ${window.i18n?.t('emailDetail.retryLoadBody') || 'Click here to manually retry loading body'}
                                            </button>
                                        </div>
                                    `;
                                    
                                    const retryBtn = contentBody.querySelector('#manualRetryBtn');
                                    if (retryBtn) {
                                        retryBtn.addEventListener('click', () => {
                                            retryCount = 0;
                                            downloadWithRetry();
                                        });
                                    }
                                    
                                    downloadManager.notifyComplete(emailIdStr, false);
                                };
                                
                                try {
                                    const currentText = retryCount > 0 ? (window.i18n?.t('emailDetail.retryingLoadBody') || 'Retrying loading body...') : (window.i18n?.t('emailDetail.loadingBody') || 'Loading email body...');
                                    
                                    // Show retry information
                                    if (retryCount > 0) {
                                        const retryInfo = {
                                            current: retryCount,
                                            max: maxRetries,
                                            waitSeconds: Math.ceil(retryDelay / 1000)
                                        };
                                        displayLoading(currentText, retryInfo);
                                        
                                        // Countdown display
                                        let remainingSeconds = Math.ceil(retryDelay / 1000);
                                        const countdownInterval = setInterval(() => {
                                            remainingSeconds--;
                                            if (remainingSeconds > 0 && self._email && self._email.uid === targetEmailId) {
                                                const updatedRetryInfo = {
                                                    current: retryCount,
                                                    max: maxRetries,
                                                    waitSeconds: remainingSeconds
                                                };
                                                displayLoading(currentText, updatedRetryInfo);
                                            } else {
                                                clearInterval(countdownInterval);
                                            }
                                        }, 1000);
                                        
                                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                                        clearInterval(countdownInterval);
                                    } else {
                                        displayLoading(currentText);
                                    }
                                    
                                    const res = await window.electronAPI.fetchEmailBody({
                                        username: config.username,
                                        emailId: emailId,
                                        uid: parseInt(detail.imap_uid, 10),
                                        config: config
                                    });
                                    
                                    if (res && res.success) {
                                        // Fallback strategy: if emailData is missing, try re-reading from database
                                        let bodyData = res.emailData;
                                        if (!bodyData) {
                                            console.warn('[MailinkEmailDetail] fetchEmailBody succeeded but emailData missing, reading from DB as fallback');
                                            try {
                                                const fallbackDetail = await window.electronAPI.getLocalEmailDetail({
                                                    username: config.username,
                                                    emailId: emailId
                                                });
                                                if (fallbackDetail && (fallbackDetail.text || fallbackDetail.html)) {
                                                    bodyData = { text: fallbackDetail.text, html: fallbackDetail.html, attachments: fallbackDetail.attachments };
                                                }
                                            } catch (fbErr) {
                                                console.error('[MailinkEmailDetail] Fallback DB read failed:', fbErr);
                                            }
                                        }

                                        if (bodyData) {
                                            // Verify again current email is still target email (before displaying)
                                            if (!self._email || self._email.uid !== targetEmailId) {
                                                console.log('[MailinkEmailDetail] Email changed during body download, aborting display');
                                                downloadManager.notifyComplete(emailIdStr, false);
                                                return;
                                            }
                                            
                                            detail.html = bodyData.html;
                                            detail.text = bodyData.text;
                                            if (bodyData.attachments) {
                                                detail.attachments = bodyData.attachments;
                                            }
                                            
                                            contentBody.innerHTML = self._formatContent(detail);
                                            self._renderAttachments(detail.attachments || [], detail.imap_uid || detail.id, detail.id);
                                            downloadManager.notifyComplete(emailIdStr, true);
                                        } else {
                                            retryCount++;
                                            if (retryCount <= maxRetries) {
                                                await downloadWithRetry();
                                            } else {
                                                displayFailure();
                                            }
                                        }
                                    } else {
                                        retryCount++;
                                        if (retryCount <= maxRetries) {
                                            await downloadWithRetry();
                                        } else {
                                            displayFailure();
                                        }
                                    }
                                } catch (e) {
                                    console.error('[MailinkEmailDetail] Failed to fetch email body:', e);
                                    retryCount++;
                                    if (retryCount <= maxRetries) {
                                        await downloadWithRetry();
                                    } else {
                                        displayFailure();
                                    }
                                }
                            };
                            
                            setTimeout(downloadWithRetry, 100);
                        };
                        
                        // Subscribe to download completion event
                        downloadManager.subscribe(emailIdStr, onDownloadComplete);
                        
                        // Set timeout protection (2 minutes)
                        timeoutId = setTimeout(() => {
                            console.log('[MailinkEmailDetail] Wait for download timed out, unsubscribing');
                            downloadManager.unsubscribe(emailIdStr, onDownloadComplete);
                            // Start a new download after timeout
                            if (self._email && self._email.uid === targetEmailId) {
                                startNewDownload();
                            }
                        }, 120000);
                    } else {
                        // Not downloading, start downloading normally
                        downloadManager.downloadingEmails.add(emailIdStr);
                        
                        const maxRetries = 3;
                        const retryDelay = 5000;
                        let retryCount = 0;
                        
                        const self = this;
                        
                        // Save target email ID for later verification
                        const targetEmailId = self._email ? self._email.uid : null;
                        
                        const downloadWithRetry = async () => {
                            // Verify current email is still the target email
                            if (!self._email || self._email.uid !== targetEmailId) {
                                console.log('[MailinkEmailDetail] Email changed during body download, aborting');
                                downloadManager.notifyComplete(emailIdStr, false);
                                return;
                            }
                            
                            const contentBody = self._shadow.getElementById('contentBody');
                            if (!contentBody) {
                                downloadManager.notifyComplete(emailIdStr, false);
                                return;
                            }
                            
                            const displayLoading = (text, retryInfo = null) => {
                                let retryHtml = '';
                                if (retryInfo) {
                                    const { current, max, waitSeconds } = retryInfo;
                                    const retryLine = window.i18n?.t('emailDetail.retryProgress', { current, max }) || `Retry ${current}/${max}`;
                                    const waitLine = waitSeconds ? (window.i18n?.t('emailDetail.retryWait', { seconds: waitSeconds }) || `, continuing in ${waitSeconds}s...`) : '';
                                    retryHtml = `
                                        <p style="color: #faad14; margin-top: 8px; font-size: 13px;">
                                            ${retryLine}${waitLine}
                                        </p>
                                    `;
                                }
                                contentBody.innerHTML = `
                                    <div class="email-loading-wrapper">
                                        <p class="email-loading-text">${text}</p>
                                        <div class="email-loading-dots">
                                            <div class="email-loading-dot"></div>
                                            <div class="email-loading-dot"></div>
                                            <div class="email-loading-dot"></div>
                                        </div>
                                        ${retryHtml}
                                    </div>
                                `;
                            };
                            
                            const displayFailure = () => {
                                contentBody.innerHTML = `
                                    <div style="display: flex; flex-direction: column; align-items: center; padding: 40px 0;">
                                        <p style="color: red; margin-bottom: 10px;">${window.i18n?.t('emailDetail.loadBodyFailed') || 'Failed to load email body'}</p>
                                        <p style="color: #666; margin-bottom: 15px; font-size: 13px;">${window.i18n?.t('emailDetail.autoRetryExhausted', { count: maxRetries }) || `Auto-retried ${maxRetries} times`}</p>
                                        <button id="manualRetryBtn" style="color: #1890ff; background: none; border: none; cursor: pointer; text-decoration: underline; font-size: 14px;">
                                            ${window.i18n?.t('emailDetail.retryLoadBody') || 'Click here to manually retry loading body'}
                                        </button>
                                    </div>
                                `;
                                
                                const retryBtn = contentBody.querySelector('#manualRetryBtn');
                                if (retryBtn) {
                                    retryBtn.addEventListener('click', () => {
                                        retryCount = 0;
                                        downloadWithRetry();
                                    });
                                }
                                
                                downloadManager.notifyComplete(emailIdStr, false);
                            };
                            
                            try {
                                const currentText = retryCount > 0 ? (window.i18n?.t('emailDetail.retryingLoadBody') || 'Retrying loading body...') : (window.i18n?.t('emailDetail.loadingBody') || 'Loading email body...');
                                
                                // Show retry information
                                if (retryCount > 0) {
                                    const retryInfo = {
                                        current: retryCount,
                                        max: maxRetries,
                                        waitSeconds: Math.ceil(retryDelay / 1000)
                                    };
                                    displayLoading(currentText, retryInfo);
                                    
                                    // Countdown display
                                    let remainingSeconds = Math.ceil(retryDelay / 1000);
                                    const countdownInterval = setInterval(() => {
                                        remainingSeconds--;
                                        if (remainingSeconds > 0 && self._email && self._email.uid === targetEmailId) {
                                            const updatedRetryInfo = {
                                                current: retryCount,
                                                max: maxRetries,
                                                waitSeconds: remainingSeconds
                                            };
                                            displayLoading(currentText, updatedRetryInfo);
                                        } else {
                                            clearInterval(countdownInterval);
                                        }
                                    }, 1000);
                                    
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                    clearInterval(countdownInterval);
                                } else {
                                    displayLoading(currentText);
                                }
                                
                                const res = await window.electronAPI.fetchEmailBody({
                                    username: config.username,
                                    emailId: emailId,
                                    uid: parseInt(detail.imap_uid, 10),
                                    config: config
                                });
                                
                                if (res && res.success) {
                                    // Fallback strategy: if emailData is missing, try re-reading from database
                                    let bodyData = res.emailData;
                                    if (!bodyData) {
                                        console.warn('[MailinkEmailDetail] fetchEmailBody succeeded but emailData missing, reading from DB as fallback');
                                        try {
                                            const fallbackDetail = await window.electronAPI.getLocalEmailDetail({
                                                username: config.username,
                                                emailId: emailId
                                            });
                                            if (fallbackDetail && (fallbackDetail.text || fallbackDetail.html)) {
                                                bodyData = { text: fallbackDetail.text, html: fallbackDetail.html, attachments: fallbackDetail.attachments };
                                            }
                                        } catch (fbErr) {
                                            console.error('[MailinkEmailDetail] Fallback DB read failed:', fbErr);
                                        }
                                    }

                                    if (bodyData) {
                                        // Verify again current email is still target email (before displaying)
                                        if (!self._email || self._email.uid !== targetEmailId) {
                                            console.log('[MailinkEmailDetail] Email changed during body download, aborting display');
                                            downloadManager.notifyComplete(emailIdStr, false);
                                            return;
                                        }
                                        
                                        detail.html = bodyData.html;
                                        detail.text = bodyData.text;
                                        if (bodyData.attachments) {
                                            detail.attachments = bodyData.attachments;
                                        }
                                        
                                        contentBody.innerHTML = self._formatContent(detail);
                                        self._renderAttachments(detail.attachments || [], detail.imap_uid || detail.id, detail.id);
                                        downloadManager.notifyComplete(emailIdStr, true);
                                    } else {
                                        retryCount++;
                                        if (retryCount <= maxRetries) {
                                            await downloadWithRetry();
                                        } else {
                                            displayFailure();
                                        }
                                    }
                                } else {
                                    retryCount++;
                                    if (retryCount <= maxRetries) {
                                        await downloadWithRetry();
                                    } else {
                                        displayFailure();
                                    }
                                }
                            } catch (e) {
                                console.error('[MailinkEmailDetail] Failed to fetch email body:', e);
                                retryCount++;
                                if (retryCount <= maxRetries) {
                                    await downloadWithRetry();
                                } else {
                                    displayFailure();
                                }
                            }
                        };
                        
                        setTimeout(downloadWithRetry, 100);
                    }
                }

                return detail;
            }
            return null;
        } catch (error) {
            console.error('[MailinkEmailDetail] Failed to fetch email detail:', error);
            return null;
        }
    }

    /**
     * Render email details
     */
    _renderEmailDetail(email) {
        console.warn('[MailinkEmailDetail] _renderEmailDetail called, email ID:', email.id, 'attachment count:', email.attachments?.length);
        
        // Sender
        const fromField = this._shadow.getElementById('fromField');
        if (fromField) {
            fromField.textContent = email.from || (window.i18n?.t('common.unknownSender') || 'Unknown sender');
        }

        // Recipient - Shows the email address of the currently logged-in IMAP user
        const toField = this._shadow.getElementById('toField');
        if (toField) {
            const config = window.selectedConfig;
            toField.textContent = config && config.username ? config.username : (email.to || '');
        }

        // Theme
        const subjectField = this._shadow.getElementById('subjectField');
        if (subjectField) {
            subjectField.textContent = email.subject || (window.i18n?.t('common.noSubject') || '(no subject)');
        }

        // Time
        const dateField = this._shadow.getElementById('dateField');
        if (dateField) {
            dateField.textContent = this._formatDate(email.date);
        }

        // Attachment - Pass the email UID for download, while also passing the email database ID
        this._renderAttachments(email.attachments || [], email.uid || email.id, email.id);

        // Main text - If waiting for the download to complete, do not overwrite the loading content we have set
        const contentBody = this._shadow.getElementById('contentBody');
        if (contentBody && !email._waitingForDownload) {
            contentBody.innerHTML = this._formatContent(email);
        }
    }

    /**
     * Render attachment list
     * Use the email attachment display component to show attachment metadata (without downloading the actual files)
     */
    async _renderAttachments(attachments, emailUid, emailDbId) {
        console.warn('[MailinkEmailDetail] _renderAttachmentscalled, Attachment count:', attachments.length, 'emailUid:', emailUid, 'emailDbId:', emailDbId);
        
        const attachmentsSection = this._shadow.getElementById('attachmentsSection');
        const attachmentsCount = this._shadow.getElementById('attachmentsCount');
        const attachmentsList = this._shadow.getElementById('attachmentsList');

        if (!attachmentsSection || !attachmentsCount || !attachmentsList) {
            console.warn('[MailinkEmailDetail] attachmentDOMElement not found');
            return;
        }

        if (attachments.length === 0) {
            console.log('[MailinkEmailDetail] Attachment list is empty');
            attachmentsSection.style.display = 'none';
            return;
        }

        attachmentsSection.style.display = 'block';
        attachmentsCount.textContent = window.i18n?.t('emailDetail.attachmentCount', { count: attachments.length }) || `${attachments.length} item(s)`;

        // Clear the attachment list
        attachmentsList.innerHTML = '';

        // Get the current user's configuration information
        const config = window.selectedConfig;
        const username = config?.username || '';
        const imapConfig = config ? {
            username: config.username,
            password: config.password,
            host: config.host,
            port: config.port,
            tls: config.tls
        } : null;

        // Create an email attachment display component for each attachment
        for (const attachment of attachments) {
            try {
                // Debug log: Checking attachment data
                console.warn('[MailinkEmailDetail] Render attachment:', attachment.filename, 'downloaded:', attachment.downloaded, 'localPath:', attachment.localPath);
                
                // Use the new email attachment display component, passing the complete attachment data (including download status)
                const component = await createEmailAttachmentComponent({
                    filename: attachment.filename || (window.i18n?.t('emailDetail.unnamed') || 'unnamed'),
                    contentType: attachment.contentType || this._getMimeTypeFromFilename(attachment.filename),
                    size: attachment.size || 0,
                    downloaded: attachment.downloaded || false,
                    localPath: attachment.localPath || null
                });

                // Set the context information required for downloading (including the database ID)
                if (component.setEmailContext) {
                    component.setEmailContext(emailUid, username, imapConfig, emailDbId);
                }

                // Initialize the component and verify the downloaded files (if needed)
                // ✅ Improvement: Call the full init() method instead of initDownloadStatus()
                // init() will automatically call render()
                if (component.init) {
                    await component.init(attachment);
                }

                // Container for packaging components
                const wrapper = document.createElement('div');
                wrapper.className = 'attachment-item-component';
                wrapper.appendChild(component);
                attachmentsList.appendChild(wrapper);

            } catch (error) {
                console.error('[MailinkEmailDetail] Failed to create attachment component:', error);
                // Downgrade to traditional display method
                this._renderAttachmentLegacy(attachment, attachmentsList);
            }
        }
    }

    /**
     * Create component context
     * @private
     */
    _createComponentContext() {
        return {
            logger: console,
            utils: {
                formatBytes: (bytes) => this._formatFileSize(bytes)
            },
            myEmail: 'user@example.com',  // Can be retrieved from email data
            targetEmail: this._email?.from || 'sender@example.com',
            shadowRoot: this._shadow,
            root: this._shadow
        };
    }

    /**
     * Handle attachment operation events
     * @private
     */
    _handleAttachmentAction(action, filePath, attachment) {
        switch (action) {
            case 'open-folder':
                if (filePath && window.electronAPI?.openFileLocation) {
                    window.electronAPI.openFileLocation(filePath);
                }
                break;
            case 'save-as':
                if (filePath && window.electronAPI?.showSaveDialog) {
                    window.electronAPI.showSaveDialog({
                        defaultPath: attachment.filename,
                        filters: [{ name: window.i18n?.t('emailDetail.allFiles') || 'All files', extensions: ['*'] }]
                    }).then(result => {
                        if (!result.canceled && result.filePath) {
                            window.electronAPI?.copyFile?.(filePath, result.filePath);
                        }
                    });
                }
                break;
        }
    }

    /**
     * Get MIME type based on file name
     * @private
     */
    _getMimeTypeFromFilename(filename) {
        if (!filename) return 'application/octet-stream';
        const ext = filename.split('.').pop()?.toLowerCase();
        const mimeMap = {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'pdf': 'application/pdf',
            'txt': 'text/plain',
            'doc': 'application/msword',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xls': 'application/vnd.ms-excel',
            'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'mp4': 'video/mp4',
            'mp3': 'audio/mpeg'
        };
        return mimeMap[ext] || 'application/octet-stream';
    }

    /**
     * Render attachment (fallback solution)
     * @private
     */
    _renderAttachmentLegacy(attachment, container) {
        const item = document.createElement('div');
        item.className = 'attachment-item';
        item.innerHTML = `
            <span class="attachment-icon">${this._getAttachmentIcon(attachment.filename)}</span>
            <div class="attachment-info">
                <div class="attachment-name" title="${attachment.filename || (window.i18n?.t('emailDetail.unnamed') || 'unnamed')}">${attachment.filename || (window.i18n?.t('emailDetail.unnamed') || 'unnamed')}</div>
                <div class="attachment-size">${this._formatFileSize(attachment.size)}</div>
            </div>
        `;
        container.appendChild(item);
    }

    /**
     * Get attachment icon
     */
    _getAttachmentIcon(filename) {
        if (!filename) return '📎';
        
        const ext = filename.split('.').pop().toLowerCase();
        const iconMap = {
            'pdf': '📄',
            'doc': '📝',
            'docx': '📝',
            'xls': '📊',
            'xlsx': '📊',
            'ppt': '📊',
            'pptx': '📊',
            'txt': '📃',
            'jpg': '🖼️',
            'jpeg': '🖼️',
            'png': '🖼️',
            'gif': '🖼️',
            'bmp': '🖼️',
            'zip': '📦',
            'rar': '📦',
            '7z': '📦',
            'mp3': '🎵',
            'mp4': '🎬',
            'avi': '🎬',
            'mov': '🎬',
            'exe': '⚙️'
        };
        
        return iconMap[ext] || '📎';
    }

    /**
     * Format file size
     */
    _formatFileSize(bytes) {
        if (!bytes || bytes === 0) return window.i18n?.t('emailDetail.unknownSize') || 'unknown size';
        
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
    }

    /**
     * Format email content
     */
    _formatContent(email) {
        // Prefer displaying HTML content
        if (email.html) {
            // Clean HTML to prevent XSS
            return this._sanitizeHtml(email.html);
        }
        
        // Display plain text content
        if (email.text) {
            return `<pre>${this._escapeHtml(email.text)}</pre>`;
        }
        
        return `<p style="color: #8c8c8c;">${window.i18n?.t('emailDetail.noContent') || '（no body content）'}</p>`;
    }

    /**
     * Clean HTML content
     */
    _sanitizeHtml(html) {
        if (!html) return '';
        
        // Create DOM parser
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // Remove dangerous tags
        const dangerousTags = ['script', 'style', 'iframe', 'object', 'embed'];
        dangerousTags.forEach(tag => {
            const elements = doc.getElementsByTagName(tag);
            for (let i = elements.length - 1; i >= 0; i--) {
                elements[i].remove();
            }
        });
        
        // Remove dangerous attributes
        const allElements = doc.getElementsByTagName('*');
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const attrs = el.attributes;
            for (let j = attrs.length - 1; j >= 0; j--) {
                const attr = attrs[j];
                if (attr.name.startsWith('on') || attr.value.startsWith('javascript:')) {
                    el.removeAttribute(attr.name);
                }
            }
        }
        
        return doc.body.innerHTML;
    }

    /**
     * Escape HTML special characters
     */
    _escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Format date
     */
    _formatDate(date) {
        if (!date) return '';

        const d = new Date(date);
        if (isNaN(d.getTime())) return '';

        return d.toLocaleString(window.i18n?.getLocale() || 'zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }

    /**
     * Show loading state
     */
    _showLoading() {
        const loadingState = this._shadow.getElementById('loadingState');
        const detailBody = this._shadow.getElementById('detailBody');
        const emptyState = this._shadow.getElementById('emptyState');

        if (loadingState) loadingState.style.display = 'flex';
        if (detailBody) detailBody.style.display = 'none';
        if (emptyState) emptyState.style.display = 'none';
    }

    /**
     * Display detailed content
     */
    _showDetail() {
        const loadingState = this._shadow.getElementById('loadingState');
        const detailBody = this._shadow.getElementById('detailBody');
        const emptyState = this._shadow.getElementById('emptyState');

        if (loadingState) loadingState.style.display = 'none';
        if (detailBody) detailBody.style.display = 'flex';
        if (emptyState) emptyState.style.display = 'none';
    }

    /**
     * Show empty state
     */
    _showEmpty() {
        const loadingState = this._shadow.getElementById('loadingState');
        const detailBody = this._shadow.getElementById('detailBody');
        const emptyState = this._shadow.getElementById('emptyState');

        if (loadingState) loadingState.style.display = 'none';
        if (detailBody) detailBody.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
    }

    /**
     * Display error message
     */
    _showError(message) {
        const loadingState = this._shadow.getElementById('loadingState');
        const detailBody = this._shadow.getElementById('detailBody');
        const emptyState = this._shadow.getElementById('emptyState');

        if (loadingState) loadingState.style.display = 'none';
        if (detailBody) detailBody.style.display = 'none';
        if (emptyState) {
            emptyState.style.display = 'flex';
            emptyState.innerHTML = `
                <div class="empty-icon">⚠️</div>
                <div class="empty-text" style="color: #ff4d4f;">${message}</div>
            `;
        }
    }

    /**
     * Close the popup with animation (transparent fade and shrink to the upper left corner, truly closes after 0.5 seconds)
     * All close triggers go through here
     */
    async close() {
        const overlay = this._shadow.getElementById('overlay');

        // Play shared close animation (overlay fades out + modal shrinks to top-left)
        if (overlay) {
            await playCloseAnimation(overlay, '#modal');
        }

        // Perform the actual cleanup after the animation ends
        this._isVisible = false;
        this._hideModal();

        // Reset to maximized state when closing (default to maximized next time it opens)
        this.restore();

        this._email = null;

        // Trigger close event
        this.dispatchEvent(new CustomEvent('detailClosed', {
            bubbles: true,
            composed: true
        }));
    }

    /**
     * Get the currently displayed email
     */
    getCurrentEmail() {
        return this._email;
    }

    /**
     * Whether it is displaying
     */
    get isVisible() {
        return this._isVisible;
    }

    /**
     * Whether it is maximized
     */
    get isMaximized() {
        return this._isMaximized;
    }

    disconnectedCallback() {
        if (window.i18n?.unregisterRoot) window.i18n.unregisterRoot(this.shadowRoot);
        if (this._handleLangChanged) {
            document.removeEventListener('lang-changed', this._handleLangChanged);
        }
        if (this._handleEscKey) {
            document.removeEventListener('keydown', this._handleEscKey);
        }
        if (this._handleMouseMove) {
            document.removeEventListener('mousemove', this._handleMouseMove);
        }
        if (this._handleMouseUp) {
            document.removeEventListener('mouseup', this._handleMouseUp);
        }
    }

    /**
     * Enforce position constraints
     * Check and auto-fit constraints on click to ensure component top does not cross title bar
     */
    _enforcePositionLimit() {
        // Do not process when maximized
        if (this._isMaximized) return;

        const modal = this._shadow.getElementById('modal');
        const overlay = this._shadow.getElementById('overlay');
        if (!modal || !overlay) return;

        const titlebarHeight = 32;
        const overlayRect = overlay.getBoundingClientRect();
        const modalRect = modal.getBoundingClientRect();
        const modalWidth = modalRect.width;
        const modalHeight = modalRect.height;
        const overlayWidth = overlayRect.width;
        const overlayHeight = overlayRect.height;
        let needsUpdate = false;
        let newX = this._modalPosition.x;
        let newY = this._modalPosition.y;

        // Check if top exceeds title bar
        if (modalRect.top < titlebarHeight) {
            newY = titlebarHeight - overlayRect.top;
            needsUpdate = true;
        }

        // Check if left side exceeds boundary
        if (modalRect.left < overlayRect.left) {
            newX = 0;
            needsUpdate = true;
        }

        // Check if right side exceeds boundary
        if (modalRect.right > overlayRect.right) {
            newX = overlayWidth - modalWidth;
            needsUpdate = true;
        }

        // Check if bottom exceeds boundary
        if (modalRect.bottom > overlayRect.bottom) {
            newY = overlayHeight - modalHeight;
            needsUpdate = true;
        }

        if (needsUpdate) {
            // Apply new position
            modal.style.position = 'absolute';
            modal.style.left = `${newX}px`;
            modal.style.top = `${newY}px`;
            modal.style.margin = '0';

            // Update location records
            this._modalPosition = { x: newX, y: newY };

            console.log('[MailinkEmailDetail] Position enforced:', { x: newX, y: newY });
        }
    }
}

// Register custom element
if (!customElements.get('mailink-email-detail')) {
    customElements.define('mailink-email-detail', MailinkEmailDetail);
}

export default MailinkEmailDetail;
