/**
 * Color utility functions
 */

/**
 * Generate random color
 * avoid overly bright, dark, or grayish colors
 * @returns {string} RGB color string, such as "rgb(123, 45, 67)"
 */
export const getRandomColor = () => {
    let r, g, b;
    do {
        r = Math.floor(Math.random() * 256);
        g = Math.floor(Math.random() * 256);
        b = Math.floor(Math.random() * 256);
    } while (
        (r > 220 && g > 220 && b > 220) ||
        (r < 30 && g < 30 && b < 30) ||
        (Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && Math.abs(b - r) < 10)
    );
    return `rgb(${r}, ${g}, ${b})`;
};
