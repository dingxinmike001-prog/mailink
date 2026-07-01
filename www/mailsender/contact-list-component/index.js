const TAG_NAME = 'mailink-contact-list';
import { buildAvatarHtml } from '../../utils/avatar-html.js';
import { getMyEmail } from '../../utils/common.js';

function applyEventTargetMixin(targetClass) {
    targetClass.prototype.addEventListener = HTMLElement.prototype.addEventListener;
    targetClass.prototype.removeEventListener = HTMLElement.prototype.removeEventListener;
    targetClass.prototype.dispatchEvent = HTMLElement.prototype.dispatchEvent;
    return targetClass;
}

async function fetchWithConcurrencyLimit(tasks, limit = 5) {
    const results = [];
    const executing = [];
    
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        results.push(p);
        
        if (tasks.length >= limit) {
            const e = p.then(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            
            if (executing.length >= limit) {
                await Promise.race(executing);
            }
        }
    }
    
    return Promise.all(results);
}

function formatLastMessageTime(timestamp) {
    if (!timestamp) return '';
    
    let msTimestamp;
    if (typeof timestamp === 'string') {
        if (timestamp.length > 15) {
            msTimestamp = Number(BigInt(timestamp) / 1000000n);
        } else {
            msTimestamp = Number(timestamp);
        }
    } else if (typeof timestamp === 'number') {
        msTimestamp = timestamp > 1e15 ? Math.floor(timestamp / 1e6) : timestamp;
    } else {
        msTimestamp = Number(timestamp);
    }
    
    const date = new Date(msTimestamp);
    if (isNaN(date.getTime())) return '';
    
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    
    return `${day}${window.i18n?.t('common.daySuffix') || ''} ${hours}:${minutes}`;
}

function htmlToPlainText(html) {
    if (!html) return '';
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    // 1. Check if it is an image message
    const imgEl = tempDiv.querySelector('img');
    if (imgEl) {
        const alt = imgEl.getAttribute('alt');
        if (alt && alt.trim()) {
            return `[${window.i18n?.t('common.image') || 'Image'}] ${alt.trim()}`;
        }
        const container = imgEl.closest('.image-message, [data-stored-filename]');
        if (container) {
            const storedFileName = container.getAttribute('data-stored-filename');
            if (storedFileName) {
                const fileName = decodeURIComponent(storedFileName).split(/[\\/]/).pop();
                if (fileName) return `[${window.i18n?.t('common.image') || 'Image'}] ${fileName}`;
            }
        }
        return `[${window.i18n?.t('common.image') || 'Image'}]`;
    }

    // 2. Check if it is an audio/video/normal file message
    const fileNameEl = tempDiv.querySelector('.file-name');
    if (fileNameEl) {
        const fileName = fileNameEl.textContent.trim();
        if (fileName) {
            return `[File] ${fileName}`;
        }
    }

    // 3. Check file-request-message type
    const fileRequest = tempDiv.querySelector('.file-request-message');
    if (fileRequest) {
        const name = fileRequest.querySelector('.file-name')?.textContent.trim();
        if (name) return `[File] ${name}`;
    }

    // 4. Check if it is a file request container (no .file-name but could be file message)
    const fileRequestContainer = tempDiv.querySelector('.file-request, [id^="file-request-"]');
    if (fileRequestContainer) {
        // Try to get from data-stored-filename
        const storedFileName = fileRequestContainer.getAttribute('data-stored-filename');
        if (storedFileName) {
            const fileName = decodeURIComponent(storedFileName).split(/[\\/]/).pop();
            if (fileName) return `[File] ${fileName}`;
        }
        // Try to get from data-file-path
        const filePath = fileRequestContainer.getAttribute('data-file-path');
        if (filePath) {
            const fileName = filePath.split(/[\\/]/).pop();
            if (fileName) return `[File] ${fileName}`;
        }
        return '[File]';
    }

    // 5. Check if it is an audio message container
    const audioContainer = tempDiv.querySelector('.audio-message');
    if (audioContainer) {
        const fileName = audioContainer.querySelector('.file-name')?.textContent.trim();
        if (fileName) return `[Audio] ${fileName}`;
        return '[Audio]';
    }

    // 6. Check if it is a video message container
    const videoContainer = tempDiv.querySelector('.streaming-video-message, .video-message');
    if (videoContainer) {
        const fileName = videoContainer.querySelector('.file-name')?.textContent.trim();
        if (fileName) return `[Video] ${fileName}`;
        return '[Video]';
    }

    // 7. Finally try to get text content
    let text = tempDiv.textContent || tempDiv.innerText || '';
    return text.trim();
}



function sendLogToParent(message, level = 'info') {
    if (window.parent && window.parent.sendLogToParent) {
        window.parent.sendLogToParent(message, level);
    } else {
        const prefix = level === 'error' ? '❌' : level === 'warning' ? '⚠️' : 'ℹ️';
        console.log(`${prefix} ${message}`);
    }
}

async function loadCSS() {
    try {
        const cssUrl = new URL('./contact-list.css', import.meta.url).href;
        const response = await fetch(cssUrl);
        if (response.ok) {
            return await response.text();
        }
        console.warn('[MailinkContactList] Failed to load CSS, using empty styles');
        return '';
    } catch (error) {
        console.warn('[MailinkContactList] Error loading CSS:', error);
        return '';
    }
}

let COMPONENT_STYLES = '';

export class MailinkContactList extends HTMLElement {
    constructor() {
        super();
        this._shadow = null;
        this._contactsContainer = null;
        this._isLoaded = false;
        this._isLoading = false;
        this._isRendering = false;
        this._currentSelectedEmail = null;
        this._pendingActivatedEmails = [];
        this._pendingLastMessageEmails = [];
        this._initialLoadAttempted = false;
        this._emptyStateTimer = null;
    }

    async connectedCallback() {
        if (this.shadowRoot) return;

        // Load CSS
        if (!COMPONENT_STYLES) {
            COMPONENT_STYLES = await loadCSS();
        }

        this._shadow = this.attachShadow({ mode: 'open' });
        this._shadow.innerHTML = `<style>${COMPONENT_STYLES}</style><div class="contacts-container"></div>`;

        this._contactsContainer = this._shadow.querySelector('.contacts-container');

        if (window.i18n?.registerRoot) window.i18n.registerRoot(this.shadowRoot);
        
        // Wait for i18n to be ready before initializing translation to avoid timing issues
        if (window.i18n?.whenReady) {
            await window.i18n.whenReady();
        }
        if (window.i18n?.initElements) window.i18n.initElements(this.shadowRoot);

        this._initEventListeners();
        
        if (window.isUserLoggedIn) {
            this._loadContacts();
        } else {
            this._renderEmpty(window.i18n?.t ? window.i18n.t('sender.waitingForLogin') : 'Waiting for user login...');
            const checkLogin = setInterval(() => {
                if (window.isUserLoggedIn) {
                    clearInterval(checkLogin);
                    this._loadContacts();
                }
            }, 500);
        }
    }

    disconnectedCallback() {
        this._cleanup();
    }

    _initEventListeners() {
        this._shadow.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.delete-btn');
            if (deleteBtn) {
                const email = deleteBtn.dataset.email;
                if (email) {
                    this._deleteContact(email, deleteBtn);
                }
                return;
            }

            const card = e.target.closest('.contact-card');
            if (card && !card.classList.contains('disabled')) {
                const email = card.dataset.value;
                this._selectContact(card, email);
            }
        });

        this._shadow.addEventListener('contextmenu', (e) => {
            console.log('[ContactList] Right-click event triggered');
            const card = e.target.closest('.contact-card');
            if (card && !card.classList.contains('disabled')) {
                e.preventDefault();
                const email = card.dataset.value;
                console.log('[ContactList] Right-clicked contact card:', email);
                const contact = this._getContactByEmail(email);
                console.log('[ContactList] Retrieved contact:', contact);
                if (contact) {
                    this._showContextMenu(e, contact);
                }
            }
        });

        window.addEventListener('message', this._handleParentMessage.bind(this));
        
        // Listen for contact restore completion event
        window.addEventListener('contactsUpdated', this._handleContactsUpdated.bind(this));

        this._handleLangChanged = this._handleLangChanged.bind(this);
        window.addEventListener('lang-changed', this._handleLangChanged);
    }
    
    _handleContactsUpdated(event) {
        const { detail } = event;
        if (detail && detail.source === 'contactBackupRestore') {
            sendLogToParent('Received contact restore completion event, refreshing contact list', 'info');
            if (this._emptyStateTimer) {
                clearTimeout(this._emptyStateTimer);
                this._emptyStateTimer = null;
            }
            this._loadContacts(true);
        }
    }

    _handleLangChanged() {
        if (window.i18n?.initElements) window.i18n.initElements(this.shadowRoot);
        if (this._isLoaded) this._loadContacts(true);
    }

    _showContextMenu(event, contact) {
        console.log('[ContactList] Showing context menu', contact);
        const existingMenu = this._shadow.querySelector('.context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.innerHTML = `
            <div class="context-menu-item" data-action="edit" data-email="${contact.email}" data-name="${contact.name || ''}" data-nickname="${contact.nickname || ''}">✏️ ${window.i18n?.t ? window.i18n.t('sender.editFriend') : 'Edit Friend'}</div>
            <div class="context-menu-item" data-action="delete" data-email="${contact.email}">🗑️ ${window.i18n?.t ? window.i18n.t('sender.deleteFriend') : 'Delete Friend'}</div>
        `;
        menu.style.position = 'fixed';
        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;
        menu.style.zIndex = '10000';

        menu.addEventListener('click', (e) => {
            console.log('[ContactList] Menu item clicked');
            const item = e.target.closest('.context-menu-item');
            if (item) {
                const action = item.dataset.action;
                const email = item.dataset.email;
                const name = item.dataset.name;
                const nickname = item.dataset.nickname;
                console.log('[ContactList] Executing action:', action, { email, name, nickname });
                if (action === 'edit') {
                    this._openEditContactModal({ email, name, nickname });
                } else if (action === 'delete') {
                    this._deleteContact(email);
                }
                menu.remove();
            }
        });

        this._shadow.appendChild(menu);
        console.log('[ContactList] Context menu added to DOM');

        const closeMenu = () => {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        };

        setTimeout(() => {
            document.addEventListener('click', closeMenu);
        }, 0);
    }

    _openEditContactModal(contact) {
        console.log('[ContactList] Opening edit contact modal:', contact);
        this._emit('openEditContactModal', { contact });
    }

    _handleParentMessage(event) {
        const { data } = event;
        if (!data) return;

        switch (data.type) {
            case 'webcomActivated':
                this._handleWebcomActivated(data.email);
                break;
            case 'refreshContacts':
                this._loadContacts(true);
                break;
            case 'updateContactAvatar':
                this._updateContactAvatar(data.email, data.avatar);
                break;
            case 'updateContactLastMessage':
                this._refreshContactLastMessage(data.email);
                break;
            case 'addContact':
                this._handleAddContact(data.contact);
                break;
            case 'contactAdded':
                this._handleContactAdded(data.contact);
                break;
            case 'updateUnreadCount':
                this._updateUnreadBadge(data.email, data.count);
                break;
        }
    }

    _updateUnreadBadge(email, count) {
        if (!email) return;

        const targetEmail = email.trim().toLowerCase();
        const contactCards = this._shadow.querySelectorAll('.contact-card');

        contactCards.forEach(card => {
            const cardEmail = (card.dataset.value || '').trim().toLowerCase();
            if (cardEmail === targetEmail) {
                const badge = card.querySelector('.unread-badge');
                if (badge) {
                    if (count > 0) {
                        badge.classList.remove('hidden');
                        badge.textContent = count > 99 ? '99+' : count.toString();
                    } else {
                        badge.classList.add('hidden');
                        badge.textContent = '0';
                    }
                }
            }
        });
    }

    _incrementUnreadBadge(email, count = 1) {
        if (!email) return;

        const targetEmail = email.trim().toLowerCase();
        const contactCards = this._shadow.querySelectorAll('.contact-card');

        contactCards.forEach(card => {
            const cardEmail = (card.dataset.value || '').trim().toLowerCase();
            if (cardEmail === targetEmail) {
                const badge = card.querySelector('.unread-badge');
                if (badge) {
                    let currentCount = parseInt(badge.textContent) || 0;
                    if (badge.textContent === '99+') {
                        return;
                    }
                    currentCount += count;
                    badge.classList.remove('hidden');
                    badge.textContent = currentCount > 99 ? '99+' : currentCount.toString();
                }
            }
        });
    }

    async _loadContacts(forceRefresh = false) {
        if (this._isLoading && !forceRefresh) {
            sendLogToParent('Contact list is loading, skipping duplicate request', 'debug');
            return;
        }

        if (this._isRendering) {
            sendLogToParent('Contact list is rendering, skipping duplicate request', 'debug');
            return;
        }

        // Check whether user is logged in
        const isUserLoggedIn = window.isUserLoggedIn || window.parent?.isUserLoggedIn;
        if (!isUserLoggedIn) {
            sendLogToParent('User not logged in, skipping contact load', 'debug');
            this._renderEmpty(window.i18n?.t ? window.i18n.t('sender.waitingForLogin') : 'Waiting for user login...');
            return;
        }

        // Clear previous empty-state timer
        if (this._emptyStateTimer) {
            clearTimeout(this._emptyStateTimer);
            this._emptyStateTimer = null;
        }

        try {
            this._isLoading = true;
            this._renderLoading();

            let myEmail = null;
            const config = window.selectedConfig || window.parent?.selectedConfig;
            if (config?.username) {
                myEmail = config.username;
            } else {
                alert(window.i18n?.t ? window.i18n.t('errors.cannotGetUserConfig') : 'Cannot get current user email configuration, please log in first');
            }

            if (!myEmail) {
                sendLogToParent(window.i18n?.t ? window.i18n.t('errors.cannotGetUserEmail') : 'Cannot get current user email, please log in first', 'error');
                alert(window.i18n?.t ? window.i18n.t('errors.cannotGetUserEmail') : 'Cannot get current user email, please log in first');
                this._renderEmpty(window.i18n?.t ? window.i18n.t('errors.cannotGetUserEmail') : 'Cannot get current user email, please log in first');
                return;
            }

            const contacts = await window.parent.electronAPI.getContacts(myEmail);

            if (contacts && contacts.length > 0) {
                const uniqueContacts = [];
                const seenEmails = new Set();
                for (const contact of contacts) {
                    if (contact.username) {
                        const trimmedEmail = contact.username.trim().toLowerCase();
                        if (!seenEmails.has(trimmedEmail)) {
                            seenEmails.add(trimmedEmail);
                            uniqueContacts.push(contact);
                        }
                    }
                }

                if (uniqueContacts.length > 0) {
                    sendLogToParent('Fetching contact last conversation records...', 'debug');
                    await this._renderContacts(uniqueContacts, myEmail);
                } else {
                    this._renderEmpty(window.i18n?.t ? window.i18n.t('sender.noFriends') : 'No friends, please add');
                }
            } else {
                // On first load with no contacts, delay showing empty state (waiting for CSV recovery)
                if (!this._initialLoadAttempted) {
                    this._initialLoadAttempted = true;
                    // Keep loading state for 3 seconds, waiting for CSV recovery to complete
                    this._emptyStateTimer = setTimeout(() => {
                        this._renderEmpty(window.i18n?.t ? window.i18n.t('sender.noFriends') : 'No friends, please add');
                    }, 3000);
                } else {
                    this._renderEmpty(window.i18n?.t ? window.i18n.t('sender.noFriends') : 'No friends, please add');
                }
            }

            this._isLoaded = true;
            this._processPendingMessages();
            sendLogToParent('Contact loading complete', 'info');
            
            this.dispatchEvent(new CustomEvent('contactsLoaded', {
                bubbles: true,
                composed: true
            }));
        } catch (error) {
            sendLogToParent('Failed to load contacts: ' + error.message, 'error');
            console.error('Failed to load contacts:', error);
            this._renderError(error.message);

            if ((error.message.includes('timeout') || error.message.includes('connect')) && !forceRefresh) {
                sendLogToParent(`Contact loading failed, retrying in 1 second...`, 'warning');
                setTimeout(() => this._loadContacts(true), 1000);
            }
        } finally {
            this._isLoading = false;
        }
    }

    async _renderContacts(contacts, myEmail) {
        if (this._isRendering) {
            sendLogToParent('Contact list is rendering, skipping duplicate render', 'debug');
            return;
        }

        try {
            this._isRendering = true;
            this._contactsContainer.innerHTML = '';

            const contactMessages = new Map();
            const unreadCounts = new Map();

            const fetchTasks = contacts
                .filter(contact => contact.username)
                .map(contact => async () => {
                    const msg = await this._fetchLastChatMessage(myEmail, contact.username);
                    contactMessages.set(contact.username, msg);
                });

            await fetchWithConcurrencyLimit(fetchTasks, 10);

            const unreadData = await this._fetchUnreadCounts(myEmail);
            if (unreadData && Array.isArray(unreadData)) {
                unreadData.forEach(item => {
                    // Use lowercase consistently as key to avoid lookup failures due to case mismatch with contact.username
                    unreadCounts.set(item.fromer.trim().toLowerCase(), item.unread_count);
                });
            }

            contacts.forEach(contact => {
                const card = this._createContactCard(contact, contactMessages, unreadCounts);
                this._contactsContainer.appendChild(card);
            });

            if (this._pendingActivatedEmails.length > 0) {
                this._pendingActivatedEmails.forEach(email => this._handleWebcomActivated(email));
                this._pendingActivatedEmails = [];
            }

            if (this._pendingLastMessageEmails.length > 0) {
                const uniqueEmails = [...new Set(this._pendingLastMessageEmails)];
                this._pendingLastMessageEmails = [];
                uniqueEmails.forEach(email => this._refreshContactLastMessage(email));
            }
        } catch (error) {
            sendLogToParent('Failed to render contacts: ' + error.message, 'error');
            console.error('Failed to render contacts:', error);
        } finally {
            this._isRendering = false;
        }
    }

    _createContactCard(contact, contactMessages, unreadCounts) {
        const card = document.createElement('div');
        card.className = 'contact-card';
        card.title = contact.username || 'No email';
        card.dataset.value = contact.username;
        card.dataset.nickname = contact.nickname || '';

        const avatar = contact.avatar;
        const lastMsgData = contactMessages.get(contact.username) || { content: window.i18n?.t ? window.i18n.t('sender.noChatHistory') : 'No chat history', time: 0 };
        const lastMsg = lastMsgData.content;
        const lastTime = formatLastMessageTime(lastMsgData.time);
        // Use lowercase key to look up unread count, consistent with unreadCounts keys (fromer lowercase)
        const unreadCount = unreadCounts.get(contact.username.trim().toLowerCase()) || 0;
        const badgeText = unreadCount > 99 ? '99+' : unreadCount.toString();
        const badgeClass = unreadCount > 0 ? 'unread-badge' : 'unread-badge hidden';

        let cardContent = '<div class="contact-card-content">';

        if (avatar) {
            cardContent += `<div class="contact-avatar" title="${contact.username}" style="display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; margin-right: 12px; border-radius: 5px; overflow: visible; position: relative;">${buildAvatarHtml(avatar)}<span class="${badgeClass}">${badgeText}</span></div>`;
        } else {
            cardContent += `<div class="contact-avatar placeholder" title="${contact.username}" style="display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; margin-right: 12px; background-color: #f0f0f0; border-radius: 5px; overflow: visible; position: relative;"><span class="${badgeClass}">${badgeText}</span></div>`;
        }

        cardContent += `<span class="delete-btn" data-email="${contact.username}">&times;</span>`;

        cardContent += `<div class="contact-info" style="flex: 1; min-width: 0;">`;
        cardContent += `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">`;
        cardContent += `<div style="display: flex; align-items: center;"><div class="contact-name" title="status: ${contact.status}" style="font-size: 14px; margin-bottom: 0;">${contact.rmkname || contact.nickname || (window.i18n?.t ? window.i18n.t('sender.unnamed') : 'Unnamed')}</div></div>`;
        cardContent += `<div class="contact-last-time">${lastTime ? `${lastTime}&nbsp;` : ''}</div>`;
        cardContent += `</div>`;
        cardContent += `<div class="contact-last-message" style="font-size: 12px; color: #666666; max-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${lastMsg}</div>`;
        cardContent += `</div>`;
        cardContent += `</div>`;

        card.innerHTML = cardContent;

        if (!contact.username) {
            card.classList.add('disabled');
            card.style.pointerEvents = 'none';
            card.style.opacity = '0.6';
            card.title = window.i18n?.t ? window.i18n.t('sender.noEmailCannotSend') : 'This friend has no email, cannot send email';
        }

        return card;
    }

    _selectContact(card, email) {
        this._shadow.querySelectorAll('.contact-card').forEach(c => {
            c.classList.remove('selected');
            c.classList.add('disabled');
            c.style.pointerEvents = 'none';
            c.style.opacity = '0.6';
        });

        card.classList.add('selected');
        card.classList.remove('disabled');
        card.style.pointerEvents = '';
        card.style.opacity = '';
        this._currentSelectedEmail = email;

        this._markContactAsRead(email, card);

        setTimeout(() => {
            this._shadow.querySelectorAll('.contact-card').forEach(c => {
                c.classList.remove('disabled');
                c.style.pointerEvents = '';
                c.style.opacity = '';
            });
        }, 1000);

        this._notifyParentContactSelected(email);
    }

    async _markContactAsRead(email, card) {
        try {
            const myEmail = getMyEmail();
            if (!myEmail) return;

            if (window.parent && window.parent.electronAPI && window.parent.electronAPI.markAllMessagesRead) {
                await window.parent.electronAPI.markAllMessagesRead({
                    myEmail: myEmail,
                    targetEmail: email
                });
            }

            const badge = card.querySelector('.unread-badge');
            if (badge) {
                badge.classList.add('hidden');
                badge.textContent = '0';
            }
        } catch (error) {
            sendLogToParent(`Failed to mark messages as read: ${error.message}`, 'debug');
        }
    }

    async _deleteContact(email, buttonElement) {
        if (!confirm(window.i18n?.t ? window.i18n.t('dialog.deleteFriendConfirm') : 'Are you sure you want to delete this friend?')) return;

        try {
            const myEmail = getMyEmail();
            if (!myEmail) {
                this._showStatus('Please log in first', 'error');
                return;
            }

            await window.parent.electronAPI.deleteContact(myEmail, email);

            const card = buttonElement
                ? buttonElement.closest('.contact-card')
                : this._shadow.querySelector(`.contact-card[data-value="${email}"]`);
            if (card) {
                card.remove();
            }

            window.parent.postMessage({
                type: 'deleteChatWebcom',
                email: email
            }, '*');

            this._emit('contactdeleted', { email });
            this._showStatus(window.i18n?.t ? window.i18n.t('sender.friendDeleteSuccess') : 'Friend deleted successfully', 'success');
            this._loadContacts(true);
        } catch (error) {
            sendLogToParent('Failed to delete contact: ' + error, 'error');
            console.error('Failed to delete contact:', error);
            this._showStatus((window.i18n?.t ? window.i18n.t('sender.friendDeleteFailed') : 'Failed to delete friend') + ': ' + error.message, 'error');
        }
    }

    async _addContact(contactData) {
        if (!contactData || !contactData.username) {
            this._showStatus(window.i18n?.t ? window.i18n.t('sender.friendInfoIncomplete') : 'Friend information incomplete', 'error');
            return false;
        }

        try {
            const myEmail = getMyEmail();
            if (!myEmail) {
                this._showStatus(window.i18n?.t ? window.i18n.t('login.pleaseLoginFirst') : 'Please log in first', 'error');
                return false;
            }

            // Restriction: cannot add the currently logged-in IMAP account email address as a contact
            const normalizedMyEmail = myEmail.trim().toLowerCase();
            const normalizedContactEmail = contactData.username.trim().toLowerCase();
            if (normalizedContactEmail === normalizedMyEmail) {
                this._showStatus(window.i18n?.t ? window.i18n.t('sender.cannotAddSelf') : 'Cannot add yourself as a friend', 'error');
                console.warn(`[Add Contact] Cannot add yourself as a contact: ${contactData.username}`);
                return false;
            }

            // Check whether contact already exists (check before saving)
            let isNewContact = false;
            try {
                if (window.parent.electronAPI && window.parent.electronAPI.getContacts) {
                    const contacts = await window.parent.electronAPI.getContacts(myEmail);
                    const existingContact = contacts.find(contact => contact.username === contactData.username);
                    isNewContact = !existingContact;
                    if (isNewContact) {
                        console.log(`🆕 [Add Contact] New contact: ${contactData.username}`);
                    } else {
                        console.log(`📝 [Add Contact] Contact already exists: ${contactData.username}`);
                    }
                }
            } catch (error) {
                console.warn('[Add Contact] Failed to check contact status:', error.message);
            }

            if (window.parent.electronAPI && window.parent.electronAPI.addContact) {
                await window.parent.electronAPI.addContact(myEmail, contactData);
            }

            this._emit('contactadded', { contact: contactData });
            this._showStatus(window.i18n?.t ? window.i18n.t('sender.friendAddSuccess') : 'Friend added successfully', 'success');
            this._loadContacts(true);

            // Send add-friend regular email
            await this._autoSendSignalingEmail(contactData.username, myEmail, isNewContact, contactData.readme);

            return true;
        } catch (error) {
            sendLogToParent('Failed to add contact: ' + error, 'error');
            console.error('Failed to add contact:', error);
            this._showStatus((window.i18n?.t ? window.i18n.t('sender.friendAddFailed') : 'Failed to add friend') + ': ' + error.message, 'error');
            return false;
        }
    }
    
    /**
     * Automatically send add-friend regular email
     * @param {string} targetEmail - Target contact email
     * @param {string} myEmail - Current user email
     * @param {boolean} isNewContact - Whether it is a new contact
     * @param {string} readmeContent - Friend request message content
     */
    async _autoSendSignalingEmail(targetEmail, myEmail, isNewContact = false, readmeContent = '') {
        try {
            console.log(`📧 [Add Friend] Preparing to send add-friend email to ${targetEmail}`);

            // Build email subject, limit request content to 32 characters
            const truncatedContent = readmeContent ? readmeContent.substring(0, 32) : '';
            const subject = `mailink_addfriend:[Add Friend] ${truncatedContent}`;

            // Email body
            const body = readmeContent || 'Request to add you as a friend';

            // Get email config
            const config = window.parent?.getSelectedConfig?.() || window.getSelectedConfig?.();
            if (!config) {
                console.warn('[Add Friend] Cannot get email configuration');
                return;
            }

            // Send regular email
            if (window.parent?.electronAPI?.sendemail) {
                await window.parent.electronAPI.sendemail(config, {
                    to: targetEmail,
                    subject: subject,
                    text: body
                });
                console.log(`✅ [Add Friend] Email sent to ${targetEmail}`);
                this._showStatus('Friend request sent', 'success');
            } else {
                console.warn('[Add Friend] Email sending interface unavailable');
            }
        } catch (error) {
            console.error('[Add Friend] Failed to send email:', error);
        }
    }

    _handleAddContact(contactData) {
        if (contactData) {
            this._addContact(contactData);
        }
    }

    _handleContactAdded(contactData) {
        if (contactData && this._isLoaded) {
            this._loadContacts(true);
        }
    }

    _handleWebcomActivated(email) {
        if (!email) return;

        const trimmedEmail = email.trim();
        this._currentSelectedEmail = trimmedEmail;

        this._shadow.querySelectorAll('.contact-card').forEach(card => {
            card.classList.remove('selected');
        });

        const contactCards = this._shadow.querySelectorAll('.contact-card');
        let found = false;
        contactCards.forEach(card => {
            if (card.dataset.value) {
                const cardEmail = card.dataset.value.trim().toLowerCase();
                if (cardEmail === trimmedEmail.toLowerCase()) {
                    card.classList.add('selected');
                    found = true;
                }
            }
        });

        if (!found && !this._isLoaded) {
            this._pendingActivatedEmails.push(trimmedEmail);
        }
    }

    async _fetchLastChatMessage(myEmail, contactEmail) {
        try {
            if (!window.parent || !window.parent.electronAPI || !window.parent.electronAPI.getHistoryMessages) {
                console.warn(`⚠️ electronAPI.getHistoryMessages unavailable, cannot get chat history for ${contactEmail}`);
                return { content: '', time: 0 };
            }

            const messages = await window.parent.electronAPI.getHistoryMessages({
                myEmail: myEmail,
                targetEmail: contactEmail
            });

            if (messages && messages.length > 0) {
                const lastMessage = messages[0];
                return {
                    content: htmlToPlainText(lastMessage.content),
                    time: lastMessage.createtime || 0
                };
            }
            console.log(`📭 No chat history for ${contactEmail}`);
            return { content: '', time: 0 };
        } catch (error) {
            sendLogToParent(`Failed to get last chat record for ${contactEmail}: ${error.message}`, 'debug');
            return { content: '', time: 0 };
        }
    }

    async _fetchUnreadCounts(myEmail) {
        try {
            if (!window.parent || !window.parent.electronAPI || !window.parent.electronAPI.getUnreadCount) {
                console.warn('electronAPI.getUnreadCount unavailable');
                return [];
            }

            const unreadData = await window.parent.electronAPI.getUnreadCount({ myEmail });
            return unreadData || [];
        } catch (error) {
            sendLogToParent(`Failed to get unread message count: ${error.message}`, 'debug');
            return [];
        }
    }

    _updateContactLastMessage(email, messageData) {
        if (!email) return;

        const targetEmail = email.trim().toLowerCase();
        const contactCards = this._shadow.querySelectorAll('.contact-card');

        contactCards.forEach(card => {
            const cardEmail = (card.dataset.value || '').trim().toLowerCase();
            if (cardEmail === targetEmail) {
                const lastMessageElement = card.querySelector('.contact-last-message');
                if (lastMessageElement) {
                    const displayText = (typeof messageData === 'string' ? messageData : messageData.content).trim() || (window.i18n?.t ? window.i18n.t('sender.noChatHistory') : 'No chat history');
                    lastMessageElement.textContent = displayText;
                    lastMessageElement.style.fontSize = '12px';
                    lastMessageElement.style.color = '#666666';
                }

                const lastTimeElement = card.querySelector('.contact-last-time');
                if (lastTimeElement) {
                    const time = (typeof messageData === 'object' && messageData.time) ? messageData.time : 0;
                    if (time) {
                        lastTimeElement.innerHTML = `${formatLastMessageTime(time)}&nbsp;`;
                    }
                }
            }
        });
    }

    _refreshContactLastMessage(email) {
        if (!email) return;

        const trimmedEmail = email.trim();
        if (!this._isLoaded) {
            if (!this._pendingLastMessageEmails.includes(trimmedEmail)) {
                this._pendingLastMessageEmails.push(trimmedEmail);
            }
            return;
        }

        const myEmail = getMyEmail();
        if (!myEmail) return;

        setTimeout(async () => {
            const msgData = await this._fetchLastChatMessage(myEmail, trimmedEmail);
            this._updateContactLastMessage(trimmedEmail, msgData);
        }, 300);
    }

    _updateContactAvatar(email, avatar) {
        if (!email) return;

        const targetEmail = email.trim().toLowerCase();
        const contactCards = this._shadow.querySelectorAll('.contact-card');

        contactCards.forEach(card => {
            const cardEmail = (card.dataset.value || '').trim().toLowerCase();
            if (cardEmail === targetEmail) {
                const avatarElement = card.querySelector('.contact-avatar');
                if (avatarElement) {
                    avatarElement.innerHTML = buildAvatarHtml(avatar);
                }
            }
        });
    }

    _notifyParentContactSelected(email) {
        const contact = this._getContactByEmail(email);
        sendLogToParent('Selected contact: ' + (contact?.name || '') + ' (' + email + ')');

        this._emit('contactselected', { email, name: contact?.name || '' });

        window.dispatchEvent(new CustomEvent('contactSelected', {
            detail: { email }
        }));
    }

    _getContactByEmail(email) {
        if (!email) return null;
        const trimmedEmail = email.trim();
        const lowerEmail = trimmedEmail.toLowerCase();
        
        // Find card in a case-insensitive manner
        const cards = this._shadow.querySelectorAll('.contact-card');
        let card = null;
        for (const c of cards) {
            const cardEmail = (c.dataset.value || '').trim();
            if (cardEmail.toLowerCase() === lowerEmail) {
                card = c;
                break;
            }
        }
        
        if (!card) return null;

        const nameElement = card.querySelector('.contact-name');
        return {
            email: trimmedEmail,
            name: nameElement ? nameElement.textContent : '',
            nickname: card.dataset.nickname || ''
        };
    }

    _processPendingMessages() {
        if (this._pendingActivatedEmails.length > 0) {
            this._pendingActivatedEmails.forEach(email => this._handleWebcomActivated(email));
            this._pendingActivatedEmails = [];
        }
    }

    _renderEmpty(message) {
        this._contactsContainer.innerHTML = `<div class="empty-state">${message}</div>`;
    }

    _renderLoading() {
        this._contactsContainer.innerHTML = `<div class="loading-state">${window.i18n?.t ? window.i18n.t('sender.loadingContacts') : 'Loading friend list...'}</div>`;
    }

    _renderError(message) {
        this._contactsContainer.innerHTML = `<div class="error-state">${window.i18n?.t ? window.i18n.t('sender.loadContactsFailed') : 'Loading failed'}: ${message}</div>`;
    }

    _emit(eventType, detail) {
        this.dispatchEvent(new CustomEvent(eventType, {
            detail: detail,
            bubbles: true,
            composed: true
        }));
    }

    _showStatus(message, type = 'info') {
        this.dispatchEvent(new CustomEvent('status', {
            detail: { message, type },
            bubbles: true,
            composed: true
        }));
    }

    _cleanup() {
        window.removeEventListener('message', this._handleParentMessage.bind(this));
        window.removeEventListener('contactsUpdated', this._handleContactsUpdated.bind(this));
        window.removeEventListener('lang-changed', this._handleLangChanged);
        if (window.i18n?.unregisterRoot) window.i18n.unregisterRoot(this.shadowRoot);
        if (this._emptyStateTimer) {
            clearTimeout(this._emptyStateTimer);
            this._emptyStateTimer = null;
        }
    }

    get selectedEmail() {
        return this._currentSelectedEmail;
    }

    get isLoaded() {
        return this._isLoaded;
    }

    refresh() {
        this._loadContacts(true);
    }

    addContact(contactData) {
        return this._addContact(contactData);
    }

    async updateContact(contactData) {
        if (!contactData || !contactData.username) {
            this._showStatus(window.i18n?.t ? window.i18n.t('sender.friendInfoIncomplete') : 'Friend information incomplete', 'error');
            return false;
        }

        try {
            const myEmail = getMyEmail();
            if (!myEmail) {
                this._showStatus(window.i18n?.t ? window.i18n.t('login.pleaseLoginFirst') : 'Please log in first', 'error');
                return false;
            }

            if (window.parent.electronAPI && window.parent.electronAPI.updateContact) {
                await window.parent.electronAPI.updateContact(myEmail, contactData);
            }

            this._emit('contactupdated', { contact: contactData });
            this._showStatus('Friend updated successfully', 'success');
            this._loadContacts(true);

            return true;
        } catch (error) {
            sendLogToParent('Failed to update contact: ' + error, 'error');
            console.error('Failed to update contact:', error);
            this._showStatus((window.i18n?.t ? window.i18n.t('sender.friendUpdateFailed') : 'Failed to update friend') + ': ' + error.message, 'error');
            return false;
        }
    }

    removeContact(email) {
        if (!email) return false;
        const trimmedEmail = email.trim();
        const card = this._shadow.querySelector(`.contact-card[data-value="${trimmedEmail}"]`);
        if (card) {
            const deleteBtn = card.querySelector('.delete-btn');
            if (deleteBtn) {
                this._deleteContact(trimmedEmail, deleteBtn);
                return true;
            }
        }
        return false;
    }

    selectContact(email) {
        if (!email) return;
        const trimmedEmail = email.trim();
        const card = this._shadow.querySelector(`.contact-card[data-value="${trimmedEmail}"]`);
        if (card) {
            this._selectContact(card, trimmedEmail);
        }
    }

    getContactByEmail(email) {
        return this._getContactByEmail(email);
    }
}

if (!customElements.get(TAG_NAME)) {
    customElements.define(TAG_NAME, applyEventTargetMixin(MailinkContactList));
}

export { TAG_NAME };
