export function getThumbnailFileName(originalFileName) {
    const lastDot = originalFileName.lastIndexOf('.');
    if (lastDot === -1) return originalFileName + '_thumb.jpg';
    return originalFileName.substring(0, lastDot) + '_thumb.jpg';
}

export function deriveThumbnailUrl(originalUrl) {
    if (!originalUrl) return originalUrl;
    try {
        const url = new URL(originalUrl);
        const pathname = url.pathname;
        const lastDot = pathname.lastIndexOf('.');
        if (lastDot === -1) return originalUrl;
        const thumbPath = pathname.substring(0, lastDot) + '_thumb.jpg';
        return url.origin + thumbPath;
    } catch {
        return originalUrl;
    }
}

export function setupThumbnailFallback(imgElement) {
    if (!imgElement || imgElement._thumbnailFallbackSetup) return;
    imgElement._thumbnailFallbackSetup = true;

    imgElement.addEventListener('error', function onThumbnailError() {
        const originalSrc = this.dataset.originalSrc;
        if (!originalSrc || this.src === originalSrc || this._fallbackAttempted) {
            this.removeEventListener('error', onThumbnailError);
            return;
        }

        this._fallbackAttempted = true;
        this.src = originalSrc;

        if (window.electronAPI?.generateThumbnail) {
            const filePath = originalSrcToFilePath(originalSrc);
            if (filePath) {
                window.electronAPI.generateThumbnail(filePath, 200).catch(() => {});
            }
        }
    });
}

export function enhanceImageWithThumbnail(imgElement) {
    if (!imgElement || imgElement._thumbnailEnhanced) return;
    imgElement._thumbnailEnhanced = true;

    if (imgElement.dataset.originalSrc) {
        setupThumbnailFallback(imgElement);
        return;
    }

    const currentSrc = imgElement.src;
    if (!currentSrc || currentSrc === window.location.href) return;

    const thumbnailUrl = deriveThumbnailUrl(currentSrc);
    if (thumbnailUrl === currentSrc) return;

    imgElement.dataset.originalSrc = currentSrc;
    imgElement.src = thumbnailUrl;
    setupThumbnailFallback(imgElement);
}

export function originalSrcToFilePath(url) {
    if (!url) return null;
    try {
        const urlObj = new URL(url);
        const pathname = decodeURIComponent(urlObj.pathname);
        const parts = pathname.split('/').filter(p => p.length > 0);

        if (parts.length >= 4 && parts[1] === 'files' && (parts[2] === 'recvs' || parts[2] === 'sends')) {
            return pathname;
        }
        if (parts.length >= 2 && (parts[0] === 'recvs' || parts[0] === 'sends')) {
            return pathname;
        }
        return pathname;
    } catch {
        return null;
    }
}

export function buildImageHtmlWithThumbnail(options) {
    const {
        thumbnailUrl,
        originalUrl,
        alt,
        title,
        style,
        id,
        dataAttributes = '',
        onclick
    } = options;

    const imgSrc = thumbnailUrl || originalUrl;
    const originalSrcAttr = originalUrl ? `data-original-src="${originalUrl}"` : '';
    const onclickAttr = onclick || (originalUrl
        ? `onclick="event.stopPropagation(); window.open(this.dataset.originalSrc || this.src, '_blank');"`
        : '');

    return `<img src="${imgSrc}" ${originalSrcAttr} alt="${alt || ''}" title="${title || ''}" style="${style || ''}" ${id ? `id="${id}"` : ''} ${dataAttributes} ${onclickAttr}>`;
}
