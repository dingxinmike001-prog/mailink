/**
 * Notification audio player module
 * Supports playing alert sounds and tray flashing
 */

/**
 * Play notification sound
 * Uses synthesized audio for broad compatibility
 * @param {number} frequency - frequency in Hz, default 800
 * @param {number} duration - duration in ms, default 500
 */
export function playNotificationBeep(frequency = 800, duration = 500) {
  try {
    // Use the Web Audio API in the renderer process
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Create oscillator (generate sound wave)
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    // Connect graph
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    // Set parameters
    oscillator.frequency.value = frequency;  // Set frequency
    oscillator.type = 'sine';  // Sine wave
    
    // Set volume (two stages: attack and release)
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);  // Initial volume
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration / 1000);  // Gradually decay
    
    // Start playback
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration / 1000);
    
    return true;
  } catch (error) {
    console.error('Failed to play notification sound:', error);
    return false;
  }
}

/**
 * Play a simple two-tone alert (more business-like)
 * High tone (1200Hz) -> low tone (800Hz), 150ms each
 */
export function playDoubleTone() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // First tone (high)
    const osc1 = audioContext.createOscillator();
    const gain1 = audioContext.createGain();
    osc1.connect(gain1);
    gain1.connect(audioContext.destination);
    osc1.frequency.value = 1200;
    osc1.type = 'sine';
    gain1.gain.setValueAtTime(0.2, audioContext.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
    osc1.start(audioContext.currentTime);
    osc1.stop(audioContext.currentTime + 0.15);
    
    // Second tone (low)
    const osc2 = audioContext.createOscillator();
    const gain2 = audioContext.createGain();
    osc2.connect(gain2);
    gain2.connect(audioContext.destination);
    osc2.frequency.value = 800;
    osc2.type = 'sine';
    gain2.gain.setValueAtTime(0.2, audioContext.currentTime + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.30);
    osc2.start(audioContext.currentTime + 0.15);
    osc2.stop(audioContext.currentTime + 0.30);
    
    return true;
  } catch (error) {
    console.error('Failed to play dual-tone alert:', error);
    return false;
  }
}

/**
 * Play audio file if available
 * @param {string} audioPath - audio file path
 */
export function playAudioFile(audioPath) {
  try {
    const audio = new Audio(audioPath);
    audio.volume = 0.5;
    audio.play().catch(err => {
      console.warn('Failed to play audio file，Using synthesized sound:', err);
      playDoubleTone();  // Fall back to synthesized sound
    });
    return true;
  } catch (error) {
    console.error('createAudioObject failed:', error);
    return false;
  }
}
