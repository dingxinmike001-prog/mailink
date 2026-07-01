const path = require('path');
const fs = require('fs');
const logger = require('../logger');
const { createWorkerManager } = require('../../shared/worker/worker-factory');

const thumbnailWorkerManager = createWorkerManager('thumbnail');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

function getThumbnailFileName(originalFileName) {
    const lastDot = originalFileName.lastIndexOf('.');
    if (lastDot === -1) return originalFileName + '_thumb.jpg';
    return originalFileName.substring(0, lastDot) + '_thumb.jpg';
}

function isImageFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
}

async function generateThumbnail(filePath, options = {}) {
    const { maxWidth = 200, quality = 0.8 } = options;

    if (!isImageFile(filePath)) {
        return { skipped: true, reason: 'not_image_file' };
    }

    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
        return { skipped: true, reason: 'file_not_found' };
    }

    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const thumbFileName = getThumbnailFileName(fileName);
    const thumbPath = path.join(dir, thumbFileName);

    try {
        const stat = await fs.promises.stat(thumbPath);
        if (stat.size > 0) {
            return { thumbnailPath: thumbPath, thumbnailFileName: thumbFileName, alreadyExists: true };
        }
    } catch {}

    try {
        const result = await thumbnailWorkerManager.sendTask({
            inputPath: filePath,
            outputPath: thumbPath,
            maxWidth,
            quality
        });

        if (result && result.skipped) {
            return { skipped: true, reason: result.reason };
        }

        return {
            thumbnailPath: thumbPath,
            thumbnailFileName: thumbFileName,
            alreadyExists: false,
            width: result?.width,
            height: result?.height
        };
    } catch (error) {
        logger.error(`[ThumbnailGenerator] Thumbnail generation failed: ${filePath}, ${error.message}`);
        return { skipped: true, reason: 'generation_failed', error: error.message };
    }
}

module.exports = {
    generateThumbnail,
    getThumbnailFileName,
    isImageFile
};
