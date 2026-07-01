export function decodeHtmlEntities(input) {
  const raw = String(input ?? '');
  if (!raw) return '';

  let out = raw;
  for (let i = 0; i < 3; i++) {
    const prev = out;
    out = out
      .replace(/&amp;/g, '&')
      .replace(/&lt;|&#0*60;|&#x0*3c;/gi, '<')
      .replace(/&gt;|&#0*62;|&#x0*3e;/gi, '>')
      .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
      .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'");

    if (out === prev) break;
  }

  return out;
}

export function dedupeImageMessageHtml(inputHtml) {
  if (!inputHtml || !inputHtml.includes('image-message')) return inputHtml || '';
  const raw = String(inputHtml);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = raw;

  const seen = new Set();
  const blocks = Array.from(wrapper.querySelectorAll('.image-message'));
  for (const block of blocks) {
    const img = block.querySelector('img');
    const storedFileName = block.getAttribute('data-stored-filename') || '';
    const alt = img ? (img.getAttribute('alt') || '') : '';
    const src = img ? (img.getAttribute('src') || '') : '';
    const key = `${storedFileName}|${alt}|${src}`;
    if (!storedFileName && !alt && !src) continue;

    if (seen.has(key)) {
      block.remove();
    } else {
      seen.add(key);
    }
  }

  return wrapper.innerHTML;
}

export function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

export function resolveIsSender(msg, context) {
  const myEmail = normalizeEmail(context.myEmail);
  const targetEmail = normalizeEmail(context.targetEmail);
  const fromEmail = normalizeEmail(msg.fromer);
  const toEmail = normalizeEmail(msg.toer);

  if (myEmail) {
    return fromEmail === myEmail;
  }

  if (targetEmail) {
    if (fromEmail === targetEmail) return false;
    if (toEmail === targetEmail) return true;
  }

  return false;
}

export function inferIsSenderFromMessageContent(content) {
  if (!content) return null;
  const lower = String(content).toLowerCase();

  const filePathMatch =
    lower.match(/data-file-path="([^"]+)"/) ||
    lower.match(/data-file-path='([^']+)'/);
  if (filePathMatch && filePathMatch[1]) {
    const fp = filePathMatch[1];
    if (/[\\/](files[\\/])?sends[\\/]/i.test(fp)) return true;
    if (/[\\/](files[\\/])?recvs[\\/]/i.test(fp)) return false;
  }

  if (lower.includes('/sends/')) return true;
  if (lower.includes('/recvs/')) return false;
  if (/[\\/]sends[\\/]/i.test(lower)) return true;
  if (/[\\/]recvs[\\/]/i.test(lower)) return false;

  return null;
}

export function parseFileSize(sizeStr) {
  const units = { 'B': 1, 'KB': 1024, 'MB': 1024 * 1024, 'GB': 1024 * 1024 * 1024 };
  const match = sizeStr.match(/^([\d.]+)\s*(B|KB|MB|GB)$/i);
  if (match) {
    return parseFloat(match[1]) * (units[match[2].toUpperCase()] || 1);
  }
  return 0;
}
