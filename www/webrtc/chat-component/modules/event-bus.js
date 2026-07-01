
// EventBus module - event bus for inter-module communication
export class EventBus {
  constructor() {
    this.events = new Map();
  }

  // Subscribe to event
  on(eventName, callback) {
    if (!this.events.has(eventName)) {
      this.events.set(eventName, []);
    }
    this.events.get(eventName).push(callback);
  }

  // Unsubscribe from event
  off(eventName, callback) {
    if (this.events.has(eventName)) {
      const callbacks = this.events.get(eventName);
      if (callback) {
        this.events.set(eventName, callbacks.filter(cb => cb !== callback));
      } else {
        this.events.delete(eventName);
      }
    }
  }

  // Publish event
  emit(eventName, ...args) {
    if (this.events.has(eventName)) {
      this.events.get(eventName).forEach(callback => {
        try {
          callback(...args);
        } catch (error) {
          console.error(`Event ${eventName} callback error:`, error);
        }
      });
    }
  }
}
