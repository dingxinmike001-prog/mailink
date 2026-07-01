/**
 * Email list component
 * Displays a list of emails retrieved via IMAP, including three columns: sender, subject, and time
 */

async function loadTemplate() {
    try {
        const htmlUrl = new URL('./email-list.html', import.meta.url).href;
        const response = await fetch(htmlUrl);
        if (response.ok) {
            return await response.text();
        }
        console.warn('[MailinkEmailList] Failed to load HTML template');
        return '';
    } catch (error) {
        console.warn('[MailinkEmailList] Error loading HTML template:', error);
        return '';
    }
}

export class MailinkEmailList extends HTMLElement {
    constructor() {
        super();
        this._shadow = null;
        this._emails = [];
        this._isLoading = false;
        this._currentPage = 1;
        this._pageSize = 20;
        this._totalEmails = 0;
        this._selectedEmail = null;
        this._selectedEmails = new Set(); // Multi-select state
    }

    /**
     * Log to file
     */
    _log(level, message, category = 'EmailList') {
        if (window.electronAPI && window.electronAPI.log) {
            window.electronAPI.log(level, message, category);
        }
    }

    async connectedCallback() {
        if (this._shadow) return;

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

        if (window.i18n?.registerRoot) window.i18n.registerRoot(this._shadow);
        
        // Wait for i18n to be ready before initializing translation to avoid timing issues
        if (window.i18n?.whenReady) {
            await window.i18n.whenReady();
        }
        if (window.i18n?.initElements) window.i18n.initElements(this._shadow);

        this._onLangChanged = () => {
            if (window.i18n?.initElements) window.i18n.initElements(this._shadow);
            this._renderEmails();
        };
        window.addEventListener('lang-changed', this._onLangChanged);

        // Bind events
        this._bindEvents();

        console.log('[MailinkEmailList] Component initialized');
        this._log('info', '[MailinkEmailList] Component initialized', 'EmailList');
    }

    disconnectedCallback() {
        if (window.i18n?.unregisterRoot) window.i18n.unregisterRoot(this._shadow);
        if (this._onLangChanged) window.removeEventListener('lang-changed', this._onLangChanged);
    }

    async _loadCSS() {
        try {
            const cssUrl = new URL('./email-list.css', import.meta.url).href;
            const response = await fetch(cssUrl);
            if (response.ok) {
                return await response.text();
            }
            console.warn('[MailinkEmailList] Failed to load CSS');
            return '';
        } catch (error) {
            console.warn('[MailinkEmailList] Error loading CSS:', error);
            return '';
        }
    }

    _bindEvents() {
        // Previous page
        const prevBtn = this._shadow.getElementById('prevBtn');
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (this._currentPage > 1) {
                    this._currentPage--;
                    this.fetchEmails();
                }
            });
        }

        // Next page
        const nextBtn = this._shadow.getElementById('nextBtn');
        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                const totalPages = Math.ceil(this._totalEmails / this._pageSize);
                if (this._currentPage < totalPages) {
                    this._currentPage++;
                    this.fetchEmails();
                }
            });
        }

        // Select all checkboxes
        const selectAllCheckbox = this._shadow.getElementById('selectAllCheckbox');
        if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener('change', (e) => {
                this._toggleSelectAll(e.target.checked);
            });
        }
    }

    /**
     * Get email data (from local database)
     */
    async fetchEmails(search = '', sender = '') {
        this._log('info', `[MailinkEmailList] fetchEmails() called, search="${search}", sender="${sender}", page=${this._currentPage}`, 'EmailList');
        
        if (this._isLoading) {
            this._log('warn', '[MailinkEmailList] Already loading, skipping', 'EmailList');
            return;
        }

        this._isLoading = true;
        this._showLoading();

        try {
            // Get the current configuration
            const config = window.selectedConfig;
            if (!config) {
                console.warn('[MailinkEmailList] No email config available');
                this._log('error', '[MailinkEmailList] No email config available (window.selectedConfig is null)', 'EmailList');
                this._showEmpty();
                return;
            }

            this._log('info', `[MailinkEmailList] Using config for user: ${config.username}`, 'EmailList');
            console.log('[MailinkEmailList] Fetching emails from local database...');

            // Call electronAPI to get emails from the local database
            let result = { emails: [], total: 0, totalPages: 0 };
            if (window.electronAPI && window.electronAPI.getLocalEmails) {
                this._log('info', '[MailinkEmailList] Calling electronAPI.getLocalEmails()', 'EmailList');
                result = await window.electronAPI.getLocalEmails({
                    username: config.username,
                    page: this._currentPage,
                    pageSize: this._pageSize,
                    search: search,
                    sender: sender
                });
                this._log('info', `[MailinkEmailList] getLocalEmails returned ${result.emails?.length || 0} emails, total: ${result.total || 0}`, 'EmailList');
            } else {
                console.warn('[MailinkEmailList] electronAPI.getLocalEmails not available');
                this._log('error', '[MailinkEmailList] electronAPI.getLocalEmails not available', 'EmailList');
            }

            // Handle email data
            this._emails = Array.isArray(result.emails) ? result.emails : [];
            this._totalEmails = result.total || 0;

            console.log(`[MailinkEmailList] Fetched ${this._emails.length} emails from local database (total: ${this._totalEmails})`);
            this._log('info', `[MailinkEmailList] Processed ${this._emails.length} emails (total in DB: ${this._totalEmails})`, 'EmailList');

            // Render the email list
            this._log('info', '[MailinkEmailList] Calling _renderEmails()', 'EmailList');
            this._renderEmails();

            // Trigger event
            this._log('info', '[MailinkEmailList] Dispatching emailsLoaded event', 'EmailList');
            this.dispatchEvent(new CustomEvent('emailsLoaded', {
                detail: { count: this._emails.length, total: this._totalEmails, emails: this._emails },
                bubbles: true,
                composed: true
            }));

        } catch (error) {
            console.error('[MailinkEmailList] Failed to fetch emails:', error);
            this._log('error', `[MailinkEmailList] Failed to fetch emails: ${error.message}`, 'EmailList');
            this._showError(error.message);

            this.dispatchEvent(new CustomEvent('loadError', {
                detail: { error },
                bubbles: true,
                composed: true
            }));
        } finally {
            this._isLoading = false;
            this._hideLoading();
            this._log('info', '[MailinkEmailList] fetchEmails() finally block executed', 'EmailList');
        }
    }

    /**
     * Get the list of senders (for filtering)
     */
    async getSenders() {
        try {
            const config = window.selectedConfig;
            if (!config) return [];

            if (window.electronAPI && window.electronAPI.getLocalSenders) {
                return await window.electronAPI.getLocalSenders({ username: config.username });
            }
            return [];
        } catch (error) {
            console.error('[MailinkEmailList] Failed to get senders:', error);
            return [];
        }
    }

    /**
     * Get email details
     */
    async getEmailDetail(emailId) {
        try {
            const config = window.selectedConfig;
            if (!config) return null;

            if (window.electronAPI && window.electronAPI.getLocalEmailDetail) {
                return await window.electronAPI.getLocalEmailDetail({
                    username: config.username,
                    emailId: emailId
                });
            }
            return null;
        } catch (error) {
            console.error('[MailinkEmailList] Failed to get email detail:', error);
            return null;
        }
    }

    /**
     * Delete email
     */
    async deleteEmail(emailId) {
        try {
            const config = window.selectedConfig;
            if (!config) return { success: false };

            if (window.electronAPI && window.electronAPI.deleteLocalEmail) {
                const result = await window.electronAPI.deleteLocalEmail({
                    username: config.username,
                    emailId: emailId
                });
                if (result.success) {
                    // Reload the current page
                    await this.fetchEmails();
                }
                return result;
            }
            return { success: false, error: 'API not available' };
        } catch (error) {
            console.error('[MailinkEmailList] Failed to delete email:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Render email list
     */
    _renderEmails() {
        this._log('info', `[MailinkEmailList] _renderEmails() called, emails count: ${this._emails.length}`, 'EmailList');
        
        const tbody = this._shadow.getElementById('emailTableBody');
        const emptyState = this._shadow.getElementById('emptyState');
        const currentPageEl = this._shadow.getElementById('currentPage');
        const totalPagesEl = this._shadow.getElementById('totalPages');
        const prevBtn = this._shadow.getElementById('prevBtn');
        const nextBtn = this._shadow.getElementById('nextBtn');

        if (!tbody) {
            this._log('error', '[MailinkEmailList] emailTableBody element not found', 'EmailList');
            return;
        }

        // Calculate pagination
        const totalPages = Math.ceil(this._totalEmails / this._pageSize) || 1;

        // Update pagination information
        if (currentPageEl) currentPageEl.textContent = this._currentPage;
        if (totalPagesEl) totalPagesEl.textContent = totalPages;
        if (prevBtn) prevBtn.disabled = this._currentPage <= 1;
        if (nextBtn) nextBtn.disabled = this._currentPage >= totalPages;

        // Clear the table
        tbody.innerHTML = '';

        // Display empty state or mail list
        if (this._emails.length === 0) {
            this._log('info', '[MailinkEmailList] No emails to render, showing empty state', 'EmailList');
            this._showEmpty();
            return;
        } else {
            this._hideEmpty();
        }

        // Render email row
        // Note: The backend has already returned the data for the corresponding page based on page and pageSize, no need to slice again
        const start = (this._currentPage - 1) * this._pageSize;
        this._log('info', `[MailinkEmailList] Rendering ${this._emails.length} email rows`, 'EmailList');
        this._emails.forEach((email, index) => {
            const row = this._createEmailRow(email, start + index);
            tbody.appendChild(row);
        });
        this._log('info', '[MailinkEmailList] _renderEmails() completed', 'EmailList');
    }

    /**
     * Create email row
     */
    _createEmailRow(email, index) {
        const row = document.createElement('tr');
        row.dataset.index = index;
        row.dataset.uid = email.uid || '';
        row.dataset.id = email.id || email.uid || '';

        // Read/Unread status
        if (!email.isRead) {
            row.classList.add('unread');
        } else {
            row.classList.add('read');
        }

        // Selected state (single choice)
        if (this._selectedEmail && this._selectedEmail.uid === email.uid) {
            row.classList.add('selected');
        }

        // Format the sender
        const from = this._formatSender(email.from);

        // Format theme
        const subject = email.subject || window.i18n?.t('common.noSubject') || '(No subject)';

        // Format time
        const date = this._formatDate(email.date);

        // Check if there is an attachment
        const hasAttachments = email.attachments && email.attachments.length > 0;

        // Get priority
        const priority = this._getPriority(email);

        // Build the content of the subject column
        let subjectContent = '';
        // Attachment icon is displayed at the front
        if (hasAttachments) {
            subjectContent += `<span class="email-icon attachment-icon" title="${window.i18n?.t('common.hasAttachment') || 'Has attachment'}">📎</span>`;
        }
        // Priority icon (only shows high priority)
        if (priority === 'high') {
            const priorityIcon = '<span style="color: #ff4d4f; font-weight: bold;">!</span>';
            const priorityTitle = window.i18n?.t('common.highPriority') || 'High priority';
            subjectContent += `<span class="email-icon priority-icon priority-${priority}" title="${priorityTitle}">${priorityIcon}</span>`;
        }
        // Theme text
        subjectContent += `<span class="subject-text">${this._escapeHtml(subject)}</span>`;

        // Check if selected by multiple choice
        const isMultiSelected = this._selectedEmails.has(String(email.id || email.uid));

        row.innerHTML = `
            <td><input type="checkbox" class="email-checkbox" data-id="${email.id || email.uid}" ${isMultiSelected ? 'checked' : ''}></td>
            <td title="${this._escapeHtml(from)}">${this._escapeHtml(from)}</td>
            <td class="subject-cell">${subjectContent}</td>
            <td>${date}</td>
        `;

        // Checkbox click event
        const checkbox = row.querySelector('.email-checkbox');
        checkbox.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleEmailSelection(email, checkbox.checked);
        });

        // Row click event (single selection)
        row.addEventListener('click', (e) => {
            // If the checkbox is clicked, do not trigger the radio button
            if (e.target.classList.contains('email-checkbox')) return;
            this._selectEmail(email, row);
        });

        // Mouse hover event - Download email body immediately
        row.addEventListener('mouseenter', () => {
            this._handleMouseEnter(email);
        });

        return row;
    }

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

    /**
     * Handle mouse hover event
     */
    async _handleMouseEnter(email) {
        try {
            const emailId = String(email.id || email.uid);
            const downloadManager = this._getDownloadManager();
            
            // Check if it is already downloading
            if (downloadManager.downloadingEmails.has(emailId)) {
                return;
            }

            // Check if the email body is empty (check both text and html)
            if ((email.text !== '' && email.text !== null && email.text !== undefined) || 
                (email.html !== '' && email.html !== null && email.html !== undefined)) {
                return;
            }

            // Check if there is an imap_uid
            const imapUid = email.imapUid;
            if (!imapUid) {
                return;
            }

            // Check if there is electronAPI.fetchEmailBody
            if (!window.electronAPI || !window.electronAPI.fetchEmailBody) {
                return;
            }

            const config = window.selectedConfig;
            if (!config) {
                return;
            }

            // Marked as downloading
            downloadManager.downloadingEmails.add(emailId);
            this._log('info', `[MailinkEmailList] Starting background download for email ${emailId}`, 'EmailList');

            const maxRetries = 3;
            const retryDelay = 5000;
            let retryCount = 0;

            const downloadWithRetry = async () => {
                try {
                    const currentLogText = retryCount > 0 ? 
                        `[MailinkEmailList] Retrying background download for email ${emailId} (attempt ${retryCount + 1}/${maxRetries})` :
                        `[MailinkEmailList] Starting background download for email ${emailId}`;
                    this._log('info', currentLogText, 'EmailList');

                    if (retryCount > 0) {
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                    }

                    const res = await window.electronAPI.fetchEmailBody({
                        username: config.username,
                        emailId: emailId,
                        uid: parseInt(imapUid, 10),
                        config: config
                    });

                    if (res && res.success) {
                        // Fallback strategy: if emailData is missing, try re-reading from database
                        let bodyData = res.emailData;
                        if (!bodyData) {
                            this._log('warn', `[MailinkEmailList] fetchEmailBody succeeded but emailData missing for ${emailId}, reading from DB as fallback`, 'EmailList');
                            try {
                                const fallbackDetail = await window.electronAPI.getLocalEmailDetail({
                                    username: config.username,
                                    emailId: emailId
                                });
                                if (fallbackDetail && (fallbackDetail.text || fallbackDetail.html)) {
                                    bodyData = { text: fallbackDetail.text, html: fallbackDetail.html, attachments: fallbackDetail.attachments };
                                }
                            } catch (fbErr) {
                                this._log('error', `[MailinkEmailList] Fallback DB read failed for ${emailId}: ${fbErr.message}`, 'EmailList');
                            }
                        }

                        if (bodyData) {
                            this._log('info', `[MailinkEmailList] Successfully downloaded email body for ${emailId}`, 'EmailList');
                            // Update the locally cached email data
                            const emailIndex = this._emails.findIndex(e => String(e.id || e.uid) === emailId);
                            if (emailIndex !== -1) {
                                this._emails[emailIndex].text = bodyData.text;
                                this._emails[emailIndex].html = bodyData.html;
                                if (bodyData.attachments) {
                                    this._emails[emailIndex].attachments = bodyData.attachments;
                                }
                            }
                            downloadManager.notifyComplete(emailId, true);
                        } else {
                            this._log('warn', `[MailinkEmailList] Failed to download email body for ${emailId}`, 'EmailList');
                            retryCount++;
                            if (retryCount <= maxRetries) {
                                await downloadWithRetry();
                            } else {
                                this._log('error', `[MailinkEmailList] Max retries reached for email ${emailId}`, 'EmailList');
                                downloadManager.notifyComplete(emailId, false);
                            }
                        }
                    } else {
                        this._log('warn', `[MailinkEmailList] Failed to download email body for ${emailId}`, 'EmailList');
                        retryCount++;
                        if (retryCount <= maxRetries) {
                            await downloadWithRetry();
                        } else {
                            this._log('error', `[MailinkEmailList] Max retries reached for email ${emailId}`, 'EmailList');
                            downloadManager.notifyComplete(emailId, false);
                        }
                    }
                } catch (error) {
                    this._log('error', `[MailinkEmailList] Error downloading email body for ${emailId}: ${error.message}`, 'EmailList');
                    retryCount++;
                    if (retryCount <= maxRetries) {
                        await downloadWithRetry();
                    } else {
                        this._log('error', `[MailinkEmailList] Max retries reached for email ${emailId} after error`, 'EmailList');
                        downloadManager.notifyComplete(emailId, false);
                    }
                }
            };

            setTimeout(downloadWithRetry, 0);
        } catch (error) {
            this._log('error', `[MailinkEmailList] Error in _handleMouseEnter: ${error.message}`, 'EmailList');
        }
    }

    /**
     * Toggle email multi-selection state
     */
    _toggleEmailSelection(email, isSelected) {
        const emailId = String(email.id || email.uid);
        if (isSelected) {
            this._selectedEmails.add(emailId);
        } else {
            this._selectedEmails.delete(emailId);
        }
        console.log(`[MailinkEmailList] Multi-selection changed: ${this._selectedEmails.size} emails selected`);
        this._updateSelectAllCheckbox();
    }

    /**
     * Update the 'select all' checkbox state
     */
    _updateSelectAllCheckbox() {
        const selectAllCheckbox = this._shadow.getElementById('selectAllCheckbox');
        if (!selectAllCheckbox) return;

        if (this._emails.length === 0) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
            return;
        }

        const selectedCount = this._selectedEmails.size;
        if (selectedCount === 0) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        } else if (selectedCount === this._emails.length) {
            selectAllCheckbox.checked = true;
            selectAllCheckbox.indeterminate = false;
        } else {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = true;
        }
    }

    /**
     * Select All / Deselect All
     */
    _toggleSelectAll(checked) {
        if (checked) {
            this._emails.forEach(email => {
                this._selectedEmails.add(String(email.id || email.uid));
            });
        } else {
            this._selectedEmails.clear();
        }

        // Update all checkbox states
        const checkboxes = this._shadow.querySelectorAll('.email-checkbox');
        checkboxes.forEach(cb => {
            cb.checked = checked;
        });

        console.log(`[MailinkEmailList] Select all: ${checked}, ${this._selectedEmails.size} emails selected`);
    }

    /**
     * Get email priority
     * @param {Object} email - Email object
     * @returns {string|null} - 'high' | 'normal' | 'low' | null
     */
    _getPriority(email) {
        // Get from the email priority field
        if (email.priority) {
            const p = String(email.priority).toLowerCase();
            if (p === '1' || p === 'high') return 'high';
            if (p === '5' || p === 'low') return 'low';
            if (p === '3' || p === 'normal') return 'normal';
        }

        // Parse X-Priority from headers
        if (email.headers) {
            if (email.headers['priority']) {
                const p = String(email.headers['priority']).toLowerCase();
                if (p === 'high') return 'high';
                if (p === 'low') return 'low';
                if (p === 'normal') return 'normal';
            }

            const xPriority = email.headers['x-priority'] || email.headers['X-Priority'];
            if (xPriority) {
                const p = String(xPriority).charAt(0);
                if (p === '1') return 'high';
                if (p === '5') return 'low';
                if (p === '3') return 'normal';
            }

            // Parse from the Importance header
            const importance = email.headers['importance'] || email.headers['Importance'];
            if (importance) {
                const i = String(importance).toLowerCase();
                if (i === 'high') return 'high';
                if (i === 'low') return 'low';
                if (i === 'normal') return 'normal';
            }
        }

        return null;
    }

    /**
     * HTML escape, to prevent XSS
     * @param {string} text - The text that needs to be escaped
     * @returns {string} - The escaped text
     */
    _escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Select email
     */
    _selectEmail(email, row) {
        // Remove the previous selection state
        const prevSelected = this._shadow.querySelector('tr.selected');
        if (prevSelected) {
            prevSelected.classList.remove('selected');
        }

        // Add selected state
        row.classList.add('selected');
        this._selectedEmail = email;

        // Trigger selection event
        this.dispatchEvent(new CustomEvent('emailSelected', {
            detail: { email },
            bubbles: true,
            composed: true
        }));
    }

    /**
     * Mark the email as read (update UI)
     * @param {string} emailId - Email ID
     */
    markEmailAsRead(emailId) {
        // Update data
        const email = this._emails.find(e => String(e.uid) === String(emailId) || String(e.id) === String(emailId));
        if (email) {
            email.isRead = true;
        }

        // Update UI - find the corresponding row and remove the unread style
        const row = this._shadow.querySelector(`tr[data-uid="${emailId}"]`);
        if (row) {
            row.classList.remove('unread');
            row.classList.add('read');
        }

        console.log('[MailinkEmailList] Email marked as read in UI:', emailId);
    }

    /**
     * Mark all emails as read (update UI)
     */
    markAllEmailsAsRead() {
        // Update data
        this._emails.forEach(email => {
            email.isRead = true;
        });

        // Update UI - Remove all unread styles
        const rows = this._shadow.querySelectorAll('tr.unread');
        rows.forEach(row => {
            row.classList.remove('unread');
            row.classList.add('read');
        });

        console.log('[MailinkEmailList] All emails marked as read in UI');
    }

    /**
     * Format sender
     */
    _formatSender(from) {
        // Check if it is null, undefined, or an empty string
        if (!from || from.trim() === '') return window.i18n?.t('common.unknownSender') || 'Unknown sender';

        // If it contains < >, extract the email address
        const match = from.match(/<(.+?)>/);
        if (match) {
            const name = from.split('<')[0].trim();
            const email = match[1];
            return name || email;
        }

        return from;
    }

    /**
     * Format date
     */
    _formatDate(date) {
        if (!date) return '';

        const d = new Date(date);
        if (isNaN(d.getTime())) return '';

        const locale = window.i18n?.getLocale() || 'zh-CN';
        const now = new Date();
        const isToday = d.toDateString() === now.toDateString();

        if (isToday) {
            return d.toLocaleTimeString(locale, {
                hour: '2-digit',
                minute: '2-digit'
            });
        } else {
            return d.toLocaleDateString(locale, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }
    }

    /**
     * Show loading state
     */
    _showLoading() {
        const loadingState = this._shadow.getElementById('loadingState');
        const tbody = this._shadow.getElementById('emailTableBody');

        if (loadingState) loadingState.style.display = 'flex';
        if (tbody) tbody.style.display = 'none';
    }

    /**
     * Hide loading state
     */
    _hideLoading() {
        const loadingState = this._shadow.getElementById('loadingState');
        const tbody = this._shadow.getElementById('emailTableBody');

        if (loadingState) loadingState.style.display = 'none';
        if (tbody) tbody.style.display = '';
    }

    /**
     * Show empty state
     */
    _showEmpty() {
        const emptyState = this._shadow.getElementById('emptyState');
        const tbody = this._shadow.getElementById('emailTableBody');

        if (emptyState) emptyState.style.display = 'flex';
        if (tbody) tbody.style.display = 'none';
    }

    /**
     * Hide empty state
     */
    _hideEmpty() {
        const emptyState = this._shadow.getElementById('emptyState');
        const tbody = this._shadow.getElementById('emailTableBody');

        if (emptyState) emptyState.style.display = 'none';
        if (tbody) tbody.style.display = '';
    }

    /**
     * Display error
     */
    _showError(message) {
        const tbody = this._shadow.getElementById('emailTableBody');
        if (tbody) {
            const errorMsg = window.i18n?.t('emailList.loadFailed', { message }) || 'Loading failed';
            tbody.innerHTML = `
                <tr>
                    <td colspan="3" style="text-align: center; padding: 40px; color: #ff4d4f;">
                        ${errorMsg}
                    </td>
                </tr>
            `;
        }
    }

    /**
     * Refresh mail list
     */
    async refresh() {
        this._log('info', '[MailinkEmailList] refresh() called, resetting to page 1', 'EmailList');
        this._currentPage = 1;
        await this.fetchEmails();
        this._log('info', '[MailinkEmailList] refresh() completed', 'EmailList');
    }

    /**
     * Clear the list
     */
    clear() {
        this._emails = [];
        this._totalEmails = 0;
        this._currentPage = 1;
        this._selectedEmail = null;
        this._renderEmails();
    }

    /**
     * Get the current email data
     */
    getEmails() {
        return this._emails;
    }

    /**
     * Get the selected email (single)
     */
    getSelectedEmail() {
        return this._selectedEmail;
    }

    /**
     * Get the list of selected emails (supports multiple selections)
     */
    getSelectedEmails() {
        if (this._selectedEmails.size === 0) {
            return this._selectedEmail ? [this._selectedEmail] : [];
        }
        // Return all selected email objects
        return this._emails.filter(email => {
            const emailId = String(email.id || email.uid);
            return this._selectedEmails.has(emailId);
        });
    }

    /**
     * Clear all selected states
     */
    clearSelection() {
        this._selectedEmails.clear();
        this._selectedEmail = null;
        this._updateSelectAllCheckbox();

        // Update UI
        const checkboxes = this._shadow.querySelectorAll('.email-checkbox');
        checkboxes.forEach(cb => {
            cb.checked = false;
        });

        const rows = this._shadow.querySelectorAll('tbody tr');
        rows.forEach(row => {
            row.classList.remove('selected');
        });
    }
}

// Register custom element
if (!customElements.get('mailink-email-list')) {
    customElements.define('mailink-email-list', MailinkEmailList);
}

export default MailinkEmailList;
