/**
 * SVG sanitization Worker
 * Sanitizes and validates SVG in a Worker thread, avoiding blocking the main thread
 */

// Worker internal log
const logger = {
  info: (msg) => self.postMessage({ type: 'log', level: 'info', message: msg }),
  warn: (msg) => self.postMessage({ type: 'log', level: 'warn', message: msg }),
  error: (msg) => self.postMessage({ type: 'log', level: 'error', message: msg })
};

/**
 * Sanitize SVG string, removing dangerous elements and attributes
 * @param {string} svgStr - SVG string
 * @returns {string} - sanitized SVG string
 */
function sanitizeSvg(svgStr) {
  try {
    const input = String(svgStr || '').trim();
    if (!input.startsWith('<svg')) return '';

    // Use DOMParser to parse the SVG
    const parser = new DOMParser();
    const doc = parser.parseFromString(input, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if (!svgEl || String(svgEl.nodeName || '').toLowerCase() !== 'svg') return '';

    // Define dangerous tags and attributes
    const blockedTags = new Set(['script', 'foreignobject', 'webcom', 'object', 'embed', 'link', 'meta', 'style']);
    const dangerousAttrs = new Set(['onload', 'onerror', 'onclick', 'onmouseover', 'onmouseout', 'onfocus', 'onblur']);

    // Recursively sanitize nodes
    function cleanNode(node) {
      if (!node || node.nodeType !== 1) return;

      const tagName = String(node.nodeName || '').toLowerCase();

      // Remove dangerous tags
      if (blockedTags.has(tagName)) {
        node.remove();
        return;
      }

      // Remove dangerous attributes
      const attrs = Array.from(node.attributes || []);
      for (const attr of attrs) {
        const attrName = String(attr.name || '').toLowerCase();
        const attrValue = String(attr.value || '').toLowerCase();

        // Remove event handlers
        if (dangerousAttrs.has(attrName) || attrName.startsWith('on')) {
          node.removeAttribute(attr.name);
          continue;
        }

        // Remove style attributes (may contain expressions)
        if (attrName === 'style') {
          node.removeAttribute(attr.name);
          continue;
        }

        // Check for javascript: in href/xlink:href
        if ((attrName === 'href' || attrName === 'xlink:href' || attrName === 'src')) {
          if (attrValue.includes('javascript:') || attrValue.includes('data:text/html')) {
            node.removeAttribute(attr.name);
            continue;
          }
        }
      }

      // Recursively process child nodes
      const children = Array.from(node.children);
      for (const child of children) {
        cleanNode(child);
      }
    }

    cleanNode(svgEl);

    // Serialize back to string
    const serializer = new XMLSerializer();
    return serializer.serializeToString(svgEl);
  } catch (e) {
    logger.error(`SVG cleanup failed: ${e.message}`);
    return '';
  }
}

/**
 * Ensure SVG has viewBox attribute
 * @param {string} svgStr - SVG string
 * @returns {string} - SVG string with viewBox guaranteed
 */
function ensureViewBox(svgStr) {
  if (!svgStr || typeof svgStr !== 'string' || !svgStr.startsWith('<svg')) {
    return svgStr;
  }

  if (svgStr.includes('viewBox')) {
    return svgStr;
  }

  const widthMatch = svgStr.match(/width=["'](\d+)["']/i);
  const heightMatch = svgStr.match(/height=["'](\d+)["']/i);
  if (!widthMatch || !heightMatch) {
    return svgStr;
  }

  const width = widthMatch[1];
  const height = heightMatch[1];
  return svgStr.replace('<svg', `<svg viewBox="0 0 ${width} ${height}"`);
}

/**
 * Build avatar HTML
 * @param {string} avatar - avatar data (SVG or image URL)
 * @returns {string} - HTML string
 */
function buildAvatarHtml(avatar) {
  if (!avatar) return '';

  const raw = String(avatar).trim();
  if (!raw) return '';

  const maxChars = 250000;
  if (raw.length > maxChars) return '';

  // Handle data:image URL
  if (raw.startsWith('data:image')) {
    if (raw.length > maxChars) return '';
    return `<img src="${raw}" style="width: 100%; height: 100%; object-fit: cover;" alt="avatar">`;
  }

  // Decode HTML entities
  const decoded = raw.includes('&lt;')
    ? raw
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
    : raw;

  // Handle SVG
  if (decoded.startsWith('<svg')) {
    const safeSvg = sanitizeSvg(decoded);
    if (!safeSvg) return '';
    return ensureViewBox(safeSvg);
  }

  // Reject other HTML tags
  if (decoded.startsWith('<')) {
    return '';
  }

  // Handle possible base64
  const maybeBase64 = decoded.length >= 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(decoded);
  if (maybeBase64) {
    if (decoded.length > 350000) return '';
    return `<img src="data:image/png;base64,${decoded.replace(/\s+/g, '')}" style="width: 100%; height: 100%; object-fit: cover;" alt="avatar">`;
  }

  return '';
}

// Process message
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  if (type === 'sanitize') {
    const { svgStr } = payload;

    try {
      const result = sanitizeSvg(svgStr);
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: result
      });
    } catch (error) {
      logger.error(`cleanup failed: ${error.message}`);
      self.postMessage({
        id,
        type: 'result',
        success: false,
        error: error.message || 'Worker processing failed'
      });
    }
  } else if (type === 'buildAvatar') {
    const { avatar } = payload;

    try {
      const result = buildAvatarHtml(avatar);
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: result
      });
    } catch (error) {
      logger.error(`build avatar failed: ${error.message}`);
      self.postMessage({
        id,
        type: 'result',
        success: false,
        error: error.message || 'Worker processing failed'
      });
    }
  } else if (type === 'ensureViewBox') {
    const { svgStr } = payload;

    try {
      const result = ensureViewBox(svgStr);
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: result
      });
    } catch (error) {
      logger.error(`process viewBox failed: ${error.message}`);
      self.postMessage({
        id,
        type: 'result',
        success: false,
        error: error.message || 'Worker processing failed'
      });
    }
  }
};

// Notify main thread that Worker is ready
self.postMessage({ type: 'ready' });
