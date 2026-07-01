import { buildAvatarHtml as buildAvatarHtmlShared, ensureViewBox } from '../../../utils/avatar-html.js';
import { avatarCache } from '../../../utils/avatar-cache.js';
import { getColorFromHash as getColor } from '../../../../shared/utils/math.js';

/**
 * Avatar compression Worker manager
 * Manages Worker instances and task queues
 */
class AvatarCompressWorkerManager {
  constructor(logger) {
    this.logger = logger;
    this.worker = null;
    this.pendingTasks = new Map();
    this.taskIdCounter = 0;
    this.isReady = false;
    this.readyPromise = null;
    this.initError = null;
  }

  async init() {
    if (this.worker) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      try {
        // Check browser support
        if (typeof Worker === 'undefined') {
          throw new Error('Browser does not support Web Worker');
        }
        if (typeof OffscreenCanvas === 'undefined') {
          throw new Error('Browser does not support OffscreenCanvas');
        }

        const workerPath = new URL('../../../../workers/avatar-compress.worker.js', import.meta.url).href;
        this.worker = new Worker(workerPath, { type: 'module' });

        this.worker.onmessage = (event) => {
          const { type, id, data, success, error, level, message } = event.data;

          if (type === 'ready') {
            this.isReady = true;
            resolve();
            return;
          }

          if (type === 'log') {
            this.logger[level]?.(`[AvatarCompressWorker] ${message}`);
            return;
          }

          const pendingTask = this.pendingTasks.get(id);
          if (pendingTask) {
            this.pendingTasks.delete(id);
            if (success) {
              pendingTask.resolve(data);
            } else {
              pendingTask.reject(new Error(error || 'Worker processing failed'));
            }
          }
        };

        this.worker.onerror = (error) => {
          this.logger.error?.('[AvatarCompressWorker] Worker error:', error);
          this.initError = error;
          if (!this.isReady) {
            reject(error);
          }
        };
      } catch (error) {
        this.logger.warn?.('[AvatarCompressWorker] failed to create Worker:', error.message);
        this.initError = error;
        reject(error);
      }
    });

    return this.readyPromise;
  }

  async compress(imageData) {
    // Try to initialize Worker
    if (!this.isReady && !this.initError) {
      try {
        await this.init();
      } catch (e) {
        // Initialization failed, use fallback
        this.logger.warn?.('[AvatarCompressWorker] Worker initialization failed, will use main-thread processing');
      }
    }

    // Use main-thread fallback if Worker is unavailable
    if (!this.isReady || this.initError) {
      return this._compressInMainThread(imageData);
    }

    const taskId = ++this.taskIdCounter;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        this.logger.warn?.('[AvatarCompressWorker] Worker timeout, use main-thread fallback');
        // Use main-thread processing after timeout
        this._compressInMainThread(imageData).then(resolve).catch(reject);
      }, 10000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          this.logger.warn?.('[AvatarCompressWorker] Worker processing failed, use main-thread fallback:', error);
          // Use main-thread processing after failure
          this._compressInMainThread(imageData).then(resolve).catch(reject);
        }
      });

      this.worker.postMessage({
        type: 'compress',
        id: taskId,
        payload: { imageData }
      });
    });
  }

  /**
   * Compress avatar in main thread (fallback)
   * @param {string} imageData - Image data
   * @returns {Promise<{color: string, gray: string}>}
   */
  async _compressInMainThread(imageData) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          // Create 48x48 canvas
          const canvas = document.createElement('canvas');
          canvas.width = 48;
          canvas.height = 48;
          const ctx = canvas.getContext('2d');

          // Crop and scale image using cover mode
          const scale = Math.max(48 / img.width, 48 / img.height);
          const scaledWidth = img.width * scale;
          const scaledHeight = img.height * scale;
          const offsetX = (48 - scaledWidth) / 2;
          const offsetY = (48 - scaledHeight) / 2;

          ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

          // Get image data for grayscale generation
          const imageData = ctx.getImageData(0, 0, 48, 48);
          const data = imageData.data;

          // Create grayscale canvas
          const grayCanvas = document.createElement('canvas');
          grayCanvas.width = 48;
          grayCanvas.height = 48;
          const grayCtx = grayCanvas.getContext('2d');
          const grayImageData = grayCtx.createImageData(48, 48);
          const grayData = grayImageData.data;

          // Convert to 8-bit grayscale
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            // Use standard grayscale conversion formula: Gray = 0.299*R + 0.587*G + 0.114*B
            const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            grayData[i] = gray;     // R
            grayData[i + 1] = gray; // G
            grayData[i + 2] = gray; // B
            grayData[i + 3] = 255;  // A (opaque)
          }

          grayCtx.putImageData(grayImageData, 0, 0);

          // Output color image as JPEG with quality 0.85
          const colorData = canvas.toDataURL('image/jpeg', 0.85);

          // Output grayscale image as JPEG with quality 0.85
          const grayDataUrl = grayCanvas.toDataURL('image/jpeg', 0.85);

          resolve({
            color: colorData,
            gray: grayDataUrl
          });
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error('image load failed'));

      // Process input data
      if (imageData.startsWith('data:image')) {
        img.src = imageData;
      } else {
        // Assume base64 and try adding data URI prefix
        img.src = `data:image/jpeg;base64,${imageData}`;
      }
    });
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isReady = false;
      this.initError = null;
      this.pendingTasks.clear();
    }
  }
}

export class AvatarManager {
  constructor(context) {
    this.context = context;
    this.compressWorkerManager = new AvatarCompressWorkerManager(context.logger);
    this.setupEventListeners();
  }

  // Getters
  get eventBus() { return this.context.eventBus; }
  get logger() { return this.context.logger; }
  get connection() { return this.context.connection; }
  get electronAPI() { return window.electronAPI; }

  normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  buildAvatarHtml(avatar) {
    return buildAvatarHtmlShared(avatar, { ensureViewBox: true });
  }

  hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
  }

  getColorFromHash(hash, index) {
    return getColor(hash, index);
  }

  setupEventListeners() {
    this.eventBus.on('datachannel:messageReceived', (data) => {
      if (data.type === 'avatar') {
        this.handleAvatarMessage(data);
      } else if (data.type === 'avatar:request') {
        this.handleAvatarRequest(data);
      }
    });

    this.eventBus.on('datachannel:open', () => {
      this.sendAvatar();
      this.requestAvatar();
    });

    this.eventBus.on('connection:statusChanged', (status) => {
      if (status === 'connected') {
        this.sendAvatar();
        this.requestAvatar();
      }
    });
  }

  generateAvatar(email, isSelf = true) {
    if (!email || !email.includes('@')) {
      return '';
    }

    if (!isSelf) {
      return `
        <svg width="24" height="24" xmlns="http://www.w3.org/2000/svg">
            <rect width="24" height="24" fill="#E8E8E8" rx="3" ry="3" />
            <text x="12" y="16" font-size="12" font-weight="bold" fill="#BBBBBB" text-anchor="middle" font-family="Arial, sans-serif">?</text>
        </svg>
      `.trim();
    }

    const hash = this.hashCode(email);
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
      this.getColorFromHash(hash, 0),
      this.getColorFromHash(hash, 1),
      this.getColorFromHash(hash, 2),
      this.getColorFromHash(hash, 3)
    ];

    const svg = `
      <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <rect width="24" height="24" fill="${bgColor}" rx="3" ry="3" />
          <text x="7" y="10" font-size="9" font-weight="bold" fill="${colors[0]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[0]}</text>
          <text x="17" y="10" font-size="9" font-weight="bold" fill="${colors[1]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[1]}</text>
          <text x="7" y="20" font-size="9" font-weight="bold" fill="${colors[2]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[2]}</text>
          <text x="17" y="20" font-size="9" font-weight="bold" fill="${colors[3]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[3]}</text>
      </svg>
    `.trim();

    return svg;
  }

  async getAvatar(email) {
    if (!email) return '';

    let avatar;
    const normalizedEmail = this.normalizeEmail(email);

    if (avatarCache.has(normalizedEmail)) {
      avatar = avatarCache.get(normalizedEmail);
      return avatar;
    }

    const myEmail = this.context.myEmail;
    const normalizedMyEmail = this.normalizeEmail(myEmail);

    if (normalizedEmail && normalizedEmail === normalizedMyEmail) {
      try {
        if (typeof window.getSelectedConfig === 'function') {
          const selectedConfig = window.getSelectedConfig();
          if (selectedConfig && selectedConfig.avatar) {
            avatar = selectedConfig.avatar;
          }
        }
      } catch (e) { }

      if (!avatar) {
        try {
          const storedConfig = localStorage.getItem('userConfig');
          if (storedConfig) {
            const config = JSON.parse(storedConfig);
            if (config.avatar) {
              avatar = config.avatar;
            }
          }
        } catch (e) { }
      }

      if (avatar) {
        const normalized = String(avatar).trim();
        if (normalized.startsWith('<svg')) {
          avatar = ensureViewBox(normalized);
        } else {
          avatar = normalized;
        }
        avatarCache.set(normalizedEmail, avatar);
        return avatar;
      }

      avatar = ensureViewBox(this.generateAvatar(myEmail || email, true));
      avatarCache.set(normalizedEmail, avatar);
      return avatar;
    }

    if (this.electronAPI && this.electronAPI.getContacts) {
      try {
        const contacts = await this.electronAPI.getContacts(myEmail);
        const contact = contacts.find(c => this.normalizeEmail(c.username) === normalizedEmail);
        if (contact && contact.avatar) {
          avatar = ensureViewBox(contact.avatar);
          avatarCache.set(normalizedEmail, avatar);
          return avatar;
        }
      } catch (e) {
        console.error('from datalibraryfailed to load avatar:', e);
      }
    }

    avatar = ensureViewBox(this.generateAvatar(email, false));
    return avatar;
  }

  async sendAvatar() {
    const myEmail = this.context.myEmail;
    if (!myEmail) return;

    let avatar = '';
    try {
      if (typeof window.getSelectedConfig === 'function') {
        const selectedConfig = window.getSelectedConfig();
        if (selectedConfig && selectedConfig.avatar) {
          avatar = selectedConfig.avatar;
        }
      }
    } catch (e) { }

    if (!avatar) {
      try {
        const storedConfig = localStorage.getItem('userConfig');
        if (storedConfig) {
          const config = JSON.parse(storedConfig);
          if (config.avatar) {
            avatar = config.avatar;
          }
        }
      } catch (e) { }
    }

    if (!avatar) {
      avatar = this.generateAvatar(myEmail, true);
      this.logger.info(`🆕 generateDeterministic based on email hashavatar`);
    }

    // Get sender account name (used by receiver to update contact nickname)
    let myNickname = '';
    try {
      const cfg = typeof window.getSelectedConfig === 'function' ? window.getSelectedConfig() : null;
      myNickname = (cfg && cfg.name) || myEmail.split('@')[0] || '';
    } catch (e) { myNickname = myEmail.split('@')[0] || ''; }

    if (avatar && this.connection && this.connection.isDataChannelOpen()) {
      const avatarMessage = {
        type: 'avatar',
        from: myEmail,
        nickname: myNickname,
        avatar: avatar,
        timestamp: Date.now()
      };
      const manager = this.context.dataChannelManager;
      const ok = manager && typeof manager.sendDataReliable === 'function'
        ? await manager.sendDataReliable(avatarMessage, { timeoutMs: 5000 })
        : this.connection.sendData(avatarMessage);
      this.logger.info(`🖼️  sync my avatar to ${this.context.targetEmail}`);
      if (!ok) {
        this.logger.warn(`🖼️  avatar sync failed(will waitaftercontinueretrytrigger)`);
      }
    }
  }

  async requestAvatar() {
    const myEmail = this.context.myEmail;
    if (!myEmail) return;
    if (!this.connection || !this.connection.isDataChannelOpen()) return;

    const manager = this.context.dataChannelManager;
    const payload = {
      type: 'avatar:request',
      from: myEmail,
      timestamp: Date.now()
    };
    if (manager && typeof manager.sendDataReliable === 'function') {
      await manager.sendDataReliable(payload, { timeoutMs: 5000 });
    } else {
      this.connection.sendData(payload);
    }
  }

  handleAvatarRequest(data) {
    const from = data && data.from;
    if (!from) return;
    if (!this.connection || !this.connection.isDataChannelOpen()) return;
    this.sendAvatar();
  }

  async handleAvatarMessage(data) {
    const { from, avatar, nickname } = data;
    if (!from || !avatar || typeof avatar !== 'string') return;
    const rawAvatar = String(avatar).trim();
    if (!rawAvatar) return;
    if (rawAvatar.length > 350000) return;

    const normalizedFrom = this.normalizeEmail(from);
    const isSvg = rawAvatar.startsWith('<svg') || rawAvatar.startsWith('&lt;svg');
    const isDataImage = rawAvatar.startsWith('data:image');
    const isMaybeBase64 = rawAvatar.length >= 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(rawAvatar);
    if (!isSvg && !isDataImage && !isMaybeBase64) return;

    let avatarToStore;
    let avgrayToStore = '';

    if (isSvg) {
      avatarToStore = ensureViewBox(this.buildAvatarHtml(rawAvatar));
    } else if (isDataImage || isMaybeBase64) {
      // Compress image to 48x48 and generate grayscale - using Worker
      try {
        const imageData = isDataImage ? rawAvatar : `data:image/jpeg;base64,${rawAvatar}`;
        const result = await this.compressWorkerManager.compress(imageData);
        avatarToStore = result.color;
        avgrayToStore = result.gray;
        this.logger.info(`🖼️  avatar compression completed (Worker): ${from}`);
      } catch (e) {
        this.logger.warn(`🖼️  avatar compression failed, useoriginaldata: ${e.message}`);
        avatarToStore = rawAvatar;
      }
    } else {
      avatarToStore = rawAvatar;
    }

    if (!avatarToStore) return;

    if (normalizedFrom) {
      avatarCache.set(normalizedFrom, avatarToStore);
    }

    if (this.electronAPI && this.electronAPI.addContact) {
      const myEmail = this.context.myEmail;

      // Restriction: cannot add the currently logged-in IMAP account email address as a contact
      const normalizedMyEmail = String(myEmail || '').trim().toLowerCase();
      const normalizedFrom = String(from || '').trim().toLowerCase();
      if (normalizedFrom === normalizedMyEmail) {
        this.logger.debug(`[handleAvatarMessage] cannot add self as contact: ${from}`);
        return;
      }

      this.electronAPI.addContact(myEmail, {
        username: from,
        nickname: nickname || undefined,
        avatar: avatarToStore,
        avgray: avgrayToStore
      }).then(() => {
        this.logger.info(`🖼️  sync and persistfrom  ${from} realavatar (48x48)${avgrayToStore ? ' + grayscale image' : ''}`);
        this.updateAvatarDisplay(from, avatarToStore);
      }).catch(err => {
        console.error('failed to store avatar:', err);
      });
    }
  }

  updateAvatarDisplay(email, avatar) {
    if (!email || !avatar) return;

    const normalizedEmail = this.normalizeEmail(email);
    const avatarElements = this.context.root.querySelectorAll(`.avatar[data-email], .message-avatar[data-email]`);
    avatarElements.forEach(element => {
      const elementEmail = this.normalizeEmail(element.dataset.email);
      if (elementEmail && elementEmail === normalizedEmail) {
        element.innerHTML = this.buildAvatarHtml(avatar);
      }
    });

    // Notify external components
    // Since we are inside the component, we can dispatch events to the component element
    // so the main app can listen to them if needed.
    const msgData = { type: 'avatarUpdated', email: normalizedEmail || email, avatar };
    
    // Dispatch to component host
    this.context.element.dispatchEvent(new CustomEvent('avatar-updated', { detail: msgData, bubbles: true, composed: true }));
  }

  /**
   * Destroy AvatarManager and release resources
   */
  destroy() {
    this.compressWorkerManager.terminate();
  }
}
