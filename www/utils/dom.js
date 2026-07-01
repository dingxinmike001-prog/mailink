import { getUtilsRoot } from './root.js';

export function sanitizeHtml(html) {
  const root = getUtilsRoot();
  const api = root?.dom;
  const impl = api?.sanitizeHtml;
  if (typeof impl === 'function') return impl.call(api, html);
  const allowedTags = /<br\s*\/?>|<b>|<\/b>|<i>|<\/i>|<strong>|<\/strong>|<em>|<\/em>/gi;
  return html.replace(/<[^>]*>/g, (tag) => (allowedTags.test(tag) ? tag : ''));
}

export function textToHtml(text) {
  const root = getUtilsRoot();
  const api = root?.dom;
  const impl = api?.textToHtml;
  if (typeof impl === 'function') return impl.call(api, text);

  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  html = html.replace(/\r\n/g, '\n');
  html = html.replace(/\r/g, '\n');
  html = html.replace(/\n/g, '<br>');

  return html;
}
