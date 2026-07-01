import { getUtilsRoot } from './root.js';
import { avatarCache } from './avatar-cache.js';

function generateAvatarLocalFallback(email) {
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
    const getRandomColor = () => {
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
}

export function generateAvatarLocal(email) {
    const root = getUtilsRoot();
    const api = root?.avatar;
    const impl = api?.generateAvatarLocal;
    if (typeof impl === 'function') return impl.call(api, email);
    return generateAvatarLocalFallback(email);
}

export async function generateAvatar(email) {
    const root = getUtilsRoot();
    const api = root?.avatar;
    const impl = api?.generateAvatar;
    if (typeof impl === 'function') return await impl.call(api, email);
    return generateAvatarLocalFallback(email);
}
