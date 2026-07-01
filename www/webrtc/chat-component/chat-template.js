let cachedTemplate = null;

export async function loadChatTemplate() {
    if (cachedTemplate) {
        return cachedTemplate;
    }

    try {
        const htmlUrl = new URL('./chat-component.html', import.meta.url).href;
        const response = await fetch(htmlUrl);
        if (response.ok) {
            cachedTemplate = await response.text();
            return cachedTemplate;
        }
        console.warn('[MailinkChat] Failed to load HTML template, using fallback');
        return '';
    } catch (error) {
        console.warn('[MailinkChat] Error loading HTML template:', error);
        return '';
    }
}
