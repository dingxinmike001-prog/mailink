// Config management module
import { generateAvatar } from '../utils/index.js';

// Constants for mainstream domestic email configs
export const EMAIL_CONFIGS = {
    '163': {
        name: '163 Mail',
        imapHost: 'imap.163.com',
        imapPort: 993,
        smtpHost: 'smtp.163.com',
        smtpPort: 465
    },
    'qq': {
        name: 'QQ Mail',
        imapHost: 'imap.qq.com',
        imapPort: 993,
        smtpHost: 'smtp.qq.com',
        smtpPort: 465
    },
    '126': {
        name: '126 Mail',
        imapHost: 'imap.126.com',
        imapPort: 993,
        smtpHost: 'smtp.126.com',
        smtpPort: 465
    },
    'sina': {
        name: 'Sina Mail',
        imapHost: 'imap.sina.com',
        imapPort: 993,
        smtpHost: 'smtp.sina.com',
        smtpPort: 465
    },
    '189': {
        name: 'Telecom 189 Mail',
        imapHost: 'imap.189.cn',
        imapPort: 993,
        smtpHost: 'smtp.189.cn',
        smtpPort: 465
    },
    '139': {
        name: 'Mobile 139 Mail',
        imapHost: 'imap.139.com',
        imapPort: 993,
        smtpHost: 'smtp.139.com',
        smtpPort: 465
    },
    'qqex': {
        name: 'QQ Enterprise Mail',
        imapHost: 'imap.exmail.qq.com',
        imapPort: 993,
        smtpHost: 'smtp.exmail.qq.com',
        smtpPort: 465
    },
    'aliyun': {
        name: 'Alibaba Cloud Enterprise Mail',
        imapHost: 'imap.mxhichina.com',
        imapPort: 993,
        smtpHost: 'smtp.mxhichina.com',
        smtpPort: 465
    },
    'sohu': {
        name: 'Sohu Mail',
        imapHost: 'imap.sohu.com',
        imapPort: 993,
        smtpHost: 'smtp.sohu.com',
        smtpPort: 465
    },
    'gmail': {
        name: 'Gmail Mail',
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        smtpHost: 'smtp.gmail.com',
        smtpPort: 465
    },
    'yahoo': {
        name: 'Yahoo Mail',
        imapHost: 'imap.mail.yahoo.com',
        imapPort: 993,
        smtpHost: 'smtp.mail.yahoo.com',
        smtpPort: 465
    },
    'protonmail': {
        name: 'ProtonMail',
        imapHost: 'imap.proton.me',
        imapPort: 993,
        smtpHost: 'smtp.proton.me',
        smtpPort: 465
    },
    'outlook': {
        name: 'Outlook Mail',
        imapHost: 'imap-mail.outlook.com',
        imapPort: 993,
        smtpHost: 'smtp-mail.outlook.com',
        smtpPort: 587
    }
};

// Update config avatar display
function updateConfigAvatar(config) {
    const configAvatar = document.getElementById('configAvatar');
    if (!configAvatar) return;

    if (config && config.avatar) {
        configAvatar.src = config.avatar;
        configAvatar.style.display = 'block';
    } else {
        configAvatar.src = '';
        configAvatar.style.display = 'none';
    }
}

// Render config options
export function renderConfigs(configs) {
    const configSelect = document.getElementById('configSelect');
    const loginBtn = document.getElementById('loginBtn');
    const editConfigBtn = document.getElementById('editConfigBtn');

    // Handle when there is no data
    if (!configs || configs.length === 0) {
        configSelect.innerHTML = `<option value="">${window.i18n?.t('login.pleaseAddAccount') || 'Please add an email account first'}</option>`;
        // Hide login and edit buttons
        if (loginBtn) loginBtn.style.display = 'none';
        if (editConfigBtn) {
            editConfigBtn.style.display = 'none';
            editConfigBtn.disabled = true;
        }
        window.selectedConfig = null;
        // Clear avatar
        updateConfigAvatar(null);
        return;
    }

    // Show login and edit buttons when data exists
    if (loginBtn) loginBtn.style.display = '';
    if (editConfigBtn) {
        editConfigBtn.style.display = '';
        editConfigBtn.disabled = false;
    }

    // Clear existing options (do not show "Select login email" hint when accounts exist)
    configSelect.innerHTML = '';

    // Add config options
    configs.forEach(config => {
        const option = document.createElement('option');
        option.value = config.id; // Use config ID as option value
        option.textContent = `${config.name} (${config.username})`;
        configSelect.appendChild(option);
    });

    // Use onchange to avoid repeatedly adding event listeners and ensure the latest configs data is always used
    configSelect.onchange = () => {
        if (configSelect.value) {
            // Find selected config
            window.selectedConfig = configs.find(config => config.id === configSelect.value);

            // Update avatar display
            updateConfigAvatar(window.selectedConfig);

            // Enable login and edit buttons
            if (loginBtn) loginBtn.disabled = false;
            if (editConfigBtn) editConfigBtn.disabled = false;
            window.isImapConnected = false;

            // Stop current polling (if any)
            if (window.stopPolling) window.stopPolling();
            // Stop connection status sync
            if (window.stopStatusSync) window.stopStatusSync();

            // Hide side-by-side webcom container
            const webcomContainer = document.querySelector('.webcom-container');
            if (webcomContainer) webcomContainer.classList.remove('visible');

            // Re-show config area (needed when switching accounts because config area is hidden after login)
            const configSection = document.querySelector('.config-section');
            if (configSection) configSection.style.display = 'block';
        } else {
            // No config selected
            window.selectedConfig = null;
            if (loginBtn) loginBtn.disabled = true;
            if (editConfigBtn) editConfigBtn.disabled = true;
            // Clear avatar
            updateConfigAvatar(null);
        }
    };

    // Auto-select first config
    if (configs.length > 0) {
        const firstConfig = configs[0];
        configSelect.value = firstConfig.id;
        // Trigger onchange event handling logic
        window.selectedConfig = firstConfig;
        // Show first account's avatar
        updateConfigAvatar(firstConfig);
        if (loginBtn) loginBtn.disabled = false;
        if (editConfigBtn) editConfigBtn.disabled = false;

        console.log('Auto-selected first email account:', firstConfig.username);

        // Note：Do not warm up here/Test connection，Establish connection only after user clicks login button
    }
}

// Update avatar display
export async function updateAvatar() {
    const username = document.getElementById('username');
    const avatarPreview = document.getElementById('avatar-preview');
    const avatarInput = document.getElementById('avatar');

    // If current image is manually uploaded (starts with data:image), do not auto-overwrite
    if (avatarInput.value && avatarInput.value.startsWith('data:image')) {
        return;
    }

    const email = username.value;
    if (email && email.includes('@')) {
        const svg = await generateAvatar(email);
        if (svg) {
            // Show SVG
            avatarPreview.innerHTML = svg;
            // Save SVG to hidden field
            avatarInput.value = svg;
        }
    } else {
        // Clear avatar
        avatarPreview.innerHTML = '';
        avatarInput.value = '';
    }
}

// Handle avatar upload
export function handleAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Check file type
    if (!file.type.startsWith('image/')) {
        alert(window.i18n?.t('login.uploadImage') || 'Please upload an image file');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            canvas.width = 48;
            canvas.height = 48;
            const ctx = canvas.getContext('2d');
            
            // Draw image to canvas (force scale to 48x48)
            ctx.drawImage(img, 0, 0, 48, 48);

            const dataUrl = canvas.toDataURL('image/png');
            
            // Update preview
            const avatarPreview = document.getElementById('avatar-preview');
            avatarPreview.innerHTML = `<img src="${dataUrl}" style="width: 100%; height: 100%; object-fit: cover;">`;
            
            // Update hidden field
            const avatarInput = document.getElementById('avatar');
            avatarInput.value = dataUrl;
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// Toggle config form show/hide
export function toggleConfigForm(isModify = false) {
    const configForm = document.getElementById('configForm');
    const addConfigBtn = document.getElementById('addConfigBtn');
    const editConfigBtn = document.getElementById('editConfigBtn');
    const configSelect = document.getElementById('configSelect');
    const loginBtn = document.getElementById('loginBtn');

    if (configForm.style.display === 'none' || configForm.style.display === '') {
        configForm.style.display = 'block';

        // Set button state
        if (isModify) {
            if (editConfigBtn) { editConfigBtn.textContent = '✖️ ' + (window.i18n?.t('login.cancelEdit') || 'Cancel Edit'); }
            if (addConfigBtn) addConfigBtn.disabled = true;
        } else {
            if (addConfigBtn) { addConfigBtn.textContent = '✖️ ' + (window.i18n?.t('login.cancelAdd') || 'Cancel Add'); }
            if (editConfigBtn) editConfigBtn.disabled = true;
        }

        // Disable account selection and login button
        configSelect.disabled = true;
        loginBtn.disabled = true;

        // Hide all fields that should be hidden by default
        const hiddenElements = document.querySelectorAll('.hidden-by-default');
        hiddenElements.forEach(element => {
            element.style.display = 'none';
        });
    } else {
        resetConfigForm();
    }
}

// Fill config form
export function fillConfigForm(config) {
    // Set to edit mode
    window.isModifyMode = true;
    window.currentModifyConfigId = config.id;

    // Fill form fields
    const configName = document.getElementById('configName');
    const imapHost = document.getElementById('imapHost');
    const imapPort = document.getElementById('imapPort');
    const smtpHost = document.getElementById('smtpHost');
    const smtpPort = document.getElementById('smtpPort');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const tls = document.getElementById('tls');
    const emailType = document.getElementById('emailType');
    const avatarPreview = document.getElementById('avatar-preview');
    const avatarInput = document.getElementById('avatar');

    configName.value = config.name;
    imapHost.value = config.host;
    imapPort.value = config.port;
    smtpHost.value = config.smtpHost;
    smtpPort.value = config.smtpPort;
    username.value = config.username;
    password.value = config.password;
    tls.checked = config.tls;

    // Handle avatar
    if (config.avatar) {
        // If avatar already exists, show it
        if (config.avatar.startsWith('data:image')) {
            avatarPreview.innerHTML = `<img src="${config.avatar}" style="width: 100%; height: 100%; object-fit: cover;">`;
        } else {
            avatarPreview.innerHTML = config.avatar;
        }
        avatarInput.value = config.avatar;
    } else {
        // Otherwise, generate a new avatar based on email
        updateAvatar();
    }

    // Try to infer email type from host
    let inferredEmailType = '';
    for (const [type, emailConfig] of Object.entries(EMAIL_CONFIGS)) {
        if (emailConfig.imapHost === config.host || emailConfig.smtpHost === config.smtpHost) {
            inferredEmailType = type;
            break;
        }
    }
    emailType.value = inferredEmailType;

    // Show all hidden fields
    const hiddenElements = document.querySelectorAll('.hidden-by-default');
    hiddenElements.forEach(element => {
        element.style.display = 'block';
    });
}

// Auto-fill config based on email type
export function autoFillConfig(emailTypeValue) {
    // Show all hidden fields - regardless of whether an email type is selected
    const hiddenElements = document.querySelectorAll('.hidden-by-default');
    hiddenElements.forEach(element => {
        // Force set to block to ensure elements are shown
        element.style.display = 'block';
    });

    // Only auto-fill config when a valid email type is selected
    if (!emailTypeValue || !EMAIL_CONFIGS[emailTypeValue]) {
        return;
    }

    const config = EMAIL_CONFIGS[emailTypeValue];

    // Auto-fill server address and port
    const imapHost = document.getElementById('imapHost');
    const imapPort = document.getElementById('imapPort');
    const smtpHost = document.getElementById('smtpHost');
    const smtpPort = document.getElementById('smtpPort');
    const tls = document.getElementById('tls');
    const configName = document.getElementById('configName');

    imapHost.value = config.imapHost;
    imapPort.value = config.imapPort;
    smtpHost.value = config.smtpHost;
    smtpPort.value = config.smtpPort;

    // Check TLS by default
    tls.checked = true;

    // Auto-generate config name based on email type (if user has not entered one)
    if (!configName.value.trim()) {
        const providerName = window.i18n?.t('emailProviders.' + emailTypeValue) || config.name;
        configName.value = window.i18n?.t('configForm.myProviderAccount', { provider: providerName }) || ('My ' + providerName);
    }
}

// Reset form
export function resetConfigForm() {
    const emailConfigForm = document.getElementById('emailConfigForm');
    const avatarPreview = document.getElementById('avatar-preview');
    const avatarInput = document.getElementById('avatar');
    const configForm = document.getElementById('configForm');
    const addConfigBtn = document.getElementById('addConfigBtn');
    const editConfigBtn = document.getElementById('editConfigBtn');
    const configSelect = document.getElementById('configSelect');
    const loginBtn = document.getElementById('loginBtn');

    if (emailConfigForm) emailConfigForm.reset();

    // Clear file upload input
    const avatarUpload = document.getElementById('avatar-upload');
    if (avatarUpload) avatarUpload.value = '';

    // Hide all fields that should be hidden by default
    const hiddenElements = document.querySelectorAll('.hidden-by-default');
    hiddenElements.forEach(element => {
        if (element) element.style.display = 'none';
    });

    // Clear avatar
    if (avatarPreview) avatarPreview.innerHTML = '';
    if (avatarInput) avatarInput.value = '';

    if (configForm) configForm.style.display = 'none';

    // Restore button state
    if (addConfigBtn) {
        addConfigBtn.textContent = window.i18n?.t('login.addAccount') || '➕ Add Account';
        addConfigBtn.disabled = false;
    }
    if (editConfigBtn) {
        editConfigBtn.textContent = window.i18n?.t('login.editAccount') || '✏️ Edit Account';
        editConfigBtn.disabled = !window.selectedConfig;
    }

    // Re-enable account selection and login button
    if (configSelect) configSelect.disabled = false;
    // Only enable login and edit buttons when a config is selected
    if (window.selectedConfig) {
        if (loginBtn) loginBtn.disabled = false;
        if (editConfigBtn) editConfigBtn.disabled = false;
    }

    // Reset edit mode flag
    window.isModifyMode = false;
    window.currentModifyConfigId = null;
}

// Save email config
export async function saveEmailConfig(e) {
    e.preventDefault();

    try {
        // Show loading state
        const statusMessage = window.isModifyMode
            ? (window.i18n?.t('login.updatingAccount') || 'Updating account...')
            : (window.i18n?.t('login.savingAccount') || 'Saving account...');
        window.showStatus(`<div class="loading"><div class="spinner"></div><p>${statusMessage}</p></div>`, 'info');

        // Collect form data
        const configData = {
            name: document.getElementById('configName').value,
            host: document.getElementById('imapHost').value,
            port: parseInt(document.getElementById('imapPort').value),
            smtpHost: document.getElementById('smtpHost').value,
            smtpPort: parseInt(document.getElementById('smtpPort').value),
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
            tls: document.getElementById('tls').checked,
            avatar: document.getElementById('avatar').value
        };

        let result;
        if (window.isModifyMode && window.currentModifyConfigId) {
            // Update existing config
            result = await window.electronAPI.updateEmailConfig(window.currentModifyConfigId, configData);
        } else {
            // Save new config
            result = await window.electronAPI.saveEmailConfig(configData);
        }

        // Show success status
        const successMessage = window.isModifyMode
            ? (window.i18n?.t('login.updateSuccess') || 'Account updated successfully!')
            : (window.i18n?.t('login.saveSuccess') || 'Account saved successfully!');
        window.showStatus(successMessage, 'success');

        // Reset form and hide
        resetConfigForm();

        // Reload config list
        const emailConfigs = await window.electronAPI.loadEmailConfigsFromDB();
        renderConfigs(emailConfigs);

    } catch (error) {
        console.error('Save email config failed:', error);
        const saveFailedMsg = window.i18n?.t('login.saveFailed') || 'Failed to save account';
        window.showStatus(`${saveFailedMsg}: ${error.message}`, 'error');
    }
}
