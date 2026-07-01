// UI management module

// Show status message
export function showStatus(message, type = 'info') {
    if (window.uiStatus && typeof window.uiStatus.showStatus === 'function') {
        window.uiStatus.showStatus(message, type);
    }
}

// Clear status message
export function clearStatus() {
    if (window.uiStatus && typeof window.uiStatus.clearStatus === 'function') {
        window.uiStatus.clearStatus();
    }
}

// Set callbacks for the mailink-recver component
export function setupMailrecverCallbacks() {
    const mailrecver = document.getElementById('mailrecver');
    if (!mailrecver) return;

    mailrecver.onFetchEmails = (data) => {
        console.log('📧 Received email fetch request:', data);
        if (typeof window.fetchEmails === 'function') {
            window.fetchEmails(data.minutes);
        }
    };

    mailrecver.onWebRTCSignal = (data) => {
        const logMsg = `[debug] ui-manager: onWebRTCSignal called, event=${data?.event}, from=${data?.data?.from || data?.sender}`;
        console.log(logMsg, data);
        if (window.electronAPI?.log) {
            window.electronAPI.log('info', logMsg, 'Debug');
        }
        console.log('[WebRTC] Received signaling data:', data);
        if (typeof window.handleWebRTCSignal === 'function') {
            console.log('[Debug] ui-manager: calling window.handleWebRTCSignal');
            if (window.electronAPI?.log) {
                window.electronAPI.log('info', '[Debug] ui-manager: calling window.handleWebRTCSignal', 'Debug');
            }
            window.handleWebRTCSignal(data);
        } else {
            console.error('[debug] ui-manager: window.handleWebRTCSignal not a function');
            if (window.electronAPI?.log) {
                window.electronAPI.log('error', '[Debug] ui-manager: window.handleWebRTCSignal is not a function', 'Debug');
            }
        }
    };

    mailrecver.onForwardLog = (logData) => {
        console.log(`[Recver ${logData.type}] ${logData.content}`);
    };
}

// Update UI after login
export function updateUIAfterLogin() {
    // Hide config area first
    const configSection = document.querySelector('.config-section');
    if (configSection) {
        configSection.style.display = 'none';
    }

    // Then show the side-by-side webcom container
    const webcomContainer = document.querySelector('.webcom-container');
    webcomContainer.style.display = 'flex';
    webcomContainer.classList.add('visible');

    // Show maximize button after successful login
    const maximizeBtn = document.getElementById('maximizeBtn');
    if (maximizeBtn) {
        maximizeBtn.style.display = 'flex';
    }

    // Allow scrollbar to show automatically after login as needed
    document.body.classList.add('logged-in');
}

// Reload webcom
export function reloadWebcoms(autoClick = false) {
    const mailrecver = document.getElementById('mailrecver');
    const sendmailElement = document.querySelector('mailink-sender');
    
    mailrecver.src = mailrecver.src;
    if (sendmailElement && autoClick) {
        sendmailElement.dispatchEvent(new CustomEvent('autoClick'));
    }
    
    if (sendmailElement && typeof sendmailElement.showUserAvatar === 'function') {
        sendmailElement.showUserAvatar();
        console.log('📤 callmailink-senderShow user avatar method');
    }
}

// Notify connection status change
export function notifyConnectionStatusChange(isConnected) {
    if (isConnected) {
        console.log('✅ Connection restored, restart polling');
        window.startPolling();
        showStatus(window.i18n?.t('status.mailboxConnectionRestored') || 'Mailbox connection restored', 'success');
    } else {
        console.log('❌ Connection lost, stop polling');
        window.stopPolling();
        showStatus(window.i18n?.t('status.mailboxConnectionLost') || 'Mailbox connection lost, trying to reconnect...', 'warning');
    }

    // Notify all webcoms
    const mailrecver = document.getElementById('mailrecver');
    const mailinkSender = document.querySelector('mailink-sender');
    const chatWebcoms = document.querySelectorAll('.webcom-wrapper:not(:first-child) mailink-chat');
    
    // Notify mailrecver
    if (mailrecver) {
        mailrecver.dispatchEvent(new CustomEvent('connectionStatusChange', {
            detail: { isConnected: isConnected }
        }));
    }
    
    // Notify mailink-sender component
    if (mailinkSender) {
        mailinkSender.dispatchEvent(new CustomEvent('connectionStatusChange', {
            detail: { status: isConnected ? 'connected' : 'disconnected' }
        }));
    }
    
    // Notify chat webcom
    chatWebcoms.forEach(webcom => {
        if (webcom.contentWindow) {
            webcom.contentWindow.postMessage({
                type: 'connectionStatusChange',
                isConnected: isConnected
            }, '*');
        }
    });
}

// Send email data to mailink-recver component
export function sendEmailsToWebcom(emails) {
    const mailrecver = document.getElementById('mailrecver');
    if (mailrecver && typeof mailrecver.postMessage === 'function') {
        mailrecver.postMessage({
            type: 'emailsData',
            emails: emails
        });
    } else if (mailrecver && mailrecver.contentWindow) {
        mailrecver.contentWindow.postMessage({
            type: 'emailsData',
            emails: emails
        }, '*');
    }
}

// Send error info to mailink-recver component
export function sendFetchErrorToWebcom(errorMessage) {
    const mailrecver = document.getElementById('mailrecver');
    if (mailrecver && typeof mailrecver.postMessage === 'function') {
        mailrecver.postMessage({
            type: 'fetchError',
            error: errorMessage
        });
    } else if (mailrecver && mailrecver.contentWindow) {
        mailrecver.contentWindow.postMessage({
            type: 'fetchError',
            error: errorMessage
        }, '*');
    }
}

// Function to update contact avatar
export function updateContactAvatar(email, avatar) {
    console.log(`🖼️  Received update contact ${email} avatar request`);

    // Directly notify sendmail.html page to update the corresponding contact's avatar
    const sendmailWebcom = document.querySelector('mailink-sender');
    if (sendmailWebcom) {
        sendmailWebcom.postMessage({
            type: 'updateContactAvatar',
            email: email,
            avatar: avatar
        });
        console.log(`📤 Notified sendmail page to update contact avatar for ${email}`);
    }
}

// Handle show config selection hint event
export function handleShowConfigSelectionPrompt(event) {
    console.log('⚠️  Received config selection prompt request, preparing to show config selection guide');
    showStatus('<div class="error">' + (window.i18n?.t('status.pleaseSelectConfigFirst') || 'Please select and log in to an email config on the left first!') + '</div>', 'error');

    // Highlight config selection area
    const configSection = document.querySelector('.config-section');
    if (configSection) {
        configSection.classList.add('highlight');

        // Remove highlight effect after 3 seconds
        setTimeout(() => {
            configSection.classList.remove('highlight');
        }, 3000);
    }

    // Scroll to config selection area
    const configSelect = document.getElementById('configSelect');
    if (configSelect) {
        configSelect.scrollIntoView({ behavior: 'smooth', block: 'center' });
        configSelect.focus();
    }
}
