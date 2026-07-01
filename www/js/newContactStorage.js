/**
 * New contact avatar sync storage module
 * Manages persistence of new contact markers and send confirmation
 * 
 * Problems solved:
 * 1. Page refresh causes _newContactMap loss
 * 2. Email send failed but marker was already cleared
 * 3. Race conditions causing avatar not sent
 * 4. Sync issues when contacts are added from multiple endpoints
 */

const NEW_CONTACT_STORAGE_KEY = 'mailink_new_contact_avatar_pending';
const AVATAR_SYNC_EXPIRY_MS = 5 * 60 * 1000; // 5-minute expiration time

/**
 * Get all new contacts with pending avatar sends
 * @returns {Object} Format: { email: { timestamp, retryCount, source }, ... }
 */
function getPendingAvatarContacts() {
    try {
        const data = localStorage.getItem(NEW_CONTACT_STORAGE_KEY);
        if (!data) return {};
        
        const contacts = JSON.parse(data);
        const now = Date.now();
        const validContacts = {};
        
        // Clean expired entries
        for (const [email, info] of Object.entries(contacts)) {
            if (now - info.timestamp < AVATAR_SYNC_EXPIRY_MS) {
                validContacts[email] = info;
            } else {
                console.log(`[NewContactStorage] Clean up expired new contact marks: ${email}`);
            }
        }
        
        // Update storage if any cleanup occurred
        if (Object.keys(validContacts).length !== Object.keys(contacts).length) {
            localStorage.setItem(NEW_CONTACT_STORAGE_KEY, JSON.stringify(validContacts));
        }
        
        return validContacts;
    } catch (error) {
        console.error('[NewContactStorage] Failed to read contacts pending avatar send:', error);
        return {};
    }
}

/**
 * Mark as new contact (avatar needs to be sent)
 * @param {string} email - Contact email
 * @param {string} source - Marker source, for debugging
 * @returns {boolean} Whether marking succeeded
 */
function markAsNewContact(email, source = 'unknown') {
    if (!email || typeof email !== 'string') {
        console.warn('[NewContactStorage] Invalid email address:', email);
        return false;
    }
    
    try {
        const contacts = getPendingAvatarContacts();
        const normalizedEmail = email.toLowerCase().trim();
        
        // If already marked, update info instead of overwriting
        if (contacts[normalizedEmail]) {
            console.log(`[NewContactStorage] Update existing new contact mark: ${normalizedEmail}`);
            contacts[normalizedEmail].timestamp = Date.now();
            contacts[normalizedEmail].source = source;
            // Do not reset retryCount，Keep previous retry count
        } else {
            console.log(`[NewContactStorage] Mark as new contact: ${normalizedEmail}, Source: ${source}`);
            contacts[normalizedEmail] = {
                timestamp: Date.now(),
                retryCount: 0,
                source: source
            };
        }
        
        localStorage.setItem(NEW_CONTACT_STORAGE_KEY, JSON.stringify(contacts));
        
        // Also update the in-memory Map (backward compatible)
        if (!window._newContactMap) {
            window._newContactMap = new Map();
        }
        window._newContactMap.set(normalizedEmail, true);
        
        return true;
    } catch (error) {
        console.error('[NewContactStorage] Failed to mark new contact:', error);
        return false;
    }
}

/**
 * Check if it is a new contact (avatar needs to be sent)
 * @param {string} email - Contact email
 * @returns {boolean} Whether avatar needs to be sent
 */
function isNewContact(email) {
    if (!email || typeof email !== 'string') return false;
    
    const normalizedEmail = email.toLowerCase().trim();
    
    // Check persistent storage first
    const contacts = getPendingAvatarContacts();
    if (contacts[normalizedEmail]) {
        return true;
    }
    
    // Backward compatible: check the in-memory Map
    if (window._newContactMap && window._newContactMap.has(normalizedEmail)) {
        // Sync to persistent storage
        const source = 'memory_fallback';
        markAsNewContact(normalizedEmail, source);
        return true;
    }
    
    return false;
}

/**
 * Confirm avatar was sent successfully
 * @param {string} email - Contact email
 * @param {boolean} success - Whether send succeeded
 * @returns {boolean} Whether processing succeeded
 */
function confirmAvatarSent(email, success = true) {
    if (!email || typeof email !== 'string') return false;
    
    const normalizedEmail = email.toLowerCase().trim();
    
    try {
        const contacts = getPendingAvatarContacts();
        
        if (!contacts[normalizedEmail]) {
            console.log(`[NewContactStorage] Contact no longer in pending send list: ${normalizedEmail}`);
            // Also clear in-memory markers
            if (window._newContactMap) {
                window._newContactMap.delete(normalizedEmail);
            }
            return true;
        }
        
        if (success) {
            // Send succeeded, remove marker
            console.log(`[NewContactStorage] Avatar sent successfully，remove mark: ${normalizedEmail}`);
            delete contacts[normalizedEmail];
            
            // Also clear in-memory markers
            if (window._newContactMap) {
                window._newContactMap.delete(normalizedEmail);
            }
        } else {
            // Send failed, increment retry count
            contacts[normalizedEmail].retryCount++;
            contacts[normalizedEmail].lastError = Date.now();
            
            console.log(`[NewContactStorage] Avatar send failed，Retry count: ${contacts[normalizedEmail].retryCount}, ${normalizedEmail}`);
            
            // If retry count is too high, give up sending
            if (contacts[normalizedEmail].retryCount >= 3) {
                console.warn(`[NewContactStorage] Too many avatar send retries，Give up sending: ${normalizedEmail}`);
                delete contacts[normalizedEmail];
            }
        }
        
        localStorage.setItem(NEW_CONTACT_STORAGE_KEY, JSON.stringify(contacts));
        return true;
    } catch (error) {
        console.error('[NewContactStorage] failed to confirm avatar send status:', error);
        return false;
    }
}

/**
 * Get retry count for a new contact
 * @param {string} email - Contact email
 * @returns {number} Retry count
 */
function getRetryCount(email) {
    if (!email || typeof email !== 'string') return 0;
    
    const normalizedEmail = email.toLowerCase().trim();
    const contacts = getPendingAvatarContacts();
    
    return contacts[normalizedEmail]?.retryCount || 0;
}

/**
 * Clear all new contact markers (for debugging or reset)
 */
function clearAllNewContactMarks() {
    try {
        localStorage.removeItem(NEW_CONTACT_STORAGE_KEY);
        if (window._newContactMap) {
            window._newContactMap.clear();
        }
        console.log('[NewContactStorage] All new contact marks cleaned');
    } catch (error) {
        console.error('[NewContactStorage] Failed to clean marks:', error);
    }
}

/**
 * Get count of contacts with pending avatar sends
 * @returns {number} Pending count
 */
function getPendingCount() {
    const contacts = getPendingAvatarContacts();
    return Object.keys(contacts).length;
}

/**
 * Print current state (for debugging)
 */
function debugStatus() {
    const contacts = getPendingAvatarContacts();
    const memoryCount = window._newContactMap ? window._newContactMap.size : 0;
    
    console.log('[NewContactStorage] Debug info:');
    console.log('  - Persistently stored contacts:', Object.keys(contacts));
    console.log('  - Memory Map Contacts:', window._newContactMap ? Array.from(window._newContactMap.keys()) : []);
    console.log('  - Persisted count:', Object.keys(contacts).length);
    console.log('  - Memory count:', memoryCount);
    
    return {
        persistent: contacts,
        memory: window._newContactMap ? Array.from(window._newContactMap.entries()) : [],
        pendingCount: Object.keys(contacts).length,
        memoryCount: memoryCount
    };
}

// Export to global
window.newContactStorage = {
    markAsNewContact,
    isNewContact,
    confirmAvatarSent,
    getRetryCount,
    clearAllNewContactMarks,
    getPendingCount,
    debugStatus,
    getPendingAvatarContacts
};

console.log('[NewContactStorage] Module loaded');
