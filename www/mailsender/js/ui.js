import { sendLogToParent, buildAvatarHtml } from './utils.js';
import { getColorFromHash } from '../../../shared/utils/math.js';
import { getMyEmail } from '../../utils/common.js';

export function htmlToPlainText(html) {
    if (!html) return '';
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    // 1. Check if it is an image message
    const imgEl = tempDiv.querySelector('img');
    if (imgEl) {
        const alt = imgEl.getAttribute('alt');
        if (alt && alt.trim()) {
            return `[Image] ${alt.trim()}`;
        }
        // Try to get filename from data-stored-filename
        const container = imgEl.closest('.image-message, [data-stored-filename]');
        if (container) {
            const storedFileName = container.getAttribute('data-stored-filename');
            if (storedFileName) {
                const fileName = decodeURIComponent(storedFileName).split(/[\\/]/).pop();
                if (fileName) return `[Image] ${fileName}`;
            }
        }
        return '[Image]';
    }

    // 2. Check if it is an audio/video/normal file message
    const fileNameEl = tempDiv.querySelector('.file-name');
    if (fileNameEl) {
        const fileName = fileNameEl.textContent.trim();
        if (fileName) {
            return `[file] ${fileName}`;
        }
    }

    // 3. Check file-request-message type
    const fileRequest = tempDiv.querySelector('.file-request-message');
    if (fileRequest) {
        const name = fileRequest.querySelector('.file-name')?.textContent.trim();
        if (name) return `[file] ${name}`;
    }

    // 4. Check if it is a file request container (no .file-name but could be file message)
    const fileRequestContainer = tempDiv.querySelector('.file-request, [id^="file-request-"]');
    if (fileRequestContainer) {
        // Try to get from data-stored-filename
        const storedFileName = fileRequestContainer.getAttribute('data-stored-filename');
        if (storedFileName) {
            const fileName = decodeURIComponent(storedFileName).split(/[\\/]/).pop();
            if (fileName) return `[file] ${fileName}`;
        }
        // Try to get from data-file-path
        const filePath = fileRequestContainer.getAttribute('data-file-path');
        if (filePath) {
            const fileName = filePath.split(/[\\/]/).pop();
            if (fileName) return `[file] ${fileName}`;
        }
        return '[file]';
    }

    // 5. Check if it is an audio message container
    const audioContainer = tempDiv.querySelector('.audio-message');
    if (audioContainer) {
        const fileName = audioContainer.querySelector('.file-name')?.textContent.trim();
        if (fileName) return `[audio] ${fileName}`;
        return '[audio]';
    }

    // 6. Check if it is a video message container
    const videoContainer = tempDiv.querySelector('.streaming-video-message, .video-message');
    if (videoContainer) {
        const fileName = videoContainer.querySelector('.file-name')?.textContent.trim();
        if (fileName) return `[video] ${fileName}`;
        return '[video]';
    }

    // 7. Finally try to get text content
    let text = tempDiv.textContent || tempDiv.innerText || '';
    return text.trim();
}

export function showStatus(message, type = 'info') {
    if (window.uiStatus && typeof window.uiStatus.showStatus === 'function') {
        window.uiStatus.showStatus(message, type);
    }
}

export function clearStatus() {
    if (window.uiStatus && typeof window.uiStatus.clearStatus === 'function') {
        window.uiStatus.clearStatus();
    }
}

export async function showUserAvatar() {
    try {
        const myEmail = getMyEmail();
        if (!myEmail) {
            return;
        }

        const avatarElement = document.getElementById('user-avatar');
        if (!avatarElement) {
            return;
        }

        let avatar = null;

        // Priority 1: check user-configured avatar
        try {
            const currentConfig = window.parent.getSelectedConfig();
            if (currentConfig && currentConfig.avatar) {
                avatar = currentConfig.avatar;
            }
        } catch (e) { }

        // Priority 2: check locally stored avatar
        if (!avatar) {
            try {
                const storedConfig = localStorage.getItem('userConfig');
                if (storedConfig) {
                    const config = JSON.parse(storedConfig);
                    if (config.avatar) {
                        avatar = config.avatar;
                    }
                }
            } catch (e) { console.debug('Failed to get avatar from localStorage:', e); }
        }

        // Priority 3: auto-generate fallback avatar
        if (!avatar) {
            avatar = generateAvatarForLogin(myEmail);
        }

        avatarElement.innerHTML = buildAvatarHtml(avatar);
        avatarElement.title = myEmail;
    } catch (error) {
        sendLogToParent('Failed to display user avatar: ' + error, 'error');
    }
}

function generateAvatarForLogin(email) {
    if (!email || !email.includes('@')) {
        return '';
    }

    const hash = hashCode(email);
    const localPart = email.split('@')[0];
    let chars = '';
    if (localPart.length >= 4) {
        chars = (localPart.substring(0, 2) + localPart.slice(-2)).toUpperCase();
    } else {
        chars = (localPart + localPart).substring(0, 4).toUpperCase();
    }

    const grayLevel = 240 + (Math.abs(hash) % 10);
    const bgColor = `rgb(${grayLevel}, ${grayLevel}, ${grayLevel})`;

    const colors = [
        getColorFromHash(hash, 0),
        getColorFromHash(hash, 1),
        getColorFromHash(hash, 2),
        getColorFromHash(hash, 3)
    ];

    const svg = `
        <svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
            <rect width="48" height="48" fill="${bgColor}" rx="5" ry="5" />
            <text x="12" y="20" font-size="18" font-weight="bold" fill="${colors[0]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[0]}</text>
            <text x="36" y="20" font-size="18" font-weight="bold" fill="${colors[1]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[1]}</text>
            <text x="12" y="44" font-size="18" font-weight="bold" fill="${colors[2]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[2]}</text>
            <text x="36" y="44" font-size="18" font-weight="bold" fill="${colors[3]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[3]}</text>
        </svg>
    `.trim();

    return svg;
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
}



export function updateContactAvatar(email, avatar) {
    if (!email) return false;
    const normalizedEmail = String(email).trim().toLowerCase();
    
    const contactList = document.getElementById('contact-list');
    if (contactList && contactList._updateContactAvatar) {
        contactList._updateContactAvatar(normalizedEmail, avatar);
        console.log(`🖼️  Updated in contact list ${email} 's avatar`);
        return true;
    }
    
    return false;
}

export function updateContactLastMessage(email, message) {
    if (!email) return;

    const normalizedEmail = String(email).trim().toLowerCase();
    
    const contactList = document.getElementById('contact-list');
    if (contactList && contactList._refreshContactLastMessage) {
        contactList._refreshContactLastMessage(normalizedEmail);
    }
}

export function initLogoutFunctionality() {
    const logoutBtn = document.getElementById('logout-btn');

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            const logoutConfirmMsg = window.i18n?.t ? window.i18n.t('dialog.logoutConfirm') : 'Are you sure you want to log out?';
            if (confirm(logoutConfirmMsg)) {
                // Stop business workers (via parent page)
                if (window.parent && window.parent.stopBusinessWorkers) {
                    window.parent.stopBusinessWorkers();
                }
                if (window.parent) {
                    window.parent.location.reload();
                } else {
                    window.location.reload();
                }
            }
        });
    }
}

export function initAddContactFunctionality() {
    const addContactBtn = document.getElementById('add-contact-btn');
    const modal = document.getElementById('add-contact-modal');
    const closeBtn = document.querySelector('.close');
    const saveBtn = document.getElementById('save-contact-btn');
    const cancelBtn = document.getElementById('cancel-contact-btn');

    function showModal() {
        modal.classList.add('show');
    }

    function hideModal() {
        modal.classList.remove('show');
        document.getElementById('contact-name').value = '';
        document.getElementById('contact-email').value = '';
    }

    if (addContactBtn) addContactBtn.addEventListener('click', showModal);
    if (closeBtn) closeBtn.addEventListener('click', hideModal);
    if (cancelBtn) cancelBtn.addEventListener('click', hideModal);

    window.addEventListener('click', (event) => {
        if (event.target == modal) {
            hideModal();
        }
    });

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const name = document.getElementById('contact-name').value.trim();
            const email = document.getElementById('contact-email').value.trim();

            if (!name) {
                showStatus(window.i18n?.t ? window.i18n.t('sender.friendNameRequired') : 'Please enter friend's name', 'error');
                return;
            }

            if (!email) {
                showStatus(window.i18n?.t ? window.i18n.t('sender.contactEmailRequired') : 'Please enter contact email', 'error');
                return;
            }

            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                showStatus(window.i18n?.t ? window.i18n.t('errors.pleaseEnterValidEmail') : 'please enter a valid email address', 'error');
                return;
            }

            try {
                const myEmail = getMyEmail();
                if (!myEmail) {
                    showStatus(window.i18n?.t ? window.i18n.t('login.pleaseLoginFirst') : 'Please log in first', 'error');
                    return;
                }

                // Restriction: cannot add the currently logged-in IMAP account email address as a contact
                const normalizedMyEmail = myEmail.trim().toLowerCase();
                const normalizedContactEmail = email.trim().toLowerCase();
                if (normalizedContactEmail === normalizedMyEmail) {
                    showStatus(window.i18n?.t ? window.i18n.t('sender.cannotAddSelf') : 'Cannot add yourself as a contact', 'error');
                    console.warn(`[Add Contact] Cannot add yourself as a contact: ${email}`);
                    return;
                }

                await window.parent.electronAPI.addContact(myEmail, {
                    rmkname: name,
                    username: email
                });

                showStatus(window.i18n?.t ? window.i18n.t('sender.addContactSuccess') : 'Contact added successfully', 'success');
                
                const contactList = document.getElementById('contact-list');
                if (contactList) {
                    contactList.refresh();
                }
                
                hideModal();

            } catch (error) {
                sendLogToParent('Failed to add contact: ' + error, 'error');
                const addFriendFailedMsg = window.i18n?.t ? window.i18n.t('sender.addFriendFailed') : 'Failed to add friend';
                showStatus(addFriendFailedMsg + ': ' + error.message, 'error');
            }
        });
    }
}
