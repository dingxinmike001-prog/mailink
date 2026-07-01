/**
 * File security validation - shared constants and pure logic
 *
 * this module contains platform-independent constants and pure logic functions,
 * shared by browser-side and Node.js-side adapter layers.
 *
 * Principles:
 * - constants are uniformly defined here, eliminate duplication and inconsistency across both ends
 * - pure logic functions do not directly operate on Buffer / Uint8Array,
 *   instead abstract byte reading via the readBytes callback
 */

// ────────────────────────────────────────────
// Constants (unified source, shared by both ends)
// ────────────────────────────────────────────

/**
 * List of Windows file extensions executable immediately
 * includes executables and scripts runnable by double-click
 */
const DANGEROUS_EXTENSIONS = new Set([
  // Windows executables (run directly on double-click)
  'exe', 'dll', 'com', 'scr', 'msi',
  // Windows script files (can execute immediately)
  'bat', 'cmd', 'ps1', 'vbs', 'js', 'jse', 'vbe', 'wsf', 'wsh', 'hta',
  // Microsoft Management Console file
  'msc',
  // Other script files
  'py', 'pyc', 'pyo', 'sh', 'bash', 'zsh', 'pl', 'rb', 'php'
  // Note: archives and their contents are all allowed
]);

/**
 * High-risk MIME types
 * includes MIME types for executables and scripts
 */
const DANGEROUS_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-exe',
  'application/exe',
  'application/x-winexe',
  'application/x-dosexec',
  'application/x-executable',
  'application/x-msi',
  // Script file MIME types
  'application/x-bat',
  'application/x-cmd',
  'application/x-sh',
  'application/x-powershell',
  'text/x-powershell',
  'text/vbscript',
  'application/x-vbscript',
  'application/javascript',
  'text/javascript',
  'application/x-python',
  'text/x-python',
  'application/x-perl',
  'application/x-ruby',
  'application/x-php'
  // Note: application/octet-stream removed because too many legitimate files use this type
]);

/**
 * Windows executable file magic numbers(Magic Number)
 * only retain true executable file formats
 *
 * uniformly use hexadecimal string format "4D5A"
 * (browser and Node can easily compare with bytes)
 */
const EXECUTABLE_MAGIC_NUMBERS = [
  { magic: '4D5A', name: 'DOS/Windows executable' },        // MZ - PE file
  // Note: ZIP format (504B0304) removed because Office files such as xlsx/pptx/docx are all ZIP-based
  // Note: ELF, Java, Mach-O, etc. removed; only Windows executables are blocked
];

/**
 * Windows PATHEXT executable extension list
 * contains executable and script files
 */
const PATHEXT_EXECUTABLES = new Set([
  '.EXE', '.COM', '.SCR', '.MSI',  // Executable file
  '.BAT', '.CMD', '.PS1', '.VBS', '.JS', '.JSE', '.VBE', '.WSF', '.WSH', '.HTA',  // Script file
  '.MSC'  // Microsoft Management Console file
]);

// ────────────────────────────────────────────
// Pure logic functions
// ────────────────────────────────────────────

/**
 * Get file extension(pure string operation, not dependent on the path module)
 * @param {string} filename - file name
 * @returns {string|null} extension (lowercase)
 */
function getFileExtension(filename) {
  if (!filename || typeof filename !== 'string') {
    return null;
  }

  const parts = filename.split('.');
  if (parts.length < 2) return null;

  return parts.pop().toLowerCase().trim() || null;
}

/**
 * Check whether file extension is dangerous
 * @param {string} filename - file name
 * @returns {boolean} whether dangerous
 */
function isDangerousExtension(filename) {
  if (!filename || typeof filename !== 'string') {
    return false;
  }

  const ext = getFileExtension(filename);
  if (!ext) return false;

  return DANGEROUS_EXTENSIONS.has(ext);
}

/**
 * Check file extension using Windows PATHEXT list
 * @param {string} filename - file name
 * @returns {boolean} whether executable
 */
function isExecutableByPathExt(filename) {
  if (!filename || typeof filename !== 'string') {
    return false;
  }

  const parts = filename.split('.');
  if (parts.length < 2) return false;

  const fileExt = '.' + parts.pop().toUpperCase().trim();

  return PATHEXT_EXECUTABLES.has(fileExt);
}

/**
 * Check whether MIME type is dangerous
 * @param {string} mimeType - MIME type
 * @param {string} filename - file name(used for auxiliary judgment)
 * @returns {boolean} whether dangerous
 */
function isDangerousMimeType(mimeType, filename = '') {
  if (!mimeType || typeof mimeType !== 'string') {
    return isDangerousExtension(filename);
  }

  const normalizedMime = mimeType.toLowerCase().trim();

  if (DANGEROUS_MIME_TYPES.has(normalizedMime)) {
    return true;
  }

  return false;
}

/**
 * Check file content magic number(platform-independent version)
 *
 * @param {Function} readBytes - callback function (offset, length) => number[]
 *   returns an array of byte values (0-255) of length starting from offset
 * @returns {Object|null} detection result
 */
function checkMagicNumberFromBytes(readBytes) {
  const bytes = readBytes(0, 8);
  if (!bytes || bytes.length < 2) {
    return null;
  }

  // Convert bytes to a hexadecimal string
  const hexBytes = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase());
  const fileHeader = hexBytes.join('');

  for (const { magic, name } of EXECUTABLE_MAGIC_NUMBERS) {
    if (fileHeader.startsWith(magic)) {
      return {
        isExecutable: true,
        type: name,
        magic: magic
      };
    }
  }

  return null;
}

/**
 * Check whether it is a valid PE (Portable Executable) file(platform-independent version)
 *
 * @param {Function} readBytes - callback function (offset, length) => number[]
 *   returns an array of byte values (0-255) of length starting from offset
 * @param {number} totalLength - buffer total length
 * @returns {Object|null} detection result
 */
function checkPEFileFromBytes(readBytes, totalLength) {
  if (totalLength < 64) {
    return null;
  }

  // Read first 2 bytes to check the MZ header
  const header = readBytes(0, 2);
  if (header[0] !== 0x4D || header[1] !== 0x5A) {
    return null;
  }

  // Read PE header offset (at 0x3C, 4-byte little-endian)
  const peOffsetBytes = readBytes(0x3C, 4);
  const peOffset = peOffsetBytes[0] |
                   (peOffsetBytes[1] << 8) |
                   (peOffsetBytes[2] << 16) |
                   (peOffsetBytes[3] << 24);

  // Check if PE header offset is valid
  if (peOffset < 64 || peOffset + 4 > totalLength) {
    return {
      isPE: false,
      isExecutable: true,
      type: 'DOS executable (old format)',
      details: 'File has MZ header but no valid PE header'
    };
  }

  // Check PE signature "PE\0\0" (0x50, 0x45, 0x00, 0x00)
  const peSig = readBytes(peOffset, 4);
  const isValidPE = peSig[0] === 0x50 &&
                    peSig[1] === 0x45 &&
                    peSig[2] === 0x00 &&
                    peSig[3] === 0x00;

  if (!isValidPE) {
    return {
      isPE: false,
      isExecutable: true,
      type: 'Suspicious MZ file',
      details: 'File has MZ header but invalid PE signature'
    };
  }

  // Read COFF file header characteristic field (Machine type)
  const machineBytes = readBytes(peOffset + 4, 2);
  const machineType = machineBytes[0] | (machineBytes[1] << 8);

  // Read optional header size
  const optHeaderSizeBytes = readBytes(peOffset + 20, 2);
  const optionalHeaderSize = optHeaderSizeBytes[0] | (optHeaderSizeBytes[1] << 8);
  const hasOptionalHeader = optionalHeaderSize > 0;

  // Read characteristic field
  const charBytes = readBytes(peOffset + 18, 2);
  const characteristics = charBytes[0] | (charBytes[1] << 8);

  // Determine file type
  let fileType = 'PE executable';

  // Check if it is a DLL (0x2000 = IMAGE_FILE_DLL)
  if (characteristics & 0x2000) {
    fileType = 'PE dynamic link library (DLL)';
  }
  // Check whether it is an executable image (0x0002 = IMAGE_FILE_EXECUTABLE_IMAGE)
  else if (characteristics & 0x0002) {
    fileType = 'PE executable (EXE)';
  }

  // Machine type mapping
  const machineTypes = {
    0x014C: 'x86 (32-bit)',
    0x8664: 'x64 (64-bit)',
    0xAA64: 'ARM64',
    0x01C0: 'ARM',
    0xEBC: 'EFI bytecode'
  };

  return {
    isPE: true,
    isExecutable: true,
    type: fileType,
    machine: machineTypes[machineType] || `Unknown (0x${machineType.toString(16).toUpperCase()})`,
    architecture: machineType === 0x8664 ? 'x64' : (machineType === 0x014C ? 'x86' : 'other'),
    hasOptionalHeader,
    details: `Valid PE file, ${machineTypes[machineType] || 'Unknown architecture'}`
  };
}

/**
 * Get security prompt info
 * @param {Object} checkResult - checkFileSecurity return result
 * @returns {string} prompt info
 */
function getSecurityWarningMessage(checkResult) {
  if (checkResult.isSafe) {
    return '';
  }

  const reasons = checkResult.reasons.join('\n');
  return `⚠️ Security Warning: Sending executable files is prohibited\n\nReason:\n${reasons}\n\n💡 Tip: If you need to send this file, please compress it into a zip/rar/7z archive first.`;
}

// ────────────────────────────────────────────
// Export (ES Module format, both adapter layers import/require separately)
// ────────────────────────────────────────────

export {
  // Constants
  DANGEROUS_EXTENSIONS,
  DANGEROUS_MIME_TYPES,
  EXECUTABLE_MAGIC_NUMBERS,
  PATHEXT_EXECUTABLES,

  // Pure logic functions
  getFileExtension,
  isDangerousExtension,
  isExecutableByPathExt,
  isDangerousMimeType,
  checkMagicNumberFromBytes,
  checkPEFileFromBytes,
  getSecurityWarningMessage
};

export default {
  DANGEROUS_EXTENSIONS,
  DANGEROUS_MIME_TYPES,
  EXECUTABLE_MAGIC_NUMBERS,
  PATHEXT_EXECUTABLES,
  getFileExtension,
  isDangerousExtension,
  isExecutableByPathExt,
  isDangerousMimeType,
  checkMagicNumberFromBytes,
  checkPEFileFromBytes,
  getSecurityWarningMessage
};
