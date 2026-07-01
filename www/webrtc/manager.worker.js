// WebRTC management Worker, handles WebRTC-related asynchronous operations
// Note: The Worker environment does not support direct use of the RTCPeerConnection API
// This Worker is mainly responsible for connection state management, message forwarding, and connection recovery

// Connection state constants
const CONNECTION_STATUS = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    FAILED: 'failed'
};

// WebRTC connection state management class
class WebRTCConnectionStatus {
    constructor(targetEmail) {
        this.targetEmail = targetEmail;
        this.status = CONNECTION_STATUS.DISCONNECTED;
        this.lastActivityTime = Date.now();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000; // 5 seconds
        this.reconnectTimer = null;
    }

    // Update connection status
    updateStatus(newStatus) {
        if (this.status !== newStatus) {
            this.status = newStatus;
            this.lastActivityTime = Date.now();

            // Send state change notification
            self.postMessage({
                type: 'CONNECTION_STATUS_CHANGED',
                targetEmail: this.targetEmail,
                status: this.status
            });

            // Handle state change logic
            if (newStatus === CONNECTION_STATUS.CONNECTED) {
                this.reconnectAttempts = 0;
            } else if (newStatus === CONNECTION_STATUS.DISCONNECTED) {
                this.attemptReconnect();
            }
        }
    }

    // Record activity time
    recordActivity() {
        this.lastActivityTime = Date.now();
    }

    // Attempt to reconnect
    attemptReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.updateStatus(CONNECTION_STATUS.FAILED);
            return;
        }

        this.reconnectAttempts++;
        this.updateStatus(CONNECTION_STATUS.CONNECTING);

        // Attempt to reconnect after a delay
        this.reconnectTimer = setTimeout(() => {
            self.postMessage({
                type: 'RECONNECT_ATTEMPT',
                targetEmail: this.targetEmail,
                attempt: this.reconnectAttempts
            });
            // Request the main thread to re-establish the connection
            self.postMessage({
                type: 'REQUEST_RECONNECT',
                targetEmail: this.targetEmail
            });
        }, this.reconnectDelay * this.reconnectAttempts);
    }

    // Close connection
    close() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.updateStatus(CONNECTION_STATUS.DISCONNECTED);
    }

    // Get connection status
    getStatus() {
        return this.status;
    }
}

// WebRTC manager, manages multiple connection states
class WebRTCManager {
    constructor() {
        this.connections = new Map();
        this.statusCheckInterval = null;
        this.statusCheckIntervalTime = 30000; // 30 seconds
        this.initStatusCheck();
    }

    // Initialize state checks
    initStatusCheck() {
        this.statusCheckInterval = setInterval(() => {
            this.checkAllConnections();
        }, this.statusCheckIntervalTime);
    }

    // Check all connection states
    checkAllConnections() {
        const now = Date.now();
        this.connections.forEach((connection, targetEmail) => {
            // Check whether the connection has been inactive for a long time
            if (connection.status === CONNECTION_STATUS.CONNECTED &&
                now - connection.lastActivityTime > 60000) { // 60 seconds
                self.postMessage({
                    type: 'CONNECTION_INACTIVE',
                    targetEmail: targetEmail
                });
            }

            // Check connection state
            if (connection.status === CONNECTION_STATUS.DISCONNECTED &&
                now - connection.lastActivityTime > 300000) { // 5 minutes
                // Clean up long-disconnected connections
                this.removeConnection(targetEmail);
            }
        });
    }

    // Get or create connection state management
    getOrCreateConnection(targetEmail) {
        if (!this.connections.has(targetEmail)) {
            this.connections.set(targetEmail, new WebRTCConnectionStatus(targetEmail));
        }
        return this.connections.get(targetEmail);
    }

    // Delete the connection
    removeConnection(targetEmail) {
        const connection = this.connections.get(targetEmail);
        if (connection) {
            connection.close();
            this.connections.delete(targetEmail);
        }
    }

    // Get all connection statuses
    getAllConnectionStatus() {
        const statusMap = new Map();
        this.connections.forEach((connection, targetEmail) => {
            statusMap.set(targetEmail, connection.getStatus());
        });
        return statusMap;
    }

    // Close all connections
    closeAllConnections() {
        this.connections.forEach((connection, targetEmail) => {
            connection.close();
        });
        this.connections.clear();

        if (this.statusCheckInterval) {
            clearInterval(this.statusCheckInterval);
            this.statusCheckInterval = null;
        }
    }
}

// ICE candidate handling logic (migrated from utils/webrtc.js)
const ICEUtils = {
    // ICE candidate priority sorting
    getIceCandidatePriority: function (candidate) {
        let priority = 0;
        if (candidate.candidate) {
            const candidateStr = candidate.candidate;
            if (candidateStr.includes('typ host')) {
                priority = 100;
            } else if (candidateStr.includes('typ srflx')) {
                priority = 200;
            } else if (candidateStr.includes('typ relay')) {
                priority = 1;
            } else if (candidateStr.includes('typ prflx')) {
                priority = 150;
            }

            if (candidateStr.includes('udp')) {
                priority += 10;
            }
        }
        return priority;
    },

    // ICE candidate deduplication
    deduplicateIceCandidates: function (candidates) {
        const seen = new Set();
        const uniqueCandidates = [];
        candidates.forEach(candidate => {
            if (candidate && candidate.candidate) {
                const candidateStr = candidate.candidate;
                if (!seen.has(candidateStr)) {
                    seen.add(candidateStr);
                    uniqueCandidates.push(candidate);
                }
            }
        });
        return uniqueCandidates;
    },

    // Filter high-priority ICE candidates
    filterHighPriorityIceCandidates: function (candidates, networkType = 'unknown', downlink = 0) {
        // Deduplicate
        const uniqueCandidates = this.deduplicateIceCandidates(candidates);

        // Sort by priority
        const sortedCandidates = uniqueCandidates.sort((a, b) => {
            return this.getIceCandidatePriority(b) - this.getIceCandidatePriority(a);
        });

        // Keep only top N high-priority candidates (adjust based on network conditions)
        let maxCandidates = 15;
        if (networkType === '2g' || downlink < 1) {
            maxCandidates = 8;
        } else if (networkType === '3g' || downlink < 5) {
            maxCandidates = 12;
        }

        const filteredCandidates = sortedCandidates.slice(0, maxCandidates);
        return filteredCandidates;
    }
};

// Initialize the WebRTC manager
const webRTCManager = new WebRTCManager();

// Contact management related functions
async function checkAndAddContact(fromEmail) {
    // Send a request to the main thread to check and add contacts
    self.postMessage({
        type: 'CHECK_AND_ADD_CONTACT',
        fromEmail: fromEmail
    });
}

// Listen to main thread messages
self.onmessage = function (e) {
    const { type, targetEmail, status, message, data } = e.data;

    try {
        switch (type) {
            case 'HEALTH_CHECK':
                // Health check message to confirm Worker is ready
                // No processing needed; receiving the message makes the main thread mark it as ready
                break;
                
            case 'UPDATE_CONNECTION_STATUS':
                // Update connection status
                const connection1 = webRTCManager.getOrCreateConnection(targetEmail);
                connection1.updateStatus(status);
                break;

            case 'RECORD_ACTIVITY':
                // Record activity time
                const connection2 = webRTCManager.getOrCreateConnection(targetEmail);
                connection2.recordActivity();
                break;

            case 'SEND_DATA':
                // Forward data send requests to the main thread
                self.postMessage({
                    type: 'FORWARD_SEND_DATA',
                    targetEmail: targetEmail,
                    data: data
                });
                break;

            case 'DATA_CHANNEL_MESSAGE':
                // Forward data channel messages to the main thread
                self.postMessage({
                    type: 'DATA_CHANNEL_MESSAGE',
                    targetEmail: targetEmail,
                    message: message
                });
                break;

            case 'CLOSE_CONNECTION':
                // Close connection
                webRTCManager.removeConnection(targetEmail);
                self.postMessage({
                    type: 'CONNECTION_CLOSED',
                    targetEmail: targetEmail
                });
                break;

            case 'GET_CONNECTION_STATUS':
                // Get connection status
                const connection3 = webRTCManager.getOrCreateConnection(targetEmail);
                const connectionStatus = connection3.getStatus();
                self.postMessage({
                    type: 'CONNECTION_STATUS_RESPONSE',
                    targetEmail: targetEmail,
                    status: connectionStatus
                });
                break;

            case 'GET_ALL_CONNECTION_STATUS':
                // Get all connection statuses
                const allStatus = webRTCManager.getAllConnectionStatus();
                self.postMessage({
                    type: 'ALL_CONNECTION_STATUS_RESPONSE',
                    status: Array.from(allStatus.entries())
                });
                break;

            case 'CHECK_AND_ADD_CONTACT':
                // Check and add contact
                checkAndAddContact(data.fromEmail);
                break;

            case 'CLOSE_ALL_CONNECTIONS':
                // Close all connections
                webRTCManager.closeAllConnections();
                self.postMessage({
                    type: 'ALL_CONNECTIONS_CLOSED'
                });
                break;

            case 'RECONNECT_SUCCESS':
                // Reconnection successful
                const connection4 = webRTCManager.getOrCreateConnection(targetEmail);
                connection4.updateStatus(CONNECTION_STATUS.CONNECTED);
                break;

            case 'RECONNECT_FAILED':
                // Reconnection failed
                const connection5 = webRTCManager.getOrCreateConnection(targetEmail);
                connection5.updateStatus(CONNECTION_STATUS.FAILED);
                break;

            case 'FILTER_ICE_CANDIDATES':
                // Filter ICE candidates
                const { candidates, networkInfo } = data;
                const filteredCandidates = ICEUtils.filterHighPriorityIceCandidates(
                    candidates,
                    networkInfo?.effectiveType,
                    networkInfo?.downlink
                );
                self.postMessage({
                    type: 'FILTER_ICE_CANDIDATES_RESPONSE',
                    taskId: e.data.taskId,
                    candidates: filteredCandidates
                });
                break;

            default:
                console.warn('WebRTC Worker: Unknown message type:', type);
        }
    } catch (error) {
        // Capture and send internal errors
        self.postMessage({
            type: 'WORKER_ERROR',
            error: {
                message: error.message,
                stack: error.stack
            }
        });
    }
};

// Clean up resources
self.addEventListener('close', () => {
    webRTCManager.closeAllConnections();
});

console.log('✅ WebRTC manager worker initialized - state management mode');
