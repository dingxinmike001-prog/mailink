/**
 * Avatar LRU cache module
 * Provides LRU cache for avatars with TTL expiration
 */

const AVATAR_CACHE_MAX = 100;
const AVATAR_CACHE_TTL = 1 * 60 * 1000;

class AvatarCache {
  constructor(options = {}) {
    this.max = options.max || AVATAR_CACHE_MAX;
    this.ttl = options.ttl || AVATAR_CACHE_TTL;
    this.cache = new Map();
    this.timestamps = new Map();
  }

  normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  get(email) {
    const normalizedEmail = this.normalizeEmail(email);
    
    if (!this.cache.has(normalizedEmail)) {
      return null;
    }

    const timestamp = this.timestamps.get(normalizedEmail);
    if (timestamp && Date.now() - timestamp > this.ttl) {
      this.cache.delete(normalizedEmail);
      this.timestamps.delete(normalizedEmail);
      return null;
    }

    if (this.options?.updateAgeOnGet !== false) {
      this.timestamps.set(normalizedEmail, Date.now());
    }

    return this.cache.get(normalizedEmail);
  }

  set(email, avatar) {
    const normalizedEmail = this.normalizeEmail(email);
    
    if (this.cache.size >= this.max) {
      const oldestKey = this.findOldest();
      if (oldestKey) {
        this.cache.delete(oldestKey);
        this.timestamps.delete(oldestKey);
      }
    }

    this.cache.set(normalizedEmail, avatar);
    this.timestamps.set(normalizedEmail, Date.now());
  }

  has(email) {
    const normalizedEmail = this.normalizeEmail(email);
    
    if (!this.cache.has(normalizedEmail)) {
      return false;
    }

    const timestamp = this.timestamps.get(normalizedEmail);
    if (timestamp && Date.now() - timestamp > this.ttl) {
      this.cache.delete(normalizedEmail);
      this.timestamps.delete(normalizedEmail);
      return false;
    }

    return true;
  }

  delete(email) {
    const normalizedEmail = this.normalizeEmail(email);
    this.cache.delete(normalizedEmail);
    this.timestamps.delete(normalizedEmail);
  }

  clear() {
    this.cache.clear();
    this.timestamps.clear();
  }

  findOldest() {
    let oldestKey = null;
    let oldestTimestamp = Infinity;

    for (const [key, timestamp] of this.timestamps) {
      if (timestamp < oldestTimestamp) {
        oldestTimestamp = timestamp;
        oldestKey = key;
      }
    }

    return oldestKey;
  }

  getStats() {
    return {
      size: this.cache.size,
      max: this.max,
      hitRate: this.hitCount / (this.hitCount + this.missCount) * 100 || 0,
      hitCount: this.hitCount || 0,
      missCount: this.missCount || 0
    };
  }

  hitCount = 0;
  missCount = 0;
  options = {};
}

const avatarCache = new AvatarCache({
  max: AVATAR_CACHE_MAX,
  ttl: AVATAR_CACHE_TTL,
  updateAgeOnGet: true
});

export { AvatarCache, avatarCache };
