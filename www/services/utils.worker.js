/**
 * Utils Worker
 * Responsibilities: process compute-intensive utility functions in a background thread
 * - Avatar generation
 * - Complex data processing and transformation
 * - Encryption and decryption operations
 */

// Avatar generation function
function generateAvatar(email) {
    if (!email || !email.includes('@')) {
        return '';
    }

    // Get first 2 and last 2 characters before @ in email address
    const localPart = email.split('@')[0];
    let chars = '';
    if (localPart.length >= 4) {
        chars = (localPart.substring(0, 2) + localPart.slice(-2)).toUpperCase();
    } else {
        // If fewer than 4 characters, repeat to fill
        chars = (localPart + localPart).substring(0, 4).toUpperCase();
    }

    // Generate random grayscale background from 60% to 100%
    const grayLevel = Math.floor(Math.random() * 41) + 60; // 60-100
    const bgColor = `rgb(${grayLevel}, ${grayLevel}, ${grayLevel})`;

    // Generate random colored letters (excluding gray, white, and black)
    const getRandomColor = () => {
        let r, g, b;
        do {
            r = Math.floor(Math.random() * 256);
            g = Math.floor(Math.random() * 256);
            b = Math.floor(Math.random() * 256);
            // exclude colors close to gray/white/black
        } while ((r > 220 && g > 220 && b > 220) || // Close to white
        (r < 30 && g < 30 && b < 30) || // Close to black
            (Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && Math.abs(b - r) < 10)); // Close to gray
        return `rgb(${r}, ${g}, ${b})`;
    };

    // Generate different random color for each character
    const colors = [getRandomColor(), getRandomColor(), getRandomColor(), getRandomColor()];

    // Generate a 48x48 SVG with 5px rounded corners; 4 characters occupy 4 corners, each 1/4 area
    const svg = `
        <svg width="48" height="48" xmlns="http://www.w3.org/2000/svg">
            <rect width="48" height="48" fill="${bgColor}" rx="5" ry="5" />
            <!-- top-right area：first character -->
            <text x="12" y="18" font-size="18" font-weight="bold" fill="${colors[0]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[0]}</text>
            <!-- top-right area：second character -->
            <text x="36" y="18" font-size="18" font-weight="bold" fill="${colors[1]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[1]}</text>
            <!-- bottom-left area：third character -->
            <text x="12" y="42" font-size="18" font-weight="bold" fill="${colors[2]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[2]}</text>
            <!-- bottom-right area：fourth character -->
            <text x="36" y="42" font-size="18" font-weight="bold" fill="${colors[3]}" text-anchor="middle" font-family="Arial, sans-serif">${chars[3]}</text>
        </svg>
    `.trim();

    return svg;
}

// Complex data processing and transformation
function processComplexData(data, options = {}) {
    if (!data) return data;

    const { type, transform } = options;

    switch (type) {
        case 'filter':
            return Array.isArray(data) ? data.filter(transform) : data;
        case 'map':
            return Array.isArray(data) ? data.map(transform) : data;
        case 'reduce':
            return Array.isArray(data) ? data.reduce(transform, options.initialValue) : data;
        case 'sort':
            return Array.isArray(data) ? [...data].sort(transform) : data;
        case 'flatten':
            return Array.isArray(data) ? data.flat(options.depth || 1) : data;
        case 'unique':
            return Array.isArray(data) ? [...new Set(data)] : data;
        default:
            return data;
    }
}

// Large JSON data serialization (stringify)
function jsonStringifyLarge(data, options = {}) {
    try {
        const { space = 0, maxDepth = 10 } = options;

        // Handle circular references
        const seen = new WeakSet();
        const safeData = JSON.parse(JSON.stringify(data, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular Reference]';
                }
                seen.add(value);
            }
            return value;
        }));

        return JSON.stringify(safeData, null, space);
    } catch (error) {
        throw new Error(`JSON stringify failed: ${error.message}`);
    }
}

// Large JSON data deserialization (parse)
function jsonParseLarge(jsonString, options = {}) {
    try {
        const { defaultValue = {} } = options;

        if (!jsonString || typeof jsonString !== 'string') {
            return defaultValue;
        }

        return JSON.parse(jsonString);
    } catch (error) {
        throw new Error(`JSON parse failed: ${error.message}`);
    }
}

// Batch parse email split fields (attachments and headers are JSON TEXT)
function batchParseEmailDstr(rows, options = {}) {
    if (!Array.isArray(rows)) return [];

    return rows.map(row => {
        let parsed = { text: '', html: '', attachments: [], headers: {}, priority: '' };
        try {
            parsed.text = row.txtbody || '';
            parsed.html = row.htmbody || '';
            parsed.priority = row.priority || '';
            if (row.attachments) {
                parsed.attachments = typeof row.attachments === 'string'
                    ? JSON.parse(row.attachments) : row.attachments;
            }
            if (row.headers) {
                parsed.headers = typeof row.headers === 'string'
                    ? JSON.parse(row.headers) : row.headers;
            }
        } catch (e) {
            // use defaults
        }

        return {
            ...row,
            _parsedDstr: parsed
        };
    });
}

// Encryption and decryption operations
function cryptoOperation(operation, data, options = {}) {
    // Basic encryption/decryption framework supporting future extensions
    // Currently implements simple Base64 encoding/decoding
    if (operation === 'encode') {
        if (typeof data === 'string') {
            return btoa(unescape(encodeURIComponent(data)));
        }
        return btoa(JSON.stringify(data));
    } else if (operation === 'decode') {
        try {
            const decoded = decodeURIComponent(escape(atob(data)));
            // Try to parse JSON; return the string on failure
            return JSON.parse(decoded);
        } catch (e) {
            return decodeURIComponent(escape(atob(data)));
        }
    }
    return data;
}

// Task queue management
const taskQueue = new Map();
let taskId = 0;

// Message processing
self.onmessage = function (e) {
    const { type, taskId, params } = e.data;

    try {
        let result;

        switch (type) {
            case 'generateAvatar':
                result = generateAvatar(params.email);
                break;
            case 'processData':
                result = processComplexData(params.data, params.options);
                break;
            case 'crypto':
                result = cryptoOperation(params.operation, params.data, params.options);
                break;
            case 'jsonStringify':
                result = jsonStringifyLarge(params.data, params.options);
                break;
            case 'jsonParse':
                result = jsonParseLarge(params.jsonString, params.options);
                break;
            case 'batchParseEmailDstr':
                result = batchParseEmailDstr(params.rows, params.options);
                break;
            default:
                throw new Error(`Unknown operation type: ${type}`);
        }

        // Return result
        self.postMessage({
            type: 'result',
            taskId: taskId,
            success: true,
            result: result
        });
    } catch (error) {
        // Return error
        self.postMessage({
            type: 'result',
            taskId: taskId,
            success: false,
            error: error.message
        });
    }
};

// Worker initialization log
console.log('[Utils Worker] Initialized and ready');
