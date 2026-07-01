/**
 * Animation utility module
 * Uses the Web Animations API for "fade opacity + shrink/grow toward top-left over 0.5s"
 * No CSS injection required; compatible with Shadow DOM and Light DOM
 */

/**
 * Play the close animation (fade opacity + shrink toward top-left over 0.5s)
 * @param {HTMLElement} overlayEl - overlay/panel container element
 * @param {string} [modalSelector] - modal body selector (modal inside overlay)
 * @returns {Promise} resolves when the animation ends
 */
export function playCloseAnimation(overlayEl, modalSelector = null) {
    return _playAnimation(overlayEl, modalSelector, 'close');
}

/**
 * Play the open animation (grow from top-left + fade in over 0.5s, reverse of close)
 * @param {HTMLElement} overlayEl - overlay/panel container element
 * @param {string} [modalSelector] - modal body selector (modal inside overlay)
 * @returns {Promise} resolves when the animation ends
 */
export function playOpenAnimation(overlayEl, modalSelector = null) {
    return _playAnimation(overlayEl, modalSelector, 'open');
}

/**
 * Internal: unified open/close animation player
 * Close: opacity 1→0, scale(1)→0.3 + top-left offset, ease-in
 * Open: opacity 0→1, scale(0.3)+top-left offset → scale(1), ease-out
 */
function _playAnimation(overlayEl, modalSelector, direction) {
    if (!overlayEl) return Promise.resolve();

    const isClose = direction === 'close';
    const duration = 500;
    const easing = isClose ? 'ease-in' : 'ease-out';

    // Block interaction during the animation
    if (isClose) {
        overlayEl.style.pointerEvents = 'none';
    } else {
        // Also block interaction during open to prevent accidental clicks during the animation
        overlayEl.style.pointerEvents = 'none';
    }

    const animations = [];

    // Keyframe definitions (close and open are reverse of each other)
    const overlayKF = isClose
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ opacity: 0 }, { opacity: 1 }];

    const modalKF = isClose
        ? [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.3) translate(-30%, -30%)' }]
        : [{ opacity: 0, transform: 'scale(0.3) translate(-30%, -30%)' }, { opacity: 1, transform: 'scale(1)' }];

    // 1. Overlay/container: fade
    animations.push(overlayEl.animate(overlayKF, { duration, easing, fill: 'forwards' }));

    // 2. Modal body: scale + translate
    let targetEl = null;
    let needTransformOriginReset = false;

    if (modalSelector && overlayEl.shadowRoot) {
        targetEl = overlayEl.shadowRoot.querySelector(modalSelector);
    } else if (modalSelector) {
        targetEl = overlayEl.querySelector(modalSelector);
    }

    if (targetEl) {
        targetEl.style.transformOrigin = 'top left';
        animations.push(targetEl.animate(modalKF, { duration, easing, fill: 'forwards' }));
    } else if (!modalSelector) {
        // The element itself is the panel (e.g., inbox-panel); scale it directly
        needTransformOriginReset = true;
        overlayEl.style.transformOrigin = 'top left';
        animations.push(overlayEl.animate(modalKF, { duration, easing, fill: 'forwards' }));
    }

    return Promise.all(animations.map(a => a.finished)).then(() => {
        // Cancel all animations → element returns to CSS control
        animations.forEach(a => a.cancel());

        // Clean up temporary inline styles
        overlayEl.style.pointerEvents = '';
        if (needTransformOriginReset || !targetEl) {
            overlayEl.style.transformOrigin = '';
        }
    });
}

/**
 * This module no longer needs CSS injection (uses Web Animations API)
 * Keep this function as a no-op for compatibility with existing imports
 */
export function injectCloseAnimationStyles() {
    // no-op: uses Web Animations API, no need to inject CSS
}
