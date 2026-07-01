const UserLogger = require('../user-logger');

class ImapLogger extends UserLogger {
    static instances = new Map();

    constructor(options = {}) {
        const username = options.username;
        super('imap', options);
        this.username = username;
        this.loggerInstance.info(`IMAPlogger initialized - ${username}`);
    }

    static getInstance(username) {
        const key = `${username}`;
        if (!ImapLogger.instances.has(key)) {
            ImapLogger.instances.set(key, new ImapLogger({ username }));
        }
        return ImapLogger.instances.get(key);
    }

    logIdleDetection(capabilityInfo) {
        const timestamp = new Date().toISOString();
        const separator = '='.repeat(80);

        const logContent = `
${separator}
[${timestamp}] IDLEcapability detection - ${this.username}
${separator}

## server capability list

### serverCapabilities (public properties):
  type: ${Array.isArray(capabilityInfo.serverCapabilities) ? 'Array' : typeof capabilityInfo.serverCapabilities}
  content: ${JSON.stringify(capabilityInfo.serverCapabilities, null, 2)}

### _capabilities (internal properties):
  type: ${Array.isArray(capabilityInfo._capabilities) ? 'Array' : typeof capabilityInfo._capabilities}
  content: ${JSON.stringify(capabilityInfo._capabilities, null, 2)}

### capabilities (standard properties):
  type: ${Array.isArray(capabilityInfo.capabilities) ? 'Array' : typeof capabilityInfo.capabilities}
  content: ${JSON.stringify(capabilityInfo.capabilities, null, 2)}

### _capability (internal object, singular):
  type: ${typeof capabilityInfo._capability}
  content: ${JSON.stringify(capabilityInfo._capability, null, 2)}

## detection result

detection method1 (serverCapabilities array): ${capabilityInfo.detectionMethod1 ? '✓ detectedIDLE' : '✗ not detectedIDLE'}
detection method2 (_capabilities array): ${capabilityInfo.detectionMethod2 ? '✓ detectedIDLE' : '✗ not detectedIDLE'}
detection method3 (capabilities array): ${capabilityInfo.detectionMethod3 ? '✓ detectedIDLE' : '✗ not detectedIDLE'}
detection method4 (_capability object): ${capabilityInfo.detectionMethod4 ? '✓ detectedIDLE' : '✗ not detectedIDLE'}
detection method5 (actual call test): ${capabilityInfo.actualTest ? '✓ call succeeded' : '✗ not called or failed'}

${capabilityInfo.testResult ? `actual test: ${capabilityInfo.testResult}\n` : ''}
final result: ${capabilityInfo.hasIdle ? '✓ supportIDLE' : '✗ not supportedIDLE'}
adopted mode: ${capabilityInfo.mode}

${capabilityInfo.error ? `error message: ${capabilityInfo.error}\n` : ''}${separator}
`;

        this.loggerInstance.debug(logContent);
        this.loggerInstance.info(`IDLEdetection completed: ${this.username} - result: ${capabilityInfo.hasIdle ? 'support' : 'not supported'}`);
    }

    logConnection(event, details = {}) {
        const logContent = `${this.username} - ${event} - ${JSON.stringify(details)}`;
        this.loggerInstance.info(logContent);
    }

    logIdleStart(success, error = null) {
        const logContent = `IDLEstart - ${this.username}: ${success ? 'succeeded' : 'failed'}${error ? ` - error: ${error}` : ''}`;
        this.loggerInstance.info(logContent);
    }

    logIdleRenew(success) {
        const logContent = `IDLErenewed - ${this.username}: ${success ? 'succeeded' : 'failed'}`;
        this.loggerInstance.debug(logContent);
    }

    logNewMail(count) {
        const logContent = `new mail notification - ${this.username}: ${count}new emails`;
        this.loggerInstance.info(logContent);
    }

    debug(message, data = {}) {
        this.loggerInstance.debug(`[${this.username}] ${message}`, data);
    }

    info(message, data = {}) {
        this.loggerInstance.info(`[${this.username}] ${message}`, data);
    }

    warn(message, data = {}) {
        this.loggerInstance.warn(`[${this.username}] ${message}`, data);
    }

    error(message, data = {}) {
        this.loggerInstance.error(`[${this.username}] ${message}`, data);
    }
}

module.exports = ImapLogger;
