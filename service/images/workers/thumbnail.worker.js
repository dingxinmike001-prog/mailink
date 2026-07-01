const { parentPort } = require('worker_threads');
const sharp = require('sharp');

function sendLog(level, message) {
    parentPort.postMessage({ type: 'log', level, message: `[ThumbnailWorker] ${message}` });
}

async function processThumbnail(data) {
    const { inputPath, outputPath, maxWidth, quality } = data;

    try {
        const metadata = await sharp(inputPath).metadata();

        if (!metadata.width || !metadata.height) {
            sendLog('warn', `Cannot read image dimensions: ${inputPath}`);
            return { skipped: true, reason: 'cannot_read_dimensions' };
        }

        if (metadata.width <= maxWidth) {
            sendLog('info', `Image width (${metadata.width}px) is not greater than ${maxWidth}px, skipping: ${inputPath}`);
            return { skipped: true, reason: 'image_too_small' };
        }

        const ratio = maxWidth / metadata.width;
        const height = Math.round(metadata.height * ratio);

        await sharp(inputPath)
            .resize(maxWidth, height)
            .jpeg({ quality: Math.round((quality || 0.8) * 100) })
            .toFile(outputPath);

        sendLog('info', `Thumbnail generated successfully: ${outputPath}, ${maxWidth}x${height}`);
        return { skipped: false, width: maxWidth, height };
    } catch (error) {
        sendLog('error', `Thumbnail generation failed: ${inputPath}, ${error.message}`);
        return { skipped: true, reason: 'generation_error', error: error.message };
    }
}

parentPort.on('message', async (message) => {
    const { id, ...data } = message;

    try {
        const result = await processThumbnail(data);
        parentPort.postMessage({ id, success: true, data: result });
    } catch (error) {
        parentPort.postMessage({ id, success: false, error: error.message });
    }
});

parentPort.postMessage({ success: true, data: 'Thumbnail Worker ready' });
