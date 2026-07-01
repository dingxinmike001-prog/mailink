// Global utility library - unified collection of all utility functions
window.utils = window.utils || {};
if (typeof window.log !== 'function') {
    window.log = console.log.bind(console);
}

// Formatting-related functions
window.utils.format = {
    // Format date
    formatDate: function (dateString) {
        const date = new Date(dateString);
        return date.toLocaleString(window.i18n?.getLocale() || 'zh-CN');
    },

    // Convert nanosecond timestamp to millisecond timestamp
    convertToMilliseconds: function(timestamp) {
        if (timestamp) {
            if (typeof timestamp === 'string') {
                // Handle string-type timestamps
                if (timestamp.length > 15) {
                    // Nanosecond timestamp converted to milliseconds (divide by 1e6)
                    return Number(BigInt(timestamp) / BigInt(1000000));
                } else {
                    // Millisecond or second-level timestamp
                    return Number(timestamp);
                }
            } else if (typeof timestamp === 'number') {
                // Handle numeric timestamps
                if (timestamp > 1e15) {
                    // Nanosecond timestamp converted to milliseconds
                    return Math.floor(timestamp / 1e6);
                }
            }
            return timestamp;
        }
        return null;
    },

    // Format time (hours, minutes, seconds)
    formatTime: function (timestamp) {
        const msTimestamp = this.convertToMilliseconds(timestamp);
        const now = msTimestamp ? new Date(msTimestamp) : new Date();
        return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    },

    // Format full time (including milliseconds)
    formatTimeFull: function (timestamp) {
        const msTimestamp = this.convertToMilliseconds(timestamp);
        const now = msTimestamp ? new Date(msTimestamp) : new Date();
        return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    }
};
window.utils.message = {
    generateMessageId: function () {
        var timestamp = Date.now().toString(36);
        var random = Math.random().toString(36).slice(2, 10);
        return 'msg-' + timestamp + '-' + random;
    }
};

// Utility helper functions - unified Worker support detection
window.utils.helper = {
    // Check whether Worker is supported
    isWorkerSupported: function () {
        return typeof window !== 'undefined' && typeof window.Worker === 'function';
    },

    // Check whether Worker is available
    isWorkerAvailable: function (workerName = 'utilsWorker') {
        if (!this.isWorkerSupported()) {
            return false;
        }
        
        // Check whether workerManager and the specified Worker are available
        return !!window.workerManager?.getWorker(workerName);
    }
};

// Avatar generation-related functions
window.utils.avatar = {
    // Generate avatar synchronously locally (fallback)
    generateAvatarLocal: function (email) {
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
        const getRandomColor = function () {
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
    },

    // SVG avatar generation function - prefer Worker, fall back to local implementation
    // Asynchronous avatar generation function (using Worker)
    generateAvatar: async function (email) {
        if (!window.utils.helper.isWorkerSupported()) {
            return this.generateAvatarLocal(email);
        }

        try {
            // Dynamically import WorkerManager to avoid circular dependencies
            const { workerManager } = await import('./index/worker-system.js');

            // Create a Promise to handle the Worker response
            return new Promise((resolve, reject) => {
                const taskId = Math.random().toString(36).substr(2, 9);

                // Temporary message handler function
                const handleMessage = (e) => {
                    const { type, taskId: responseTaskId, success, result, error } = e.data;

                    if (type === 'result' && responseTaskId === taskId) {
                        // Remove event listener
                        const worker = workerManager.getWorker('utilsWorker');
                        if (worker) {
                            worker.removeEventListener('message', handleMessage);
                        }

                        if (success) {
                            resolve(result);
                        } else {
                            reject(new Error(error));
                        }
                    }
                };

                // Get the Worker and add event listener
                const worker = workerManager.getWorker('utilsWorker');
                if (worker) {
                    worker.addEventListener('message', handleMessage);

                    // Send message to Worker
                    worker.postMessage({
                        type: 'generateAvatar',
                        taskId: taskId,
                        params: { email: email }
                    });
                } else {
                    // If Worker is unavailable, use the local implementation
                    resolve(this.generateAvatarLocal(email));
                }
            });
        } catch (error) {
            console.error('Error in generateAvatar:', error);
            // Use the local implementation on error
            return this.generateAvatarLocal(email);
        }
    },

    // Keep backward-compatible asynchronous version alias
    generateAvatarAsync: async function (email) {
        return this.generateAvatar(email);
    }
};

// Encryption and decryption related functions
window.utils.crypto = {
    cryptoLocalEncode: function (data) {
        if (typeof data === 'string') {
            return btoa(unescape(encodeURIComponent(data)));
        }
        return btoa(JSON.stringify(data));
    },

    cryptoLocalDecode: function (data) {
        try {
            const decoded = decodeURIComponent(escape(atob(data)));
            return JSON.parse(decoded);
        } catch (e) {
            return decodeURIComponent(escape(atob(data)));
        }
    }
};

// Data processing related functions
window.utils.data = {
    processDataLocal: function (data, options) {
        if (!data) return data;
        const { type, transform } = options;

        switch (type) {
            case 'filter':
                return Array.isArray(data) ? data.filter(transform) : data;
            case 'map':
                return Array.isArray(data) ? data.map(transform) : data;
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
};

// WebRTC-related functions
window.utils.webrtc = {
    // Detect network type and dynamically adjust ICE candidate pool size
    getOptimalIceCandidatePoolSize: function () {
        // Detect network connection type
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

        // Default value
        let poolSize = 10;
        let rtt = 0;
        let saveData = false;
        let networkType = 'unknown';

        if (connection) {
            // Get more network properties
            networkType = connection.effectiveType || 'unknown';
            rtt = connection.rtt || 0;
            saveData = connection.saveData || false;

            // Adjust based on network type
            switch (networkType) {
                case '5g':
                case '4g':
                    // Ultra-high-speed network, maximum candidate pool
                    poolSize = 20;
                    break;
                case '3g':
                    // Medium network, default candidate pool
                    poolSize = 10;
                    break;
                case '2g':
                    // Low-speed network, smaller candidate pool
                    poolSize = 5;
                    break;
                default:
                    // Unknown network type, use default value
                    poolSize = 10;
            }

            // Further adjust based on downlink speed
            if (connection.downlink) {
                if (connection.downlink < 0.5) {
                    // Ultra-low-speed network, minimum candidate pool
                    poolSize = Math.max(3, poolSize - 4);
                } else if (connection.downlink > 10) {
                    // Ultra-high-speed network, increase candidate pool size
                    poolSize = Math.min(25, poolSize + 5);
                } else if (connection.downlink > 5) {
                    // High-speed network, moderately increase candidate pool size
                    poolSize = Math.min(20, poolSize + 3);
                }
            }

            // Adjust based on RTT
            if (rtt > 300) {
                // High-latency network, reduce candidate pool size
                poolSize = Math.max(5, poolSize - 2);
            } else if (rtt < 100) {
                // Low-latency network, increase candidate pool size
                poolSize = Math.min(20, poolSize + 2);
            }

            // If data saver mode is enabled, reduce candidate pool size
            if (saveData) {
                poolSize = Math.max(3, Math.floor(poolSize * 0.7));
            }
        }

        window.log(`📊 ICE candidate pool size: ${poolSize}`);
        return poolSize;
    },

    // ICE candidate priority sorting
    getIceCandidatePriority: function (candidate) {
        // Assign base priority based on candidate type
        let priority = 0;

        if (candidate.candidate) {
            const candidateStr = candidate.candidate;

            if (candidateStr.includes('typ host')) {
                // Host candidate, highest priority
                priority = 100;
            } else if (candidateStr.includes('typ srflx')) {
            // Server reflexive candidate, highest priority
            priority = 200;
        } else if (candidateStr.includes('typ relay')) {
                // Relay candidate, lower priority
                priority = 50;
            } else if (candidateStr.includes('typ prflx')) {
                // Peer-reflexive candidate, lowest priority
                priority = 25;
            }

            // Adjust priority based on transport protocol
            if (candidateStr.includes('udp')) {
                // UDP takes priority over TCP
                priority += 10;
            }

            // Adjust priority based on network type
            const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (connection && connection.effectiveType) {
                const type = connection.effectiveType;
                if (type === '5g' || type === '4g') {
                    priority += 5;
                } else if (type === '2g') {
                    priority -= 5;
                }
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
                // Use candidate string as unique identifier
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
    filterHighPriorityIceCandidates: async function (candidates) {
        if (!candidates || candidates.length === 0) return [];

        const normalizeCandidate = (candidate) => {
            if (!candidate) return null;
            if (typeof candidate === 'string') return { candidate };
            if (typeof candidate.toJSON === 'function') {
                try {
                    const json = candidate.toJSON();
                    if (json && typeof json === 'object') return json;
                } catch (_) { }
            }
            const plain = {};
            const keys = [
                'candidate',
                'sdpMid',
                'sdpMLineIndex',
                'usernameFragment',
                'foundation',
                'component',
                'protocol',
                'address',
                'port',
                'priority',
                'type',
                'relatedAddress',
                'relatedPort',
                'tcpType'
            ];
            for (const key of keys) {
                if (candidate[key] !== undefined) plain[key] = candidate[key];
            }
            return plain.candidate ? plain : null;
        };

        const normalizedCandidates = candidates
            .map(normalizeCandidate)
            .filter(Boolean);

        // Check if Worker is ready
        const worker = window.workerManager?.getWorker('webRTCWorker');
        if (worker) {
            try {
                const taskId = 'filter_ice_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                const networkInfo = navigator.connection ? {
                    effectiveType: navigator.connection.effectiveType,
                    downlink: navigator.connection.downlink
                } : null;

                const filtered = await new Promise((resolve, reject) => {
                    // Reduce timeout to 500ms for faster fallback
                    const timeout = setTimeout(() => {
                        worker.removeEventListener('message', handleResult);
                        reject(new Error('ICE Filter Worker timeout'));
                    }, 500);

                    function handleResult(e) {
                        if (e.data.type === 'FILTER_ICE_CANDIDATES_RESPONSE' && e.data.taskId === taskId) {
                            clearTimeout(timeout);
                            worker.removeEventListener('message', handleResult);
                            resolve(e.data.candidates);
                        }
                    }

                    worker.addEventListener('message', handleResult);
                    worker.postMessage({
                        type: 'FILTER_ICE_CANDIDATES',
                        taskId: taskId,
                        data: { candidates: normalizedCandidates, networkInfo }
                    });
                });

                if (filtered && Array.isArray(filtered)) {
                    if (filtered.length < normalizedCandidates.length) {
                        window.log(`📋 [Worker] ICE candidate filtering: ${normalizedCandidates.length} → ${filtered.length}`);
                    }
                    return filtered;
                }
            } catch (error) {
                console.warn('WebRTC Worker filtering failed, falling back to main thread:', error);
            }
        }

        // Optimized fallback: use requestIdleCallback for async processing to avoid blocking the main thread
        return new Promise((resolve) => {
            const performFiltering = () => {
                // Deduplicate
                const uniqueCandidates = this.deduplicateIceCandidates(normalizedCandidates);

                // Sort by priority
                const sortedCandidates = uniqueCandidates.sort((a, b) => {
                    return this.getIceCandidatePriority(b) - this.getIceCandidatePriority(a);
                });

                // Keep only top N high-priority candidates (adjust based on network conditions)
                const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
                let maxCandidates = 15;

                if (connection) {
                    if (connection.effectiveType === '2g' || connection.downlink < 1) {
                        maxCandidates = 8;
                    } else if (connection.effectiveType === '3g' || connection.downlink < 5) {
                        maxCandidates = 12;
                    }
                }

                const filteredCandidates = sortedCandidates.slice(0, maxCandidates);

                if (filteredCandidates.length < sortedCandidates.length) {
                    window.log(`📋 [Fallback] ICE candidate filtering: ${sortedCandidates.length} → ${filteredCandidates.length}`);
                }

                resolve(filteredCandidates);
            };

            // Try requestIdleCallback; fall back to setTimeout if unavailable
            if ('requestIdleCallback' in window) {
                requestIdleCallback(performFiltering, { timeout: 100 });
            } else {
                // Fall back to setTimeout, delaying execution to avoid blocking
                setTimeout(performFiltering, 0);
            }
        });
    },

    // Polite/Impolite Peer pattern for handling glare
    resolveRole: function (myEmail, targetEmail) {
        myEmail = typeof myEmail === 'string' ? myEmail.trim() : '';
        targetEmail = typeof targetEmail === 'string' ? targetEmail.trim() : '';
        const valid = !!myEmail && !!targetEmail;
        if (!valid) {
            return {
                myEmail,
                targetEmail,
                polite: true,
                role: 'unknown',
                valid: false,
                reason: 'Email information incomplete'
            };
        }

        if (myEmail === targetEmail) {
            return {
                myEmail,
                targetEmail,
                polite: false,
                role: 'same',
                valid: true,
                reason: 'Same email'
            };
        }

        const polite = myEmail > targetEmail;
        const role = myEmail < targetEmail ? 'sender' : 'receiver';
        return {
            myEmail,
            targetEmail,
            polite,
            role,
            valid: true,
            reason: ''
        };
    },

    isPolite: function (myEmail, targetEmail) {
        return this.resolveRole(myEmail, targetEmail).polite;
    },

    // Add all ICE candidates in parallel
    addIceCandidates: async function (pc, candidates) {
        window.log('🔄 Starting addIceCandidates function, adding ICE candidates');

        if (!candidates || !Array.isArray(candidates) || candidates.length === 0) {
            window.log('📋 No ICE candidates to add');
            return;
        }

        window.log(`📋 Total ICE candidates received: ${candidates.length}`);

        // Filter high-priority candidates first
        const filteredCandidates = await this.filterHighPriorityIceCandidates(candidates);
        window.log(`📋 ICE candidates retained after filtering: ${filteredCandidates.length}`);

        // Write detailed logs, recording each candidate's type and protocol
        filteredCandidates.forEach((candidate, index) => {
            const candidateType = candidate.candidate.includes('typ host') ? 'host' :
                candidate.candidate.includes('typ srflx') ? 'srflx' :
                    candidate.candidate.includes('typ relay') ? 'relay' :
                        candidate.candidate.includes('typ prflx') ? 'prflx' : 'unknown';
            const protocol = candidate.candidate.includes('udp') ? 'UDP' : 'TCP';

            window.log(`📋 ICE candidate ${index + 1}: type=${candidateType}, protocol=${protocol}`);
        });

        const results = await Promise.allSettled(
            filteredCandidates.map(candidate => {
                return pc.addIceCandidate(new RTCIceCandidate(candidate));
            })
        );

        const successCount = results.filter(r => r.status === 'fulfilled').length;
        window.log(`✅ ICE candidate addition complete: ${successCount}/${filteredCandidates.length} succeeded`);

        // Log failed candidate info
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                const candidate = filteredCandidates[index];
                const candidateType = candidate.candidate.includes('typ host') ? 'host' :
                    candidate.candidate.includes('typ srflx') ? 'srflx' :
                        candidate.candidate.includes('typ relay') ? 'relay' : 'prflx';

                window.log(`❌ ICE candidate ${index + 1} (type=${candidateType}) failed to add: ${result.reason}`);
            }
        });
    }
};

// DOM manipulation functions
window.utils.dom = {
    // HTML sanitization function to prevent XSS attacks
    sanitizeHtml: function (html) {
        // Allow only basic formatting tags such as line breaks, bold, italic, etc.
        const allowedTags = /<br\s*\/?>|<b>|<\/b>|<i>|<\/i>|<strong>|<\/strong>|<em>|<\/em>/i;
        // Remove all other tags
        return html.replace(/<[^>]*>/g, (tag) => {
            return allowedTags.test(tag) ? tag : '';
        });
    },

    // Convert plain text to HTML format
    textToHtml: function (text) {
        // Escape text first to prevent XSS attacks
        let html = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

        // Handle all types of line breaks: \r\n, \r, \n
        // Convert \r\n to \n first
        html = html.replace(/\r\n/g, '\n');
        // Then convert standalone \r to \n
        html = html.replace(/\r/g, '\n');
        // Finally convert \n to <br> tags

        html = html.replace(/\n/g, '<br>');

        return html;
    }
};

// Retry mechanism functions
window.utils.retry = {
    // Generic retry function
    withRetry: async function (fn, options = {}) {
        const { maxRetries = 3, delay = 1000, shouldRetry } = options;
        let retries = 0;

        while (retries <= maxRetries) {
            try {
                return await fn(retries);
            } catch (error) {
                retries++;
                if (retries > maxRetries) {
                    throw error;
                }

                // Custom retry condition
                if (shouldRetry && !shouldRetry(error)) {
                    throw error;
                }

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    },

    // Send message to webcom with retry mechanism
    sendMessageToWebcomWithRetry: function (webcom, message, options = {}) {
        const {
            interval = 500,
            maxRetryTime = 5000,
            messageType = 'WEBRTC_SIGNAL',
            logPrefix = '📤'
        } = options;

        // Define send message function
        const sendMessage = () => {
            if (webcom && webcom.contentWindow) {
                console.log(`${logPrefix} Sending ${messageType} message, data:`, message);
                try {
                    webcom.contentWindow.postMessage(message, '*');
                    console.log(`${logPrefix} ${messageType} message sent`);
                    return true;
                } catch (error) {
                    console.error(`${logPrefix} Failed to send ${messageType} message:`, error);
                    console.log(`${logPrefix} Checking webcom@: readyState=${webcom.readyState}, contentWindow=${webcom.contentWindow ? 'available' : 'unavailable'}`);
                    return false;
                }
            } else if (webcom && typeof webcom.postMessage === 'function') {
                // Support for Custom Elements (MailinkChat)
                console.log(`${logPrefix} Sending ${messageType} message (CustomElement), data:`, message);
                try {
                    webcom.postMessage(message);
                    console.log(`${logPrefix} ${messageType} message sent (CustomElement)`);
                    return true;
                } catch (error) {
                    console.error(`${logPrefix} Failed to send ${messageType} message (CustomElement):`, error);
                    return false;
                }
            } else {
                console.error(`${logPrefix} Cannot send message: chat webcom or contentWindow does not exist`);
                return false;
            }
        };

        // Use setInterval to send messages periodically until webcom loads or max retry time is reached
        const intervalId = setInterval(() => {
            if (webcom.contentWindow || typeof webcom.postMessage === 'function') {
                console.log(`${logPrefix} Chat webcom is ready, sending ${messageType} message`);
                if (sendMessage()) {
                    clearInterval(intervalId);
                }
            } else {
                console.log(`${logPrefix} Chat webcom is not ready yet, attempting to send message`);
                // Try sending even if not ready (previous logic did this, or should we wait?)
                // Original logic was sendMessage(); keep retrying on failure
                // But the original sendMessage logs errors
                sendMessage();
            }
        }, interval);

        // Set max retry time to prevent infinite loop
        setTimeout(() => {
            clearInterval(intervalId);
            console.log(`${logPrefix} Max retry time reached (${maxRetryTime}ms), stopping ${messageType} message sending`);
        }, maxRetryTime);

        // Add onload event listener to ensure messages are sent again after webcom loads
        webcom.onload = function () {
            console.log(`${logPrefix} Chat webcom loaded, resending ${messageType} message to ensure delivery`);
            sendMessage();
            clearInterval(intervalId);
        };
    },

    // Ensure window.sendemail function is available
    ensureSendEmailAvailable: function () {
        // Check if window.sendemail is available
        if (typeof window.sendemail !== 'function') {
            window.log('⚠️ window.sendemail function is unavailable, retrying in 1 second');
            // Keep retrying until sendemail function is available
            setTimeout(this.ensureSendEmailAvailable.bind(this), 1000);
        } else {
            window.log('✅ window.sendemail function is available');
        }
    },

    // Email deletion function with retry mechanism
    deleteEmailWithRetry: async function (config, sender, subjectPrefix, options, maxRetries = 3) {
        let retries = 0;
        let lastError = null;

        while (retries < maxRetries) {
            try {
                console.log(`Attempting to delete email (attempt ${retries + 1}/${maxRetries}): ${sender} - ${subjectPrefix}`);
                const result = await window.electronAPI.searchAndDeleteEmails(config, sender, subjectPrefix, options);
                console.log(`Deletion successful (attempt ${retries + 1}/${maxRetries}): ${sender} - ${subjectPrefix}`);
                return result;
            } catch (error) {
                retries++;
                lastError = error;
                console.error(`Deletion failed (attempt ${retries}/${maxRetries}): ${sender} - ${subjectPrefix}`, error);

                // Wait 1 second before retrying if not the last attempt
                if (retries < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
        }

        // Throw the last error after exceeding max retries
        console.error(`Deletion failed (max retries ${maxRetries} reached): ${sender} - ${subjectPrefix}`);
        throw lastError;
    }
};
