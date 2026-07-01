let cachedTemplate = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 1000; // 1-second cache; reduce cache time during development

export async function loadTemplate() {
    // Disable cache or reduce cache time during development
    const now = Date.now();
    if (cachedTemplate && (now - cacheTimestamp) < CACHE_DURATION) {
        return cachedTemplate;
    }

    try {
        const htmlUrl = new URL('./mailink-sender.html?v=' + now, import.meta.url).href;
        const response = await fetch(htmlUrl);
        if (response.ok) {
            cachedTemplate = await response.text();
            cacheTimestamp = now;
            return cachedTemplate;
        }
        console.warn('[MailinkSender] Failed to load HTML template, using fallback');
        return '';
    } catch (error) {
        console.warn('[MailinkSender] Error loading HTML template:', error);
        return '';
    }
}
