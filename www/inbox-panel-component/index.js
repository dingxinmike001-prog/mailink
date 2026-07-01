/**
 * Inbox panel component
 * Includes a list of emails, clicking an email displays details in a popup
 */

import '../email-list-component/index.js';
// Change the mail detail component to dynamic import, no longer statically imported
// import '../email-detail-component/index.js';
import { playCloseAnimation, playOpenAnimation } from '../shared/close-animation.js';

async function loadTemplate() {
    try {
        const htmlUrl = new URL('./inbox-panel.html', import.meta.url).href;
        const response = await fetch(htmlUrl);
        if (response.ok) {
            return await response.text();
        }
        console.warn('[MailinkInboxPanel] Failed to load HTML template');
        return '';
    } catch (error) {
        console.warn('[MailinkInboxPanel] Error loading HTML template:', error);
        return '';
    }
}

export class MailinkInboxPanel extends HTMLElement {
    constructor() {
        super();
        this._shadow = null;
        this._isVisible = false;
        this._emailListComponent = null;
        this._emailDetailComponent = null;
        this._refreshTimer = null;
        this._autoRefresh = true;
        this._refreshInterval = 30000; // 30 seconds
        
        // Drag-related properties
        this._isDragging = false;
        this._dragOffsetX = 0;
        this._dragOffsetY = 0;
        this._boundOnDragStart = this._onDragStart.bind(this);
        this._boundOnDragMove = this._onDragMove.bind(this);
        this._boundOnDragEnd = this._onDragEnd.bind(this);
        
        // Window status
        this._isMaximized = false;
        this._isMinimized = false;
        this._savedPosition = null; // Save the position before maximizing/minimizing
        
        // Initialize state
        this._isInitialized = false;
        this._initPromise = null;
    }

    async connectedCallback() {
        if (this._shadow) return;
        
        // Create an initialization Promise so that the show() method can wait for the initialization to complete
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

        if (window.i18n?.registerRoot) window.i18n.registerRoot(this._shadow);
        
        // Wait for i18n to be ready before initializing translation to avoid timing issues
        if (window.i18n?.whenReady) {
            await window.i18n.whenReady();
        }
        if (window.i18n?.initElements) window.i18n.initElements(this._shadow);

        // Bind events
        this._bindEvents();

        this._onLangChanged = () => {
            if (window.i18n?.initElements) window.i18n.initElements(this._shadow);
        };
        window.addEventListener('lang-changed', this._onLangChanged);

        // Hidden by default
        this.hide();
        
        // Mark initialization complete
        this._isInitialized = true;

        console.log('[MailinkInboxPanel] Component initialized');
        this._log('info', '[MailinkInboxPanel] Component initialized', 'InboxPanel');
    }

    /**
     * Log to file
     */
    _log(level, message, category = 'InboxPanel') {
        if (window.electronAPI && window.electronAPI.log) {
            window.electronAPI.log(level, message, category);
        }
    }

    disconnectedCallback() {
        if (window.i18n?.unregisterRoot) window.i18n.unregisterRoot(this._shadow);
        if (this._onLangChanged) window.removeEventListener('lang-changed', this._onLangChanged);

        // Clear the timer
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }

        // Clear drag events
        document.removeEventListener('mousemove', this._boundOnDragMove);
        document.removeEventListener('mouseup', this._boundOnDragEnd);

        const header = this._shadow?.querySelector('.inbox-panel-header');
        if (header) {
            header.removeEventListener('mousedown', this._boundOnDragStart);
        }
    }

    async _loadCSS() {
        try {
            const cssUrl = new URL('./inbox-panel.css', import.meta.url).href;
            const response = await fetch(cssUrl);
            if (response.ok) {
                return await response.text();
            }
            console.warn('[MailinkInboxPanel] Failed to load CSS');
            return '';
        } catch (error) {
            console.warn('[MailinkInboxPanel] Error loading CSS:', error);
            return '';
        }
    }

    _bindEvents() {
        // Bind click event to the panel, check position constraints
        const panel = this._shadow.querySelector('.inbox-panel');
        if (panel) {
            panel.addEventListener('click', () => {
                this._enforcePositionLimit();
            });
        }

        // Refresh button
        const refreshBtn = this._shadow.getElementById('refreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                this._log('info', '[MailinkInboxPanel] Refresh button clicked', 'InboxPanel');
                this.refreshEmails();
            });
        } else {
            this._log('error', '[MailinkInboxPanel] Refresh button not found during event binding', 'InboxPanel');
        }

        // Delete selected button
        const deleteSelectedBtn = this._shadow.getElementById('deleteSelectedBtn');
        if (deleteSelectedBtn) {
            deleteSelectedBtn.addEventListener('click', () => {
                this._deleteSelectedEmails();
            });
        }

        // Mark all as read button
        const markAllReadBtn = this._shadow.getElementById('markAllReadBtn');
        if (markAllReadBtn) {
            markAllReadBtn.addEventListener('click', () => {
                this._markAllEmailsAsRead();
            });
        }

        // Minimize button
        const minimizeBtn = this._shadow.getElementById('minimizeBtn');
        if (minimizeBtn) {
            minimizeBtn.addEventListener('click', () => {
                this.toggleMinimize();
            });
            minimizeBtn.title = window.i18n?.t('common.minimize') || 'Minimize';
        }

        // Maximize button
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

        // Click the mask layer to close the panel
        const overlay = this._shadow.querySelector('.inbox-panel-overlay');
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                // Only close when clicking on the mask itself, not when clicking inside the panel
                if (e.target === overlay) {
                    this.close();
                }
            });
        }

        // Bind drag event to the title bar
        const header = this._shadow.querySelector('.inbox-panel-header');
        if (header) {
            header.addEventListener('mousedown', this._boundOnDragStart);
        }

        // Mail list events
        const emailList = this._shadow.getElementById('emailList');
        if (emailList) {
            this._emailListComponent = emailList;
            this._log('info', '[MailinkInboxPanel] emailList component found and bound', 'InboxPanel');

            // Listen for email load completion
            emailList.addEventListener('emailsLoaded', (e) => {
                console.log('[MailinkInboxPanel] Emails loaded:', e.detail.count);
                this._log('info', `[MailinkInboxPanel] emailsLoaded event received, count: ${e.detail.count}, total: ${e.detail.total}`, 'InboxPanel');
                // Update email count display
                const emailCountEl = this._shadow.getElementById('emailCount');
                if (emailCountEl && e.detail.total !== undefined) {
                    emailCountEl.textContent = e.detail.total;
                    this._log('info', `[MailinkInboxPanel] Updated email count display to: ${e.detail.total}`, 'InboxPanel');
                }
            });

            // Listen for email selection - display email details in a popup
            emailList.addEventListener('emailSelected', (e) => {
                console.log('[MailinkInboxPanel] Email selected:', e.detail.email);
                this._log('info', `[MailinkInboxPanel] Email selected: ${e.detail.email?.subject || 'N/A'}`, 'InboxPanel');
                this._showEmailDetail(e.detail.email);
            });

            // Listen for load errors
            emailList.addEventListener('loadError', (e) => {
                console.error('[MailinkInboxPanel] Load error:', e.detail.error);
                this._log('error', `[MailinkInboxPanel] Load error: ${e.detail.error}`, 'InboxPanel');
            });
        } else {
            this._log('error', '[MailinkInboxPanel] emailList component not found in shadow DOM', 'InboxPanel');
        }

        // Email detail component changed to dynamic creation，No longer statically embedded in template
        // Event listener in _showEmailDetail Dynamically bound in method
    }

    /**
     * Handle email read event
     */
    async _handleEmailMarkedAsRead(emailId) {
        // 1. Update the style of the corresponding row in the email list
        if (this._emailListComponent && typeof this._emailListComponent.markEmailAsRead === 'function') {
            this._emailListComponent.markEmailAsRead(emailId);
        }

        // 2. Update the number of unread emails
        await this._updateUnreadCount();
    }

    /**
     * Update unread email count
     */
    async _updateUnreadCount() {
        try {
            const config = window.selectedConfig;
            if (!config || !config.username) return;

            if (window.electronAPI && window.electronAPI.getRecvUnreadCount) {
                const result = await window.electronAPI.getRecvUnreadCount({
                    myEmail: config.username
                });

                const unreadCount = result?.total || 0;
                console.log('[MailinkInboxPanel] Unread count updated:', unreadCount);

                // Trigger unread count update event to notify external components (such as user avatars)
                this.dispatchEvent(new CustomEvent('unreadCountUpdated', {
                    detail: { unreadCount, myEmail: config.username },
                    bubbles: true,
                    composed: true
                }));

                // Also update the global event to ensure other components can receive the notification
                window.dispatchEvent(new CustomEvent('recvUnreadCountUpdated', {
                    detail: { unreadCount, myEmail: config.username }
                }));
            }
        } catch (error) {
            console.error('[MailinkInboxPanel] Failed to update unread count:', error);
        }
    }

    /**
     * Delete the selected emails (both locally and on the server)
     */
    async _deleteSelectedEmails() {
        try {
            // Get the selected email
            const selectedEmails = this._emailListComponent?.getSelectedEmails?.() || [];
            if (selectedEmails.length === 0) {
                this._showStatus(window.i18n?.t('inbox.selectEmailsToDelete') || 'Please select emails to delete first', 'info');
                return;
            }

            const deleteSelectedBtn = this._shadow.getElementById('deleteSelectedBtn');
            if (deleteSelectedBtn) {
                deleteSelectedBtn.disabled = true;
            }

            console.log('[MailinkInboxPanel] Deleting selected emails:', selectedEmails.length);

            const config = window.selectedConfig;
            if (!config || !config.username) {
                console.warn('[MailinkInboxPanel] No email config available');
                return;
            }

            // Collect emails with imapUid for server deletion
            const emailsWithImapUid = selectedEmails.filter(email => email.imapUid);
            const imapUids = emailsWithImapUid.map(email => email.imapUid);

            // 1. First delete the emails on the server
            let serverDeletedCount = 0;
            if (imapUids.length > 0 && window.electronAPI && window.electronAPI.deleteEmailsByUid) {
                try {
                    console.log('[MailinkInboxPanel] Deleting emails from server:', imapUids);
                    const imapConfig = {
                        username: config.username,
                        host: config.host,
                        port: config.port,
                        tls: config.tls,
                        password: config.password
                    };
                    const serverResult = await window.electronAPI.deleteEmailsByUid(imapConfig, imapUids);
                    if (serverResult.success) {
                        serverDeletedCount = serverResult.deletedCount || 0;
                        console.log('[MailinkInboxPanel] Server emails deleted:', serverDeletedCount);
                    } else {
                        console.error('[MailinkInboxPanel] Failed to delete server emails:', serverResult.error);
                    }
                } catch (error) {
                    console.error('[MailinkInboxPanel] Error deleting server emails:', error);
                }
            }

            // 2. Delete emails from the local database
            let localDeletedCount = 0;
            let failedCount = 0;

            if (window.electronAPI && window.electronAPI.deleteLocalEmail) {
                for (const email of selectedEmails) {
                    const emailId = email.id || email.uid;
                    try {
                        const result = await window.electronAPI.deleteLocalEmail({
                            username: config.username,
                            emailId: emailId
                        });
                        if (result.success) {
                            localDeletedCount++;
                        } else {
                            failedCount++;
                            console.error(`[MailinkInboxPanel] Failed to delete local email ${emailId}:`, result.error);
                        }
                    } catch (error) {
                        failedCount++;
                        console.error(`[MailinkInboxPanel] Error deleting local email ${emailId}:`, error);
                    }
                }
            }

            // 3. Display results and refresh
            if (localDeletedCount > 0) {
                console.log('[MailinkInboxPanel] Local emails deleted:', localDeletedCount);

                // Clear selection state
                if (this._emailListComponent && typeof this._emailListComponent.clearSelection === 'function') {
                    this._emailListComponent.clearSelection();
                }

                // Refresh the email list
                await this.refreshEmails();

                // Update unread email count
                await this._updateUnreadCount();

                // Display results
                if (failedCount === 0) {
                    if (serverDeletedCount > 0) {
                        this._showStatus((window.i18n?.t('inbox.deleteSuccessWithServer') || '✅ Deleted {count} emails (including server)').replace('{count}', localDeletedCount), 'success');
                    } else {
                        this._showStatus((window.i18n?.t('inbox.deleteSuccess') || '✅ Deleted {count} emails').replace('{count}', localDeletedCount), 'success');
                    }
                } else {
                    this._showStatus((window.i18n?.t('inbox.deletePartialFailed') || '⚠️ Deleted {success}, failed {failed}').replace('{success}', localDeletedCount).replace('{failed}', failedCount), 'info');
                }
            } else {
                this._showStatus(window.i18n?.t('inbox.deleteFailed') || '❌ Delete failed', 'error');
            }
        } catch (error) {
            console.error('[MailinkInboxPanel] Error deleting selected emails:', error);
            this._showStatus((window.i18n?.t('inbox.operationFailed') || '❌ Operation failed') + `: ${error.message}`, 'error');
        } finally {
            const deleteSelectedBtn = this._shadow.getElementById('deleteSelectedBtn');
            if (deleteSelectedBtn) {
                deleteSelectedBtn.disabled = false;
            }
        }
    }

    /**
     * Mark all emails as read
     */
    async _markAllEmailsAsRead() {
        try {
            const config = window.selectedConfig;
            if (!config || !config.username) {
                console.warn('[MailinkInboxPanel] No email config available');
                return;
            }

            const markAllReadBtn = this._shadow.getElementById('markAllReadBtn');
            if (markAllReadBtn) {
                markAllReadBtn.disabled = true;
            }

            console.log('[MailinkInboxPanel] Marking all emails as read...');

            // Call the API to mark all emails as read
            if (window.electronAPI && window.electronAPI.markAllEmailsAsRead) {
                // Build IMAP configuration (remove sensitive info like password)
                const imapConfig = {
                    username: config.username,
                    host: config.host,
                    port: config.port,
                    tls: config.tls
                };

                const result = await window.electronAPI.markAllEmailsAsRead({
                    username: config.username,
                    imapConfig: imapConfig
                });

                if (result.success) {
                    console.log('[MailinkInboxPanel] All emails marked as read', 'Server synced:', result.serverSynced);

                    // Update email list UI
                    if (this._emailListComponent && typeof this._emailListComponent.markAllEmailsAsRead === 'function') {
                        this._emailListComponent.markAllEmailsAsRead();
                    }

                    // Update unread email count
                    await this._updateUnreadCount();

                    // Show success prompt
                    if (result.serverSynced) {
                        this._showStatus((window.i18n?.t('inbox.markAllReadSuccess') || '✅ All marked as read') + ` (${(window.i18n?.t('inbox.syncedCountToServer') || 'Synced {count} to server').replace('{count}', result.serverSyncedCount)})`, 'success');
                    } else {
                        this._showStatus(window.i18n?.t('inbox.markAllReadSuccess') || '✅ All marked as read', 'success');
                    }
                } else {
                    console.error('[MailinkInboxPanel] Failed to mark all as read:', result.error);
                    this._showStatus((window.i18n?.t('inbox.markAllReadFailed') || '❌ Mark failed') + `: ${result.error}`, 'error');
                }
            } else {
                console.warn('[MailinkInboxPanel] markAllEmailsAsRead API not available');
                this._showStatus(window.i18n?.t('inbox.featureUnavailable') || '❌ Feature temporarily unavailable', 'error');
            }
        } catch (error) {
            console.error('[MailinkInboxPanel] Error marking all as read:', error);
            this._showStatus((window.i18n?.t('inbox.operationFailed') || '❌ Operation failed') + `: ${error.message}`, 'error');
        } finally {
            const markAllReadBtn = this._shadow.getElementById('markAllReadBtn');
            if (markAllReadBtn) {
                markAllReadBtn.disabled = false;
            }
        }
    }

    /**
     * Display status message
     */
    _showStatus(message, type = 'info') {
        // Create a status prompt element
        let statusEl = this._shadow.getElementById('statusTooltip');
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.id = 'statusTooltip';
            statusEl.className = 'status-tooltip';
            this._shadow.appendChild(statusEl);
        }

        // Reset state
        statusEl.classList.remove('show', 'success', 'error', 'info');
        // Force reflow to retrigger the animation
        void statusEl.offsetWidth;
        
        // Set type and content
        statusEl.classList.add(type);
        statusEl.textContent = message;
        
        // Show animation
        statusEl.classList.add('show');
        
        // Remove state after animation ends
        setTimeout(() => {
            statusEl.classList.remove('show');
        }, 2000);
    }

    /**
     * Show email detail popup
     * Dynamically create the email detail component, making it independent of the inbox panel
     */
    async _showEmailDetail(email) {
        // Dynamically import the mail detail component module (ensure the component is registered)
        console.warn('[MailinkInboxPanel] Starting to import email-detail-component');
        await import('../email-detail-component/index.js?v=3');
        console.warn('[MailinkInboxPanel] email-detail-component import completed');

        // Find or create the mail detail component (mount it on the body, independent of the inbox panel)
        let emailDetail = document.getElementById('globalEmailDetail');
        if (!emailDetail) {
            emailDetail = document.createElement('mailink-email-detail');
            emailDetail.id = 'globalEmailDetail';
            document.body.appendChild(emailDetail);

            // Listen for email read events
            emailDetail.addEventListener('emailMarkedAsRead', (e) => {
                console.log('[MailinkInboxPanel] Email marked as read:', e.detail.emailId);
                this._handleEmailMarkedAsRead(e.detail.emailId);
            });
        }

        // Wait for component initialization to complete (connectedCallback is asynchronous)
        if (emailDetail._initPromise) {
            await emailDetail._initPromise;
        }

        // Call the showEmail method of the email detail component to display the popup
        await emailDetail.showEmail(email);

        // Trigger event
        this.dispatchEvent(new CustomEvent('emailSelected', {
            detail: { email },
            bubbles: true,
            composed: true
        }));
    }

    /**
     * Display panel
     */
    async show() {
        this._log('info', '[MailinkInboxPanel] show() called', 'InboxPanel');
        
        // Wait for initialization to complete
        if (!this._isInitialized && this._initPromise) {
            this._log('info', '[MailinkInboxPanel] Waiting for initialization...', 'InboxPanel');
            await this._initPromise;
            this._log('info', '[MailinkInboxPanel] Initialization completed, continuing show()', 'InboxPanel');
        }
        
        if (this._isVisible) {
            this._log('info', '[MailinkInboxPanel] Panel already visible, skipping', 'InboxPanel');
            return;
        }

        const overlay = this._shadow.querySelector('.inbox-panel-overlay');
        const panel = this._shadow.querySelector('.inbox-panel');
        if (overlay && panel) {
            // Clean up styles that may remain from closing animations
            panel.classList.remove('hide');
            panel.style.opacity = '';
            panel.style.transform = '';
            panel.style.transformOrigin = '';

            // Display overlay layer
            overlay.classList.add('show');
            this.style.display = 'block';
            this._isVisible = true;

            // Play opening animation (zoom in from top left, fade in)
            await playOpenAnimation(panel);

            this._log('info', '[MailinkInboxPanel] Panel DOM elements shown', 'InboxPanel');

            // Reset state
            this._isMaximized = false;
            this._isMinimized = false;
            panel.classList.remove('maximized', 'minimized');
            
            // Reset maximize button icon
            const maximizeBtn = this._shadow.getElementById('maximizeBtn');
            if (maximizeBtn) {
                maximizeBtn.classList.remove('restore');
                maximizeBtn.title = window.i18n?.t('common.maximize') || 'Maximize';
            }

            // Use the initial position if no saved position exists (limited to 32px below the title bar)
            if (!this._savedPosition) {
                panel.style.left = '240px';
                panel.style.top = '32px';
                panel.style.right = '0';
                panel.style.bottom = '0';
                panel.style.width = '';
                panel.style.height = '';
            } else {
                // Restore the saved position
                this._restorePosition();
            }

            // Load emails
            this._log('info', '[MailinkInboxPanel] Calling refreshEmails()', 'InboxPanel');
            this.refreshEmails();

            // Automatically trigger the refresh button click
            this._log('info', '[MailinkInboxPanel] Scheduling auto-refresh button click (100ms delay)', 'InboxPanel');
            setTimeout(() => {
                const refreshBtn = this._shadow.getElementById('refreshBtn');
                if (refreshBtn) {
                    this._log('info', '[MailinkInboxPanel] Auto-triggering refresh button click', 'InboxPanel');
                    refreshBtn.click();
                    console.log('[MailinkInboxPanel] Auto-triggered refresh button click');
                } else {
                    this._log('error', '[MailinkInboxPanel] Refresh button not found', 'InboxPanel');
                }
            }, 100);

            // Start auto-refresh
            if (this._autoRefresh) {
                this._log('info', '[MailinkInboxPanel] Starting auto-refresh timer', 'InboxPanel');
                this._startAutoRefresh();
            }

            // Trigger event
            this.dispatchEvent(new CustomEvent('panelShow', {
                bubbles: true,
                composed: true
            }));

            console.log('[MailinkInboxPanel] Panel shown');
            this._log('info', '[MailinkInboxPanel] Panel shown successfully', 'InboxPanel');
        } else {
            this._log('error', '[MailinkInboxPanel] Panel element not found in shadow DOM', 'InboxPanel');
        }
    }

    /**
     * Hide the panel (with animation)
     */
    async hide() {
        this._log('info', '[MailinkInboxPanel] hide() called', 'InboxPanel');
        
        if (!this._isVisible) {
            this._log('info', '[MailinkInboxPanel] Panel already hidden, skipping', 'InboxPanel');
            return;
        }

        const overlay = this._shadow.querySelector('.inbox-panel-overlay');
        const panel = this._shadow.querySelector('.inbox-panel');
        if (overlay && panel) {
            // Play the shared close animation (0.5s)
            await playCloseAnimation(panel);

            // Clean up after animation ends
            panel.classList.remove('hide');
            overlay.classList.remove('show');
            this.style.display = 'none';
            this._isVisible = false;

            // Stop auto-refresh
            this._stopAutoRefresh();

            // Trigger event
            this.dispatchEvent(new CustomEvent('panelHide', {
                bubbles: true,
                composed: true
            }));
            this._log('info', '[MailinkInboxPanel] Panel hidden successfully', 'InboxPanel');
        }
    }

    /**
     * Fully close the panel (reset all states + animation)
     */
    async close() {
        const panel = this._shadow.querySelector('.inbox-panel');
        if (panel) {
            // Clear maximize/minimize state
            panel.classList.remove('maximized', 'minimized', 'minimized-dragged');
            this._isMaximized = false;
            this._isMinimized = false;

            // Clear saved position
            this._savedPosition = null;

            // Reset inline styles
            panel.style.position = '';
            panel.style.left = '';
            panel.style.top = '';
            panel.style.right = '';
            panel.style.bottom = '';
            panel.style.width = '';
            panel.style.height = '';
            panel.style.borderRadius = '';
            panel.style.overflow = '';

            // Reset maximize button icon
            const maximizeBtn = this._shadow.getElementById('maximizeBtn');
            if (maximizeBtn) {
                maximizeBtn.classList.remove('restore');
                maximizeBtn.title = window.i18n?.t('common.maximize') || 'Maximize';
            }
        }

        // Hide the panel (with animation)
        await this.hide();
    }

    /**
     * Toggle show/hide
     */
    async toggle() {
        this._log('info', `[MailinkInboxPanel] toggle() called, current visibility: ${this._isVisible}`, 'InboxPanel');
        if (this._isVisible) {
            await this.hide();
        } else {
            await this.show();
        }
    }

    /**
     * Refresh the email list
     * First fetch new emails from the IMAP server, then refresh the local list display
     */
    async refreshEmails() {
        this._log('info', '[MailinkInboxPanel] refreshEmails() called', 'InboxPanel');
        
        const emailList = this._shadow.getElementById('emailList');
        if (!emailList) {
            this._log('error', '[MailinkInboxPanel] emailList element not found', 'InboxPanel');
            return;
        }
        
        // Step 1: Fetch new emails from the IMAP server first (reuse existing email fetch logic)
        if (window.handleFetchEmailsRequest && window.isImapConnected) {
            this._log('info', '[MailinkInboxPanel] Fetching new emails from IMAP server...', 'InboxPanel');
            try {
                // Show refresh status
                this._showStatus(window.i18n?.t('inbox.syncingEmails') || 'Syncing emails from server...', 'info');
                
                // Call the existing email fetch function to get regular emails (non-signaling) from the last 1 day
                await window.handleFetchEmailsRequest(1440, false, 'Manual refresh');
                
                this._log('info', '[MailinkInboxPanel] Server fetch completed', 'InboxPanel');
                this._showStatus(window.i18n?.t('inbox.syncComplete') || 'Email sync complete', 'success');
            } catch (error) {
                this._log('error', `[MailinkInboxPanel] Failed to fetch from server: ${error.message}`, 'InboxPanel');
                this._showStatus(window.i18n?.t('inbox.syncFailed') || 'Failed to sync emails, showing local emails', 'error');
                // Even if server fetch fails，Still continue refreshing local list
            }
        } else {
            this._log('warn', '[MailinkInboxPanel] IMAP not connected, skipping server fetch', 'InboxPanel');
        }
        
        // Step 2: Refresh the local email list display
        this._log('info', `[MailinkInboxPanel] emailList found, has refresh method: ${typeof emailList.refresh === 'function'}`, 'InboxPanel');
        this._log('info', `[MailinkInboxPanel] emailList found, has fetchEmails method: ${typeof emailList.fetchEmails === 'function'}`, 'InboxPanel');
        
        if (emailList && typeof emailList.refresh === 'function') {
            this._log('info', '[MailinkInboxPanel] Calling emailList.refresh()', 'InboxPanel');
            await emailList.refresh();
            this._log('info', '[MailinkInboxPanel] emailList.refresh() completed', 'InboxPanel');
        } else if (emailList && typeof emailList.fetchEmails === 'function') {
            this._log('info', '[MailinkInboxPanel] Calling emailList.fetchEmails()', 'InboxPanel');
            await emailList.fetchEmails();
            this._log('info', '[MailinkInboxPanel] emailList.fetchEmails() completed', 'InboxPanel');
        }
    }

    /**
     * Start auto-refresh
     */
    _startAutoRefresh() {
        if (this._refreshTimer) {
            this._log('info', '[MailinkInboxPanel] Auto refresh already running, skipping', 'InboxPanel');
            return;
        }

        console.log('[MailinkInboxPanel] Auto refresh started');
        this._log('info', `[MailinkInboxPanel] Auto refresh started with interval: ${this._refreshInterval}ms`, 'InboxPanel');
        this._refreshTimer = setInterval(() => {
            console.log('[MailinkInboxPanel] Auto refreshing emails...');
            this._log('info', '[MailinkInboxPanel] Auto refresh interval triggered', 'InboxPanel');
            this.refreshEmails();
        }, this._refreshInterval);
    }

    /**
     * Stop auto-refresh
     */
    _stopAutoRefresh() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
            console.log('[MailinkInboxPanel] Auto refresh stopped');
            this._log('info', '[MailinkInboxPanel] Auto refresh stopped', 'InboxPanel');
        } else {
            this._log('info', '[MailinkInboxPanel] Auto refresh not running, nothing to stop', 'InboxPanel');
        }
    }

    /**
     * Set up auto-refresh
     */
    setAutoRefresh(enabled) {
        this._autoRefresh = enabled;
        if (this._isVisible) {
            if (enabled) {
                this._startAutoRefresh();
            } else {
                this._stopAutoRefresh();
            }
        }
    }

    /**
     * Get the email list component
     */
    getEmailList() {
        return this._shadow.getElementById('emailList');
    }

    /**
     * Get the email detail component
     * Note: The email detail component is now standalone and mounted on document.body
     */
    getEmailDetail() {
        return document.getElementById('globalEmailDetail');
    }

    /**
     * Whether it is visible
     */
    get isVisible() {
        return this._isVisible;
    }

    /**
     * Toggle maximize/restore
     */
    toggleMaximize() {
        const panel = this._shadow.querySelector('.inbox-panel');
        const maximizeBtn = this._shadow.getElementById('maximizeBtn');
        if (!panel) return;

        console.log('[MailinkInboxPanel] toggleMaximize called, isMaximized:', this._isMaximized, 'maximizeBtn:', !!maximizeBtn);

        if (this._isMaximized) {
            // Restore: reset directly to the initial state without animation delay
            const panel = this._shadow.querySelector('.inbox-panel');
            const maximizeBtn = this._shadow.getElementById('maximizeBtn');

            if (panel) {
                // Remove maximize class and minimize-drag class
                panel.classList.remove('maximized', 'minimized-dragged');

                // Reset to the initial position and size (limited to 32px below the title bar)
                panel.style.left = '240px';
                panel.style.top = '32px';
                panel.style.right = '0';
                panel.style.bottom = '0';
                panel.style.width = '';
                panel.style.height = '';

                // Clear saved position
                this._savedPosition = null;
            }
            
            if (maximizeBtn) {
                maximizeBtn.classList.remove('restore');
                maximizeBtn.title = window.i18n?.t('common.maximize') || 'Maximize';
            }
            
            this._isMaximized = false;
            console.log('[MailinkInboxPanel] Restored instantly without animation');
        } else {
            // If minimized (including after dragging), restore to normal first
            const isDraggedMinimized = panel.classList.contains('minimized-dragged');
            if (this._isMinimized || isDraggedMinimized) {
                panel.classList.remove('minimized', 'minimized-dragged');
                
                // Clear inline styles after dragging
                if (isDraggedMinimized) {
                    panel.style.position = '';
                    panel.style.left = '';
                    panel.style.top = '';
                    panel.style.right = '';
                    panel.style.bottom = '';
                    panel.style.width = '';
                    panel.style.height = '';
                    panel.style.borderRadius = '';
                    panel.style.overflow = '';
                }
                
                this._isMinimized = false;
            }
            
            // Save the current position
            this._saveCurrentPosition();
            
            // Maximize
            panel.classList.add('maximized');
            if (maximizeBtn) {
                maximizeBtn.classList.add('restore');
                maximizeBtn.title = window.i18n?.t('common.restore') || 'Restore';
                console.log('[MailinkInboxPanel] Button restore class added');
            }
            this._isMaximized = true;
            console.log('[MailinkInboxPanel] Maximized');
        }
    }

    /**
     * Toggle minimize/restore
     */
    toggleMinimize() {
        const panel = this._shadow.querySelector('.inbox-panel');
        if (!panel) return;

        // Check whether it is the minimized state after dragging
        const isDraggedMinimized = panel.classList.contains('minimized-dragged');

        if (this._isMinimized || isDraggedMinimized) {
            // Restore
            this._restorePosition();
            panel.classList.remove('minimized', 'minimized-dragged');
            
            // Clear inline styles (if in dragged state)
            if (isDraggedMinimized) {
                panel.style.position = '';
                panel.style.left = '';
                panel.style.top = '';
                panel.style.right = '';
                panel.style.bottom = '';
                panel.style.width = '';
                panel.style.height = '';
                panel.style.borderRadius = '';
                panel.style.overflow = '';
            }
            
            this._isMinimized = false;
            console.log('[MailinkInboxPanel] Restored from minimized');
        } else {
            // If maximized, exit maximize first
            if (this._isMaximized) {
                panel.classList.remove('maximized');
                const maximizeBtn = this._shadow.getElementById('maximizeBtn');
                if (maximizeBtn) {
                    maximizeBtn.classList.remove('restore');
                    maximizeBtn.title = window.i18n?.t('common.maximize') || 'Maximize';
                }
                this._isMaximized = false;
            }
            
            // Save the current position (if not maximized)
            if (!this._savedPosition) {
                this._saveCurrentPosition();
            }
            
            // Minimize to the bottom-left corner
            panel.classList.add('minimized');
            this._isMinimized = true;
            console.log('[MailinkInboxPanel] Minimized to bottom-left');
        }
    }

    /**
     * Save the current position
     */
    _saveCurrentPosition() {
        const panel = this._shadow.querySelector('.inbox-panel');
        if (!panel) return;

        const rect = panel.getBoundingClientRect();
        this._savedPosition = {
            left: panel.style.left || rect.left + 'px',
            top: panel.style.top || rect.top + 'px',
            right: panel.style.right,
            bottom: panel.style.bottom,
            // Prefer the set width/height; if none, use the actual size
            width: panel.style.width || rect.width + 'px',
            height: panel.style.height || rect.height + 'px'
        };
        console.log('[MailinkInboxPanel] Position saved:', this._savedPosition);
    }

    /**
     * Restore position
     */
    _restorePosition() {
        const panel = this._shadow.querySelector('.inbox-panel');
        if (!panel || !this._savedPosition) return;

        // Remove maximize/minimize classes first so !important does not take effect
        panel.classList.remove('maximized', 'minimized');
        
        // Then set inline styles
        panel.style.left = this._savedPosition.left;
        panel.style.top = this._savedPosition.top;
        panel.style.right = this._savedPosition.right;
        panel.style.bottom = this._savedPosition.bottom;
        panel.style.width = this._savedPosition.width;
        panel.style.height = this._savedPosition.height;
        
        console.log('[MailinkInboxPanel] Position restored');
    }

    /**
     * Drag start
     */
    _onDragStart(event) {
        // Ignore clicks on control buttons (close, maximize, minimize, refresh)
        if (event.target.closest('.close-btn, .maximize-btn, .minimize-btn, .refresh-btn')) {
            return;
        }

        const panel = this._shadow.querySelector('.inbox-panel');
        if (!panel) return;

        event.preventDefault();

        const rect = panel.getBoundingClientRect();
        this._dragOffsetX = event.clientX - rect.left;
        this._dragOffsetY = event.clientY - rect.top;
        this._isDragging = true;

        // Add drag style
        panel.classList.add('dragging');

        // If minimized, use CSS variables to set position and keep the minimized class to maintain the hidden element state
        if (this._isMinimized) {
            // Use CSS variables to override position so !important remains effective
            panel.style.setProperty('--drag-left', `${rect.left}px`);
            panel.style.setProperty('--drag-bottom', `${window.innerHeight - rect.bottom}px`);
        } else {
            // Normal state: set initial position (convert from right/bottom to left/top)
            // Width/height must be set before setting right/bottom to auto, otherwise dimensions will be lost
            panel.style.width = `${rect.width}px`;
            panel.style.height = `${rect.height}px`;
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        }

        // Bind global events
        document.addEventListener('mousemove', this._boundOnDragMove);
        document.addEventListener('mouseup', this._boundOnDragEnd);

        console.log('[MailinkInboxPanel] Drag started');
    }

    /**
     * Drag move
     */
    _onDragMove(event) {
        if (!this._isDragging) return;

        const panel = this._shadow.querySelector('.inbox-panel');
        if (!panel) return;

        // Calculate the new position, constrained within the window
        const panelWidth = panel.offsetWidth;
        const panelHeight = panel.offsetHeight;
        const maxLeft = Math.max(0, window.innerWidth - panelWidth);
        const maxTop = Math.max(0, window.innerHeight - panelHeight);

        // Title bar height is 32px; restrict top from crossing title bar
        const titlebarHeight = 32;
        const newLeft = Math.min(Math.max(0, event.clientX - this._dragOffsetX), maxLeft);
        const newTop = Math.min(Math.max(titlebarHeight, event.clientY - this._dragOffsetY), maxTop);

        // If minimized, use CSS variables to update position
        if (panel.classList.contains('minimized')) {
            panel.style.setProperty('--drag-left', `${newLeft}px`);
            panel.style.setProperty('--drag-bottom', `${window.innerHeight - newTop - panelHeight}px`);
        } else {
            panel.style.left = `${newLeft}px`;
            panel.style.top = `${newTop}px`;
        }
    }

    /**
     * Drag end
     */
    _onDragEnd() {
        if (!this._isDragging) return;

        const panel = this._shadow.querySelector('.inbox-panel');
        if (panel) {
            panel.classList.remove('dragging');
            
            // If minimized, remove the minimized class and set inline styles to maintain position
            if (panel.classList.contains('minimized')) {
                const left = panel.style.getPropertyValue('--drag-left') || '20px';
                const bottom = panel.style.getPropertyValue('--drag-bottom') || '20px';
                
                // Remove the minimized class but keep the minimized appearance (via inline styles)
                panel.classList.remove('minimized');
                
                // Set inline styles to maintain the minimized state's position and size
                panel.style.position = 'fixed';
                panel.style.left = left;
                panel.style.top = 'auto';
                panel.style.right = 'auto';
                panel.style.bottom = bottom;
                panel.style.width = '200px';
                panel.style.height = '48px';
                panel.style.borderRadius = '8px';
                panel.style.overflow = 'hidden';
                
                // Manually hide the content area and buttons (by adding special classes)
                panel.classList.add('minimized-dragged');
                
                // Save position
                this._savedPosition = {
                    left: left,
                    top: 'auto',
                    right: 'auto',
                    bottom: bottom,
                    width: '200px',
                    height: '48px'
                };
            } else {
                // Save the current position for maximize/minimize restore
                this._saveCurrentPosition();
            }
        }

        this._isDragging = false;

        // Remove global events
        document.removeEventListener('mousemove', this._boundOnDragMove);
        document.removeEventListener('mouseup', this._boundOnDragEnd);

        console.log('[MailinkInboxPanel] Drag ended');
    }

    /**
     * Enforce position constraints
     * Check and auto-fit constraints on click to ensure component top does not cross title bar
     */
    _enforcePositionLimit() {
        // Do not handle when maximized or minimized
        if (this._isMaximized || this._isMinimized) return;

        const panel = this._shadow.querySelector('.inbox-panel');
        if (!panel) return;

        const titlebarHeight = 32;
        const rect = panel.getBoundingClientRect();
        const panelWidth = rect.width;
        const panelHeight = rect.height;
        let needsUpdate = false;

        // Calculate current left/top (convert if positioned with right/bottom)
        const computedStyle = window.getComputedStyle(panel);
        let currentLeft = parseInt(computedStyle.left) || rect.left;
        let currentTop = rect.top;

        // Check if top exceeds title bar
        if (rect.top < titlebarHeight) {
            currentTop = titlebarHeight;
            needsUpdate = true;
        }

        // Check if left side exceeds boundary
        if (rect.left < 0) {
            currentLeft = 0;
            needsUpdate = true;
        }

        // Check if right side exceeds boundary
        if (rect.right > window.innerWidth) {
            currentLeft = window.innerWidth - panelWidth;
            needsUpdate = true;
        }

        // Check if bottom exceeds boundary
        if (rect.bottom > window.innerHeight) {
            currentTop = window.innerHeight - panelHeight;
            needsUpdate = true;
        }

        if (needsUpdate) {
            // Apply new position
            panel.style.left = `${currentLeft}px`;
            panel.style.top = `${currentTop}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';

            // Save position
            this._saveCurrentPosition();

            console.log('[MailinkInboxPanel] Position enforced:', { left: currentLeft, top: currentTop });
        }
    }
}

// Register custom element
if (!customElements.get('mailink-inbox-panel')) {
    customElements.define('mailink-inbox-panel', MailinkInboxPanel);
}

export default MailinkInboxPanel;
