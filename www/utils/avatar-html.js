/**
 * SVG Sanitize Worker manager
 * Manages Worker instances and task queues
 * 
 * Note: SVG sanitization is a security feature; do not fall back to the main thread when the Worker fails.
 * Use the synchronous version directly to avoid complex SVGs blocking the UI.
 */
class SvgSanitizeWorkerManager {
  constructor() {
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
          throw new Error('browser not supported Web Worker');
        }

        const workerPath = new URL('../workers/svg-sanitize.worker.js', import.meta.url).href;
        this.worker = new Worker(workerPath, { type: 'module' });

        this.worker.onmessage = (event) => {
          const { type, id, data, success, error, level, message } = event.data;

          if (type === 'ready') {
            this.isReady = true;
            resolve();
            return;
          }

          if (type === 'log') {
            console[level]?.(`[SvgSanitizeWorker] ${message}`);
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
          console.error('[SvgSanitizeWorker] Worker error:', error);
          this.initError = error;
          if (!this.isReady) {
            reject(error);
          }
        };
      } catch (error) {
        console.warn('[SvgSanitizeWorker] create Worker failed，will use synchronous version:', error.message);
        this.initError = error;
        reject(error);
      }
    });

    return this.readyPromise;
  }

  async sanitize(svgStr) {
    // Try to initialize Worker
    if (!this.isReady && !this.initError) {
      try {
        await this.init();
      } catch (e) {
        // Worker initialization failed, return null for caller to use synchronous version
        return null;
      }
    }

    // If Worker is unavailable, return null for caller to use synchronous version
    if (!this.isReady || this.initError) {
      return null;
    }

    const taskId = ++this.taskIdCounter;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        console.warn('[SvgSanitizeWorker] processing timeout，will use synchronous version');
        // Return null after timeout for caller to use synchronous version
        resolve(null);
      }, 3000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          console.warn('[SvgSanitizeWorker] processing failed，will use synchronous version:', error);
          // Return null after failure for caller to use synchronous version
          resolve(null);
        }
      });

      this.worker.postMessage({
        type: 'sanitize',
        id: taskId,
        payload: { svgStr }
      });
    });
  }

  async ensureViewBox(svgStr) {
    // Try to initialize Worker
    if (!this.isReady && !this.initError) {
      try {
        await this.init();
      } catch (e) {
        // Worker initialization failed, return null for caller to use synchronous version
        return null;
      }
    }

    // If Worker is unavailable, return null for caller to use synchronous version
    if (!this.isReady || this.initError) {
      return null;
    }

    const taskId = ++this.taskIdCounter;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        console.warn('[SvgSanitizeWorker] processing timeout，will use synchronous version');
        // Return null after timeout for caller to use synchronous version
        resolve(null);
      }, 3000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          console.warn('[SvgSanitizeWorker] processing failed，will use synchronous version:', error);
          // Return null after failure for caller to use synchronous version
          resolve(null);
        }
      });

      this.worker.postMessage({
        type: 'ensureViewBox',
        id: taskId,
        payload: { svgStr }
      });
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

// Global Worker manager instance
const svgWorkerManager = new SvgSanitizeWorkerManager();

export function buildAvatarHtml(avatar, { ensureViewBox: shouldEnsureViewBox = false } = {}) {
  if (!avatar) return '';

  const raw = String(avatar).trim();
  if (!raw) return '';

  const maxChars = 250000;
  if (raw.length > maxChars) return '';

  if (raw.startsWith('data:image')) {
    if (raw.length > maxChars) return '';
    return `<img src="${raw}" style="width: 100%; height: 100%; object-fit: cover;" alt="avatar">`;
  }

  const decoded = raw.includes('&lt;')
    ? raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
    : raw;

  if (decoded.startsWith('<svg')) {
    const safeSvg = sanitizeSvg(decoded);
    if (!safeSvg) return '';
    return shouldEnsureViewBox ? ensureViewBox(safeSvg) : safeSvg;
  }

  if (decoded.startsWith('<')) {
    return '';
  }

  const maybeBase64 = decoded.length >= 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(decoded);
  if (maybeBase64) {
    if (decoded.length > 350000) return '';
    return `<img src="data:image/png;base64,${decoded.replace(/\s+/g, '')}" style="width: 100%; height: 100%; object-fit: cover;" alt="avatar">`;
  }

  return '';
}

export function sanitizeSvg(svgStr) {
  // Synchronous version (for scenarios requiring immediate return)
  try {
    const input = String(svgStr || '').trim();
    if (!input.startsWith('<svg')) return '';

    const parser = new DOMParser();
    const doc = parser.parseFromString(input, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (!svgEl || String(svgEl.nodeName || '').toLowerCase() !== 'svg') return '';

    const blocked = new Set(['script', 'foreignobject', 'webcom', 'object', 'embed', 'link', 'meta', 'style']);
    const stack = [svgEl];

    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;

      const tag = String(el.nodeName || '').toLowerCase();
      if (blocked.has(tag)) {
        el.remove();
        continue;
      }

      for (const attr of Array.from(el.attributes || [])) {
        const name = String(attr.name || '').toLowerCase();
        const value = String(attr.value || '');
        const lowerValue = value.toLowerCase();

        if (name.startsWith('on') || name === 'style') {
          el.removeAttribute(attr.name);
          continue;
        }

        if (name === 'href' || name === 'xlink:href' || name === 'src') {
          if (lowerValue.includes('javascript:')) {
            el.removeAttribute(attr.name);
            continue;
          }
          if (!(lowerValue.startsWith('#') || lowerValue.startsWith('data:image'))) {
            el.removeAttribute(attr.name);
            continue;
          }
        }

        if (lowerValue.includes('javascript:')) {
          el.removeAttribute(attr.name);
        }
      }

      for (const child of Array.from(el.children || [])) {
        stack.push(child);
      }
    }

    return new XMLSerializer().serializeToString(svgEl);
  } catch (e) {
    return '';
  }
}

export function ensureViewBox(svgStr) {
  if (!svgStr || typeof svgStr !== 'string' || !svgStr.startsWith('<svg')) {
    return svgStr;
  }

  if (svgStr.includes('viewBox')) {
    return svgStr;
  }

  const widthMatch = svgStr.match(/width=["'](\d+)['"]/i);
  const heightMatch = svgStr.match(/height=["'](\d+)['"]/i);
  if (!widthMatch || !heightMatch) {
    return svgStr;
  }

  const width = widthMatch[1];
  const height = heightMatch[1];
  return svgStr.replace('<svg', `<svg viewBox="0 0 ${width} ${height}"`);
}

/**
 * Sanitize SVG asynchronously (using Worker)
 * @param {string} svgStr - SVG string
 * @returns {Promise<string>} - sanitized SVG string
 */
export async function sanitizeSvgAsync(svgStr) {
  return svgWorkerManager.sanitize(svgStr);
}

/**
 * Ensure SVG has a viewBox asynchronously (using Worker)
 * @param {string} svgStr - SVG string
 * @returns {Promise<string>} - processed SVG string
 */
export async function ensureViewBoxAsync(svgStr) {
  return svgWorkerManager.ensureViewBox(svgStr);
}

/**
 * Destroy the Worker and release resources
 */
export function terminateSvgWorker() {
  svgWorkerManager.terminate();
}
