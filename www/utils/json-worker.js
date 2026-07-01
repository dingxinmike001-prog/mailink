/**
 * JSON Worker utility module
 * Handles large JSON serialization/deserialization in a Worker thread
 * to avoid blocking the main thread
 */

import { workerManager } from '../services/worker-system.js';

// Task ID generator
let taskIdCounter = 0;
const pendingTasks = new Map();

/**
 * Generate a unique task ID
 * @returns {string} task ID
 */
function generateTaskId() {
    return `json_${++taskIdCounter}_${Date.now()}`;
}

/**
 * Get the Utils Worker instance
 * @returns {Worker|null} Worker instance
 */
function getUtilsWorker() {
    return workerManager.getWorker('utilsWorker');
}

/**
 * Send a task to the Worker
 * @param {string} type - task type
 * @param {Object} params - task parameters
 * @returns {Promise<any>} task result
 */
function sendWorkerTask(type, params) {
    return new Promise((resolve, reject) => {
        const worker = getUtilsWorker();
        if (!worker) {
            // Worker is not initialized; fall back to synchronous processing
            console.warn('[JSON Worker] Utils Worker not available, falling back to sync processing');
            try {
                let result;
                switch (type) {
                    case 'jsonParse':
                        result = params.jsonString ? JSON.parse(params.jsonString) : (params.options?.defaultValue ?? {});
                        break;
                    case 'jsonStringify':
                        result = JSON.stringify(params.data, null, params.options?.space ?? 0);
                        break;
                    case 'batchParseEmailDstr':
                        result = params.rows.map(row => {
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
                            return { ...row, _parsedDstr: parsed };
                        });
                        break;
                    default:
                        throw new Error(`Unknown task type: ${type}`);
                }
                resolve(result);
            } catch (error) {
                reject(error);
            }
            return;
        }

        const taskId = generateTaskId();
        
        // Set task timeout
        const timeout = setTimeout(() => {
            pendingTasks.delete(taskId);
            reject(new Error(`JSON Worker task timeout: ${type}`));
        }, 30000); // 30-second timeout

        // Store task callback
        pendingTasks.set(taskId, {
            resolve: (result) => {
                clearTimeout(timeout);
                resolve(result);
            },
            reject: (error) => {
                clearTimeout(timeout);
                reject(error);
            }
        });

        // Send task to Worker
        worker.postMessage({
            type,
            taskId,
            params
        });
    });
}

/**
 * Handle Worker messages
 * @param {MessageEvent} e - Worker message event
 */
export function handleWorkerMessage(e) {
    if (!e.data) return;
    
    const { type, taskId, success, result, error } = e.data;
    
    if (type !== 'result' || !taskId || !taskId.startsWith('json_')) {
        return; // Not a result from a JSON task
    }

    const task = pendingTasks.get(taskId);
    if (!task) {
        console.warn(`[JSON Worker] No pending task found for taskId: ${taskId}`);
        return;
    }

    pendingTasks.delete(taskId);

    if (success) {
        task.resolve(result);
    } else {
        task.reject(new Error(error || 'Worker task failed'));
    }
}

/**
 * Parse JSON string asynchronously
 * @param {string} jsonString - JSON string
 * @param {Object} options - options
 * @param {any} options.defaultValue - default value on parse failure
 * @returns {Promise<any>} parse result
 */
export async function jsonParseAsync(jsonString, options = {}) {
    return sendWorkerTask('jsonParse', { jsonString, options });
}

/**
 * Serialize data to JSON string asynchronously
 * @param {any} data - data to serialize
 * @param {Object} options - options
 * @param {number} options.space - indentation spaces
 * @returns {Promise<string>} JSON string
 */
export async function jsonStringifyAsync(data, options = {}) {
    return sendWorkerTask('jsonStringify', { data, options });
}

/**
 * Batch parse email dstr fields
 * @param {Array} rows - email row data
 * @param {Object} options - options
 * @param {any} options.defaultValue - default value on parse failure
 * @returns {Promise<Array>} parsed row data
 */
export async function batchParseEmailDstrAsync(rows, options = {}) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return rows;
    }
    return sendWorkerTask('batchParseEmailDstr', { rows, options });
}

/**
 * Check whether the Worker is available
 * @returns {boolean} whether the Worker is available
 */
export function isWorkerAvailable() {
    return !!getUtilsWorker();
}

// Export default object
export default {
    jsonParseAsync,
    jsonStringifyAsync,
    batchParseEmailDstrAsync,
    isWorkerAvailable,
    handleWorkerMessage
};
