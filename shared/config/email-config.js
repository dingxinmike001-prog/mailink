const { ConfigBase } = require('../core/config/config-base');

const EMAIL_SERVICE_CONFIGS = {
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
        name: 'China Telecom 189 Mail',
        imapHost: 'imap.189.cn',
        imapPort: 993,
        smtpHost: 'smtp.189.cn',
        smtpPort: 465
    },
    '139': {
        name: 'China Mobile 139 Mail',
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
        name: 'Gmail',
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
        name: 'Outlook',
        imapHost: 'imap-mail.outlook.com',
        imapPort: 993,
        smtpHost: 'smtp-mail.outlook.com',
        smtpPort: 587
    }
};

function generateDbName(username) {
    if (!username) {
        throw new Error('Username is required');
    }
    return `${username.replace('@', '_at_')}_emails.db`;
}

function generateConnectionConfig(config) {
    if (!config) {
        throw new Error('Config is required');
    }

    const { host, port, smtpHost, smtpPort, username, password, tls = true } = config;
    
    if (!host || !port || !smtpHost || !smtpPort || !username || !password) {
        throw new Error('Incomplete connection configuration');
    }

    return {
        imap: {
            host,
            port,
            tls,
            username,
            password,
            authTimeout: 10000,
            tlsOptions: {
                rejectUnauthorized: false
            }
        },
        smtp: {
            host: smtpHost,
            port: smtpPort,
            secure: smtpPort === 465,
            auth: {
                user: username,
                pass: password
            },
            tls: {
                rejectUnauthorized: false
            }
        }
    };
}

function validateEmailConfig(config) {
    const errors = [];

    if (!config) {
        errors.push('Configuration cannot be empty');
        return { valid: false, errors };
    }

    const requiredFields = ['name', 'host', 'port', 'smtpHost', 'smtpPort', 'username', 'password'];
    for (const field of requiredFields) {
        if (!config[field]) {
            errors.push(`${field} is required`);
        }
    }

    if (config.username && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.username)) {
        errors.push('Invalid email format');
    }

    if (config.port && (isNaN(config.port) || config.port < 1 || config.port > 65535)) {
        errors.push('Invalid IMAP port number');
    }

    if (config.smtpPort && (isNaN(config.smtpPort) || config.smtpPort < 1 || config.smtpPort > 65535)) {
        errors.push('Invalid SMTP port number');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

function inferEmailType(email) {
    if (!email || !email.includes('@')) {
        return null;
    }

    const domain = email.split('@')[1].split('.')[0].toLowerCase();
    
    const domainMap = {
        '163': '163',
        'qq': 'qq',
        '126': '126',
        'sina': 'sina',
        '189': '189',
        '139': '139',
        'gmail': 'gmail',
        'yahoo': 'yahoo',
        'outlook': 'outlook',
        'hotmail': 'outlook',
        'live': 'outlook',
        'msn': 'outlook',
        'protonmail': 'protonmail',
        'proton': 'protonmail'
    };

    return domainMap[domain] || null;
}

function getEmailServiceConfig(emailType) {
    return EMAIL_SERVICE_CONFIGS[emailType] || null;
}

function autoFillConfig(email) {
    const emailType = inferEmailType(email);
    if (!emailType) {
        return {};
    }

    const serviceConfig = getEmailServiceConfig(emailType);
    if (!serviceConfig) {
        return {};
    }

    return {
        host: serviceConfig.imapHost,
        port: serviceConfig.imapPort,
        smtpHost: serviceConfig.smtpHost,
        smtpPort: serviceConfig.smtpPort,
        tls: true
    };
}

class EmailConfigManager extends ConfigBase {
    constructor() {
        super({
            cacheEnabled: true,
            cacheDuration: 30000,
            autoSave: false
        });
    }

    _getRequiredFields() {
        return ['name', 'host', 'port', 'smtpHost', 'smtpPort', 'username', 'password'];
    }

    _validateConfig(config) {
        return validateEmailConfig(config);
    }

    async _loadConfigs() {
        return [];
    }

    async _doSave(config) {
        return config;
    }

    async _doUpdate(configId, updates) {
        return { id: configId, ...updates };
    }

    async _doDelete(configId) {
        return true;
    }
}

const emailConfigManager = new EmailConfigManager();

async function loadConfigs() {
    return emailConfigManager.getConfigs();
}

async function saveConfig(config) {
    return emailConfigManager.saveConfig(config);
}

async function updateConfig(configId, config) {
    return emailConfigManager.updateConfig(configId, config);
}

async function deleteConfig(configId) {
    return emailConfigManager.deleteConfig(configId);
}

async function getConfigs(forceReload = false) {
    return emailConfigManager.getConfigs(forceReload);
}

async function getConfig(configId, forceReload = false) {
    return emailConfigManager.getConfig(configId, forceReload);
}

function clearCache() {
    emailConfigManager._clearCache();
}

function onConfigUpdated(listener) {
    return emailConfigManager.on('configUpdated', listener);
}

function onConfigDeleted(listener) {
    return emailConfigManager.on('configDeleted', listener);
}

async function startAutoUpdate(interval = 60000) {
    const intervalId = setInterval(async () => {
        try {
            await emailConfigManager.reload();
        } catch (error) {
            console.error('Failed to auto-update configs:', error);
        }
    }, interval);

    return () => clearInterval(intervalId);
}

export { 
    EMAIL_SERVICE_CONFIGS,
    generateDbName,
    generateConnectionConfig,
    validateEmailConfig,
    inferEmailType,
    getEmailServiceConfig,
    autoFillConfig,
    loadConfigs,
    saveConfig,
    updateConfig,
    deleteConfig,
    getConfigs,
    getConfig,
    clearCache,
    onConfigUpdated,
    onConfigDeleted,
    startAutoUpdate
};

module.exports = {
    EMAIL_SERVICE_CONFIGS,
    generateDbName,
    generateConnectionConfig,
    validateEmailConfig,
    inferEmailType,
    getEmailServiceConfig,
    autoFillConfig,
    loadConfigs,
    saveConfig,
    updateConfig,
    deleteConfig,
    getConfigs,
    getConfig,
    clearCache,
    onConfigUpdated,
    onConfigDeleted,
    startAutoUpdate,
    EmailConfigManager
};
