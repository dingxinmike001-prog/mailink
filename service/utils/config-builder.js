/**
 * Config builder utility module
 * provides build and conversion functions for mail service config objects
 */

/**
 * Build SMTP config object
 * @param {Object} config - original config object
 * @param {Object} options - build options
 * @param {boolean} options.includeCredentials - whether to include credential info, default true
 * @returns {Object} SMTP config object
 */
function buildSmtpConfig(config, options = {}) {
    if (!config) {
        throw new Error('Config is required');
    }

    const { includeCredentials = true } = options;

    const smtpConfig = {
        host: config.smtpHost || config.host,
        port: config.smtpPort || (config.smtpSsl ? 465 : 587),
        secure: config.smtpSsl || config.secure || false,
        tls: {
            rejectUnauthorized: false
        }
    };

    if (includeCredentials) {
        smtpConfig.auth = {
            user: config.username || config.user,
            pass: config.password || config.pass
        };
    }

    // Add optional configuration
    if (config.connectionTimeout) {
        smtpConfig.connectionTimeout = config.connectionTimeout;
    }

    if (config.greetingTimeout) {
        smtpConfig.greetingTimeout = config.greetingTimeout;
    }

    if (config.socketTimeout) {
        smtpConfig.socketTimeout = config.socketTimeout;
    }

    return smtpConfig;
}

/**
 * Build IMAP config object
 * @param {Object} config - original config object
 * @param {Object} options - build options
 * @param {boolean} options.includeCredentials - whether to include credential info, default true
 * @param {boolean} options.enableKeepalive - whether to enable keepalive, default true
 * @returns {Object} IMAP config object
 */
function buildImapConfig(config, options = {}) {
    if (!config) {
        throw new Error('Config is required');
    }

    const {
        includeCredentials = true,
        enableKeepalive = true
    } = options;

    const imapConfig = {
        host: config.host,
        port: config.port || (config.tls ? 993 : 143),
        tls: config.tls || config.ssl || false,
        tlsOptions: {
            rejectUnauthorized: false
        },
        keepalive: enableKeepalive
    };

    if (includeCredentials) {
        imapConfig.user = config.username || config.user;
        imapConfig.password = config.password || config.pass;
    }

    // Add optional configuration
    if (config.connTimeout) {
        imapConfig.connTimeout = config.connTimeout;
    }

    if (config.authTimeout) {
        imapConfig.authTimeout = config.authTimeout;
    }

    return imapConfig;
}

/**
 * Build full mail service config
 * @param {Object} config - original config object
 * @returns {Object} full config object
 */
function buildEmailServiceConfig(config) {
    if (!config) {
        throw new Error('Config is required');
    }

    return {
        username: config.username || config.user,
        password: config.password || config.pass,
        smtp: buildSmtpConfig(config),
        imap: buildImapConfig(config),
        // Keep a reference to the original config
        original: config
    };
}

/**
 * Build config object from database record
 * @param {Object} dbRecord - database record
 * @returns {Object} config object
 */
function buildConfigFromDbRecord(dbRecord) {
    if (!dbRecord) {
        throw new Error('Database record is required');
    }

    return {
        username: dbRecord.username || dbRecord.user,
        password: dbRecord.password || dbRecord.pass,
        name: dbRecord.name,
        avatar: dbRecord.avatar,

        // SMTP config
        smtpHost: dbRecord.smtpHost || dbRecord.smtp_host,
        smtpPort: dbRecord.smtpPort || dbRecord.smtp_port,
        smtpSsl: dbRecord.smtpSsl || dbRecord.smtp_ssl || false,

        // IMAP config
        host: dbRecord.host || dbRecord.imap_host,
        port: dbRecord.port || dbRecord.imap_port,
        tls: dbRecord.tls || dbRecord.imap_tls || false,

        // Other config
        signature: dbRecord.signature,
        autoReply: dbRecord.autoReply || dbRecord.auto_reply,
        forwardTo: dbRecord.forwardTo || dbRecord.forward_to
    };
}

/**
 * Merge config objects
 * @param {Object} baseConfig - base config
 * @param {Object} overrideConfig - override config
 * @returns {Object} merged config
 */
function mergeConfigs(baseConfig, overrideConfig) {
    if (!baseConfig) return overrideConfig;
    if (!overrideConfig) return baseConfig;

    return {
        ...baseConfig,
        ...overrideConfig,
        // Deep merge nested objects
        smtp: { ...baseConfig.smtp, ...overrideConfig.smtp },
        imap: { ...baseConfig.imap, ...overrideConfig.imap }
    };
}

/**
 * Validate SMTP config
 * @param {Object} config - SMTP config
 * @returns {{valid: boolean, errors: string[]}} validation result
 */
function validateSmtpConfig(config) {
    const errors = [];

    if (!config) {
        errors.push('Config is required');
        return { valid: false, errors };
    }

    if (!config.host) {
        errors.push('SMTP host is required');
    }

    if (!config.port) {
        errors.push('SMTP port is required');
    }

    if (config.auth) {
        if (!config.auth.user) {
            errors.push('SMTP auth user is required');
        }
        if (!config.auth.pass) {
            errors.push('SMTP auth password is required');
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validate IMAP config
 * @param {Object} config - IMAP config
 * @returns {{valid: boolean, errors: string[]}} validation result
 */
function validateImapConfig(config) {
    const errors = [];

    if (!config) {
        errors.push('Config is required');
        return { valid: false, errors };
    }

    if (!config.host) {
        errors.push('IMAP host is required');
    }

    if (!config.port) {
        errors.push('IMAP port is required');
    }

    if (!config.user) {
        errors.push('IMAP user is required');
    }

    if (!config.password) {
        errors.push('IMAP password is required');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Validate full mail config
 * @param {Object} config - full config
 * @returns {{valid: boolean, errors: Object}} validation result
 */
function validateEmailConfig(config) {
    const result = {
        valid: true,
        errors: {}
    };

    if (!config) {
        result.valid = false;
        result.errors.general = ['Config is required'];
        return result;
    }

    // Validate SMTP
    if (config.smtp) {
        const smtpValidation = validateSmtpConfig(config.smtp);
        if (!smtpValidation.valid) {
            result.valid = false;
            result.errors.smtp = smtpValidation.errors;
        }
    }

    // Validate IMAP
    if (config.imap) {
        const imapValidation = validateImapConfig(config.imap);
        if (!imapValidation.valid) {
            result.valid = false;
            result.errors.imap = imapValidation.errors;
        }
    }

    // Validate username
    if (!config.username) {
        result.valid = false;
        result.errors.general = result.errors.general || [];
        result.errors.general.push('Username is required');
    }

    return result;
}

/**
 * Create config snapshot(remove sensitive information)
 * @param {Object} config - rawconfig
 * @returns {Object} safe config snapshot
 */
function createConfigSnapshot(config) {
    if (!config) return null;

    const snapshot = { ...config };

    // Remove sensitive information
    if (snapshot.password) {
        snapshot.password = '***';
    }

    if (snapshot.smtp?.auth?.pass) {
        snapshot.smtp = {
            ...snapshot.smtp,
            auth: {
                ...snapshot.smtp.auth,
                pass: '***'
            }
        };
    }

    if (snapshot.imap?.password) {
        snapshot.imap = {
            ...snapshot.imap,
            password: '***'
        };
    }

    return snapshot;
}

/**
 * Config builder class
 * provides chained config builder interface
 */
class ConfigBuilder {
    constructor() {
        this.config = {
            smtp: {},
            imap: {}
        };
    }

    /**
     * Set username
     * @param {string} username - username
     * @returns {ConfigBuilder} this
     */
    setUsername(username) {
        this.config.username = username;
        return this;
    }

    /**
     * Set password
     * @param {string} password - password
     * @returns {ConfigBuilder} this
     */
    setPassword(password) {
        this.config.password = password;
        return this;
    }

    /**
     * Set SMTP host
     * @param {string} host - host address
     * @returns {ConfigBuilder} this
     */
    setSmtpHost(host) {
        this.config.smtpHost = host;
        this.config.smtp = this.config.smtp || {};
        this.config.smtp.host = host;
        return this;
    }

    /**
     * Set SMTP port
     * @param {number} port - port number
     * @returns {ConfigBuilder} this
     */
    setSmtpPort(port) {
        this.config.smtpPort = port;
        this.config.smtp = this.config.smtp || {};
        this.config.smtp.port = port;
        return this;
    }

    /**
     * Set SMTP SSL
     * @param {boolean} ssl - whether to enable SSL
     * @returns {ConfigBuilder} this
     */
    setSmtpSsl(ssl) {
        this.config.smtpSsl = ssl;
        this.config.smtp = this.config.smtp || {};
        this.config.smtp.secure = ssl;
        return this;
    }

    /**
     * Set IMAP host
     * @param {string} host - host address
     * @returns {ConfigBuilder} this
     */
    setImapHost(host) {
        this.config.host = host;
        this.config.imap = this.config.imap || {};
        this.config.imap.host = host;
        return this;
    }

    /**
     * Set IMAP port
     * @param {number} port - port number
     * @returns {ConfigBuilder} this
     */
    setImapPort(port) {
        this.config.port = port;
        this.config.imap = this.config.imap || {};
        this.config.imap.port = port;
        return this;
    }

    /**
     * Set IMAP TLS
     * @param {boolean} tls - whether to enable TLS
     * @returns {ConfigBuilder} this
     */
    setImapTls(tls) {
        this.config.tls = tls;
        this.config.imap = this.config.imap || {};
        this.config.imap.tls = tls;
        return this;
    }

    /**
     * Load from existing config
     * @param {Object} config - existing config
     * @returns {ConfigBuilder} this
     */
    fromConfig(config) {
        this.config = { ...this.config, ...config };
        return this;
    }

    /**
     * Build config object
     * @returns {Object} full config
     */
    build() {
        return buildEmailServiceConfig(this.config);
    }

    /**
     * Build and validate config
     * @returns {{config: Object, valid: boolean, errors: Object}} build result
     */
    buildAndValidate() {
        const config = this.build();
        const validation = validateEmailConfig(config);
        return {
            config,
            valid: validation.valid,
            errors: validation.errors
        };
    }
}

module.exports = {
    buildSmtpConfig,
    buildImapConfig,
    buildEmailServiceConfig,
    buildConfigFromDbRecord,
    mergeConfigs,
    validateSmtpConfig,
    validateImapConfig,
    validateEmailConfig,
    createConfigSnapshot,
    ConfigBuilder
};