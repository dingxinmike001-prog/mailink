/**
 * Math utility functions
 */

/**
 * Clamp value to the specified range
 * @param {number} val - value to clamp
 * @param {number} min - minimum value (default 50)
 * @param {number} max - maximum value (default 200)
 * @returns {number} clamped value
 */
export const getColorFromHash = (hash, index) => {
    const r = (hash >> (index * 8)) & 0xFF;
    const g = (hash >> ((index + 1) * 8)) & 0xFF;
    const b = (hash >> ((index + 2) * 8)) & 0xFF;

    const normalize = (val) => Math.min(Math.max(val, 50), 200);
    return `rgb(${normalize(r)}, ${normalize(g)}, ${normalize(b)})`;
};
