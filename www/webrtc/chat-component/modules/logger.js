import { getMyEmail } from '../../../utils/common.js';

export class Logger {
  constructor(context) {
    this.context = context;
    this.logLevel = 'debug';
    this.logLevels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    this._pendingLogs = []; // Staged log queue
    this._myEmailSet = false; // Flag whether myEmail is set
    this._rendererId = null; // Renderer process ID cache
    this._rendererIdPromise = null; // Promise for getting rendererId

    // Asynchronously get renderer process ID
    this._initRendererId();
  }

  // Asynchronously get renderer process ID
  async _initRendererId() {
    if (window.electronAPI?.getRendererId) {
      try {
        this._rendererId = await window.electronAPI.getRendererId();
        this._sendDebugLog(`Renderer ID initialized: ${this._rendererId}`);
      } catch (err) {
        this._sendDebugLog(`Failed to get renderer ID: ${err.message}`);
        this._rendererId = 'unknown';
      }
    } else {
      this._rendererId = 'unknown';
    }
  }

  // Get renderer process ID (return unknown if not yet obtained)
  _getRendererId() {
    return this._rendererId || 'unknown';
  }

  // Set myEmail and flush queue
  setMyEmail(email) {
    if (!email || this._myEmailSet) return;

    this._myEmailSet = true;
    this.context.myEmail = email;

    // Flush logs in queue
    while (this._pendingLogs.length > 0) {
      const { message, level, timestamp } = this._pendingLogs.shift();
      this._doWriteWebRTCDetailedLog(message, level, timestamp);
    }
  }

  // Send debug logs to main process
  _sendDebugLog(message) {
    if (window.electronAPI && window.electronAPI.log) {
      try {
        window.electronAPI.log('debug', `[Logger] ${message}`, 'WebP2P');
      } catch (e) {
        // Ignore IPC errors
      }
    }
  }

  _shouldLog(level) {
    return this.logLevels[level] >= this.logLevels[this.logLevel];
  }

  _safeToString(value) {
    if (value === null || value === undefined) return String(value);
    if (value instanceof Error) {
      return value.stack || `${value.name}: ${value.message}`;
    }
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  _formatArgs(args) {
    if (!args || args.length === 0) return '';
    if (args.length === 1) return this._safeToString(args[0]);
    return args.map(v => this._safeToString(v)).join(' ');
  }

  _generateWebRTCDetailedFilename(senderEmail, receiverEmail) {
    const safeSender = (senderEmail || 'unknown').replace(/@/g, '_at_');
    const safeReceiver = (receiverEmail || 'unknown').replace(/@/g, '_at_');
    const rendererId = this._getRendererId();
    return `renderer_${rendererId}_${safeSender}_${safeReceiver}_webrtc_detailed.log`;
  }

  _writeWebRTCDetailedLog(message, level, timestamp) {
    try {
      // Prefer myEmail from context
      let senderEmail = this.context?.myEmail;
      this._sendDebugLog(`_writeWebRTCDetailedLog: context.myEmail=${senderEmail}, _myEmailSet=${this._myEmailSet}`);
      
      // If not available, get from runtime
      if (!senderEmail) {
        senderEmail = getMyEmail();
        this._sendDebugLog(`_writeWebRTCDetailedLog: runtime senderEmail=${senderEmail}`);
      }
      
      // If still no myEmail, stage to queue
      if (!senderEmail) {
        this._sendDebugLog(`_writeWebRTCDetailedLog: senderEmail is empty, pending log: ${message.substring(0, 50)}...`);
        if (!this._myEmailSet) {
          this._pendingLogs.push({ message, level, timestamp });
        }
        return;
      }

      // If myEmail is available but _myEmailSet is false, set it and flush queue
      if (!this._myEmailSet) {
        this._sendDebugLog(`_writeWebRTCDetailedLog: calling setMyEmail(${senderEmail})`);
        this.setMyEmail(senderEmail);
      } else {
        // Write log directly
        this._doWriteWebRTCDetailedLog(message, level, timestamp);
      }
    } catch (err) {
      console.error('WebRTC log function error:', err);
    }
  }

  // Actual log writing method
  _doWriteWebRTCDetailedLog(message, level, timestamp) {
    try {
      const senderEmail = this.context?.myEmail;
      if (!senderEmail) {
        this._sendDebugLog('_doWriteWebRTCDetailedLog called but myEmail is still empty');
        return;
      }

      const receiverEmail = this.context?.targetEmail || this.context?.element?.getAttribute('contact-email') || 'unknown';
      const senderEmailShort = senderEmail.split('@')[0];
      const receiverEmailShort = receiverEmail.split('@')[0];

      const logContent = `${timestamp} [${level.toUpperCase()}] [${senderEmailShort}->${receiverEmailShort}] ${message}\n`;
      const filename = this._generateWebRTCDetailedFilename(senderEmail, receiverEmail);
      // Use user-specific log directory (note: must contain users subdirectory)
      const filePath = `resources/users/${senderEmail}/log/${filename}`;

      this._sendDebugLog(`_doWriteWebRTCDetailedLog: writing to ${filePath}`);

      if (window.electronAPI && window.electronAPI.writeFile) {
        window.electronAPI.writeFile(filePath, logContent, true).then(() => {
          this._sendDebugLog(`_doWriteWebRTCDetailedLog: successfully wrote to ${filePath}`);
        }).catch((err) => {
          this._sendDebugLog(`WebRTC log write failed: ${err.message}`);
        });
      } else {
        this._sendDebugLog('_doWriteWebRTCDetailedLog: window.electronAPI.writeFile not available');
      }
    } catch (err) {
      this._sendDebugLog(`WebRTC log function error: ${err.message}`);
    }
  }

  _log(...args) {
    const level = typeof args[args.length - 1] === 'string' && this.logLevels[args[args.length - 1]] !== undefined
      ? args.pop()
      : 'info';

    if (!this._shouldLog(level)) return;

    const timestamp = new Date().toISOString();
    const message = this._formatArgs(args);
    const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] [WebP2P] ${message}`;

    // Console output
    switch (level) {
      case 'debug':
        console.debug(formattedMessage);
        break;
      case 'info':
        console.info(formattedMessage);
        break;
      case 'warn':
        console.warn(formattedMessage);
        break;
      case 'error':
        console.error(formattedMessage);
        break;
      default:
        console.log(formattedMessage);
    }

    // Emit event so UI can display it if needed
    if (this.context && this.context.eventBus) {
      this.context.eventBus.emit('log', { level, message: formattedMessage });
    }

    this._writeWebRTCDetailedLog(message, level, timestamp);

    // Send to main process via IPC if available (global API)
    if (window.electronAPI && window.electronAPI.log) {
      try {
        window.electronAPI.log(level, message, 'WebP2P');
      } catch (e) {
        // Ignore IPC errors
      }
    }
  }

  setLogLevel(level) {
    if (this.logLevels[level] !== undefined) {
      this.logLevel = level;
      this.info(`Log level set to: ${level}`);
    } else {
      this.error(`Invalid log level: ${level}`);
    }
  }

  debug(...args) { this._log(...args, 'debug'); }
  info(...args) { this._log(...args, 'info'); }
  warn(...args) { this._log(...args, 'warn'); }
  error(...args) { this._log(...args, 'error'); }
  
  // For compatibility with code calling log() directly
  log(...args) { this._log(...args, 'info'); }
}
