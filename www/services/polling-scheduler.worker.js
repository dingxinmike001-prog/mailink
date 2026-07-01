/**
 * Polling Scheduler Worker
 * Responsibilities: manage scheduled polling in a background thread
 * - Provides more precise timer control
 * - Supports pause/resume/dynamic interval adjustment
 * - Supports parallel processing mode
 * - Automatically increases frequency during signaling transmission
 */

let baseInterval = 1000;   // Base interval (1 second)
let minInterval = 500;     // Minimum interval (high-frequency mode for signaling transmission)
let maxInterval = 6000;    // Maximum interval
let enabled = false;
let tickCount = 0;
let processingTimes = [];     // Recent N processing durations
const MAX_HISTORY = 10;       // History record count
let signalingMode = false;    // Signaling transmission mode flag
let lastTickTime = 0;         // Last tick send time
let dynamicTimer = null;      // Dynamic timer

self.onmessage = function (e) {
    const { type, data } = e.data;

    switch (type) {
        case 'start':
            startPolling(data);
            break;

        case 'stop':
            stopPolling();
            break;

        case 'pause':
            pausePolling();
            break;

        case 'resume':
            resumePolling();
            break;

        case 'updateInterval':
            updateInterval(data);
            break;

        case 'getStatus':
            sendStatus();
            break;

        case 'fetchComplete':
            // Received main thread fetch completion message
            // In parallel mode, send the next tick immediately without waiting
            scheduleNextTick();
            break;

        case 'processingTime':
            // Receive processing duration and adjust interval dynamically
            if (data && data.duration > 0) {
                processingTimes.push(data.duration);
                if (processingTimes.length > MAX_HISTORY) {
                    processingTimes.shift();
                }
            }
            break;

        case 'signalingState':
            // Signaling transmission state change
            signalingMode = data && data.active === true;
            console.log(`[Polling Scheduler Worker] Signaling mode: ${signalingMode ? 'on' : 'off'}`);
            // Reschedule when signaling mode changes
            if (enabled) {
                scheduleNextTick();
            }
            break;

        case 'setMode':
            // Set polling mode (optional: normal, high-frequency)
            if (data && data.mode === 'high-frequency') {
                minInterval = 500;
                baseInterval = 1000;
            } else {
                minInterval = 500;
                baseInterval = 1000;
            }
            console.log(`[Polling Scheduler Worker] Mode updated: ${data.mode}, base interval: ${baseInterval}ms`);
            break;
        case 'HEALTH_CHECK':
            // Health check message to confirm Worker is ready
            // No processing needed; receiving the message makes the main thread mark it as ready
            break;

        default:
            console.warn(`[Polling Scheduler Worker] Unknown message type: ${type}`);
    }
};

/**
 * Dynamically calculate the next polling interval
 */
function calculateDynamicInterval() {
    // Signaling transmission mode: use the minimum interval
    if (signalingMode) {
        return minInterval;
    }

    // Calculate the average processing duration
    let avgTime = 0;
    if (processingTimes.length > 0) {
        avgTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
    }

    // Dynamic adjustment strategy: interval = min(average processing duration, base interval)
    // This ensures the next poll starts preparing before the current processing completes
    const interval = Math.min(avgTime, baseInterval);

    // Ensure the interval stays within the valid range
    return Math.max(minInterval, Math.min(interval, maxInterval));
}

/**
 * Schedule the next poll
 */
function scheduleNextTick() {
    if (!enabled) return;

    // Clear previous timer
    if (dynamicTimer) {
        clearTimeout(dynamicTimer);
        dynamicTimer = null;
    }

    // Calculate the dynamic interval
    const nextInterval = calculateDynamicInterval();

    // Send status information
    self.postMessage({
        type: 'scheduleInfo',
        interval: nextInterval,
        avgProcessingTime: processingTimes.length > 0
            ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
            : 0,
        signalingMode: signalingMode
    });

    // Set the timer
    dynamicTimer = setTimeout(() => {
        sendTick();
    }, nextInterval);
}

/**
 * Start polling (parallel mode)
 */
function startPolling(data) {
    // Update configuration
    enabled = true;
    tickCount = 0;
    processingTimes = []; // Clear historical data

    // Read the base interval from configuration
    if (data && data.interval) {
        baseInterval = Math.max(1000, Math.min(data.interval, 6000));
    }

    // Send the first tick immediately
    sendTick();

    console.log(`[Polling Scheduler Worker] Parallel polling mode started, base interval: ${baseInterval}ms`);

    self.postMessage({
        type: 'started',
        mode: 'parallel',
        interval: baseInterval
    });
}

/**
 * Send tick message
 */
function sendTick() {
    if (enabled) {
        tickCount++;
        lastTickTime = Date.now();
        
        self.postMessage({
            type: 'tick',
            tickCount: tickCount,
            timestamp: lastTickTime,
            signalingMode: signalingMode  // [Fix] Pass signaling mode status
        });
    }
}

/**
 * Stop polling
 */
function stopPolling() {
    enabled = false;
    const finalTickCount = tickCount;
    tickCount = 0;

    console.log(`[Polling Scheduler Worker] Polling stopped, executed ${finalTickCount} time(s)`);

    self.postMessage({
        type: 'stopped',
        finalTickCount: finalTickCount
    });
}

/**
 * Pause polling (keep timer running but do not send tick)
 */
function pausePolling() {
    enabled = false;

    console.log(`[Polling Scheduler Worker] Polling paused (tick #${tickCount})`);

    self.postMessage({
        type: 'paused',
        tickCount: tickCount
    });
}

/**
 * Resume polling
 */
function resumePolling() {
    enabled = true;

    console.log(`[Polling Scheduler Worker] Polling resumed (tick #${tickCount})`);

    self.postMessage({
        type: 'resumed',
        tickCount: tickCount
    });
}

/**
 * Update polling interval
 */
function updateInterval(data) {
    const newInterval = (data && data.interval) || baseInterval;
    
    // Limit the interval range
    const validatedInterval = Math.max(500, Math.min(newInterval, 6000));
    
    if (validatedInterval === baseInterval) {
        console.log(`[Polling Scheduler Worker] Interval unchanged: ${baseInterval}ms`);
        return;
    }

    baseInterval = validatedInterval;

    console.log(`[Polling Scheduler Worker] Interval updated: ${baseInterval}ms`);

    self.postMessage({
        type: 'intervalUpdated',
        interval: baseInterval,
        mode: 'dynamic'
    });

    // If running, reschedule
    if (enabled) {
        scheduleNextTick();
    }
}

/**
 * Send current status
 */
function sendStatus() {
    const avgTime = processingTimes.length > 0
        ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
        : 0;

    const status = {
        running: enabled || isTickProcessing,
        enabled: enabled,
        baseInterval: baseInterval,
        minInterval: minInterval,
        currentInterval: calculateDynamicInterval(),
        avgProcessingTime: avgTime,
        tickCount: tickCount,
        signalingMode: signalingMode,
        mode: 'parallel'
    };

    self.postMessage({
        type: 'status',
        status: status
    });
}

// Worker initialization log
console.log('[Polling Scheduler Worker] Initialized and ready - parallel mode');
