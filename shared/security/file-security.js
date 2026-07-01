/**
 * File security validation module — browser-side adapter
 *
 * contains platform-independent constant definitions, pure logic functions,
 * and browser-specific data type adaptation (ArrayBuffer / Uint8Array).
 *
 * shared constants and pure logic also for Node.js side
 * service/security/file-security-node.js imported via require().
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
 */
const EXECUTABLE_MAGIC_NUMBERS = [
  { magic: '4D5A', name: 'DOS/Windows executable' },        // MZ - PE file
  // Note: ZIP format (504B0304) removed because Office files such as xlsx/pptx/docx are all ZIP-based
  // Note: ELF, Java, Mach-O, etc. removed; only Windows executables are blocked
];

/**
 * Windows PATHEXT executable extension list
 * Contains executable and script files
 */
const PATHEXT_EXECUTABLES = new Set([
  '.EXE', '.COM', '.SCR', '.MSI',  // executables
  '.BAT', '.CMD', '.PS1', '.VBS', '.JS', '.JSE', '.VBE', '.WSF', '.WSH', '.HTA',  // scripts
  '.MSC'  // Microsoft Management Console file
]);

// ────────────────────────────────────────────
// Pure logic functions (platform-independent)
// ────────────────────────────────────────────

/**
 * Get file extension(pure string operation, not dependent on the path module)
 * @param {string} filename - file name
 * @returns {string|null} extension (lowercase)
 */
export function getFileExtension(filename) {
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
export function isDangerousExtension(filename) {
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
export function isExecutableByPathExt(filename) {
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
export function isDangerousMimeType(mimeType, filename = '') {
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
 * Get security prompt info
 * @param {Object} checkResult - checkFileSecurity return result
 * @returns {string} prompt info
 */
export function getSecurityWarningMessage(checkResult) {
  if (checkResult.isSafe) {
    return '';
  }

  const reasons = checkResult.reasons.join('\n');
  return `⚠️ Security Warning: Sending executable files is prohibited\n\nReason:\n${reasons}\n\n💡 Tip: If you need to send this file, please compress it into a zip/rar/7z archive first.`;
}

// ────────────────────────────────────────────
// Browser-specific functions (operate on ArrayBuffer / Uint8Array)
// ────────────────────────────────────────────

/**
 * Check file content magic number
 * @param {ArrayBuffer} buffer - file content
 * @returns {Object|null} detection result
 */
export function checkMagicNumber(buffer) {
  if (!buffer || buffer.byteLength < 2) {
    return null;
  }

  const uint8Array = new Uint8Array(buffer);
  const hexBytes = [];

  // Read first 8 bytes
  const bytesToRead = Math.min(8, uint8Array.length);
  for (let i = 0; i < bytesToRead; i++) {
    hexBytes.push(uint8Array[i].toString(16).padStart(2, '0').toUpperCase());
  }

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
 * Check whether it is a valid PE (Portable Executable) file
 * @param {ArrayBuffer} buffer - file content (at least the first 256 bytes)
 * @returns {Object|null} detection result
 */
export function checkPEFile(buffer) {
  if (!buffer || buffer.byteLength < 64) {
    return null;
  }

  const uint8Array = new Uint8Array(buffer);

  // PE files start with "MZ" (0x4D, 0x5A)
  if (uint8Array[0] !== 0x4D || uint8Array[1] !== 0x5A) {
    return null;
  }

  // Read PE header offset (at 0x3C, 4-byte little-endian)
  const peOffset = uint8Array[0x3C] |
                   (uint8Array[0x3C + 1] << 8) |
                   (uint8Array[0x3C + 2] << 16) |
                   (uint8Array[0x3C + 3] << 24);

  // Check if PE header offset is valid
  if (peOffset < 64 || peOffset + 4 > buffer.byteLength) {
    return {
      isPE: false,
      isExecutable: true,
      type: 'DOS executable (old format)',
      details: 'File has MZ header but no valid PE header'
    };
  }

  // Check PE signature "PE\0\0" (0x50, 0x45, 0x00, 0x00)
  const isValidPE = uint8Array[peOffset] === 0x50 &&
                    uint8Array[peOffset + 1] === 0x45 &&
                    uint8Array[peOffset + 2] === 0x00 &&
                    uint8Array[peOffset + 3] === 0x00;

  if (!isValidPE) {
    return {
      isPE: false,
      isExecutable: true,
      type: 'Suspicious MZ file',
      details: 'File has MZ header but invalid PE signature'
    };
  }

  // Read COFF file header characteristic field (Machine type)
  const machineType = uint8Array[peOffset + 4] | (uint8Array[peOffset + 5] << 8);

  // Read optional header size (determine whether optional header exists)
  const optionalHeaderSize = uint8Array[peOffset + 20] | (uint8Array[peOffset + 21] << 8);
  const hasOptionalHeader = optionalHeaderSize > 0;

  // Read characteristic field
  const characteristics = uint8Array[peOffset + 18] | (uint8Array[peOffset + 19] << 8);

  // Determine file type
  let fileType = 'PE executable';

  // Check if it is a DLL (0x2000 = IMAGE_FILE_DLL)
  if (characteristics & 0x2000) {
    fileType = 'PE dynamic link library (DLL)';
  }
  // check whether it is an executable image (0x0002 = IMAGE_FILE_EXECUTABLE_IMAGE)
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
 * Comprehensive security check
 * only block immediately executable Windows files, allow all others
 * @param {Object} fileInfo - file info object
 * @param {string} fileInfo.name - file name
 * @param {string} fileInfo.type - MIME type
 * @param {number} fileInfo.size - file size
 * @param {ArrayBuffer} [fileInfo.content] - file content (optional, for magic number check)
 * @returns {Object} check result
 */
export function checkFileSecurity(fileInfo) {
  const result = {
    isSafe: true,
    isDangerous: false,
    reasons: [],
    extension: null,
    mimeType: null,
    magicCheck: null,
    pathExtCheck: null,
    peCheck: null
  };

  if (!fileInfo || typeof fileInfo !== 'object') {
    result.isSafe = false;
    result.reasons.push('Invalid file information');
    return result;
  }

  const { name, type, content } = fileInfo;

  // Check extension (only real executable files)
  result.extension = getFileExtension(name);
  if (result.extension && isDangerousExtension(name)) {
    result.isDangerous = true;
    result.isSafe = false;
    result.reasons.push(`Executable file: .${result.extension}`);
  }

  // Check extension (PATHEXT list)
  if (isExecutableByPathExt(name)) {
    result.pathExtCheck = {
      isExecutable: true,
      source: 'PATHEXT'
    };
    if (!result.isDangerous) {
      result.isDangerous = true;
      result.isSafe = false;
      result.reasons.push(`Executable file: .${result.extension?.toUpperCase()}`);
    }
  }

  // Check MIME type
  result.mimeType = type;
  if (isDangerousMimeType(type, name)) {
    result.isDangerous = true;
    result.isSafe = false;
    result.reasons.push(`Executable file MIME type: ${type}`);
  }

  // Check file content (PE header only)
  if (content && content instanceof ArrayBuffer) {
    if (content.byteLength >= 256) {
      result.peCheck = checkPEFile(content);
      if (result.peCheck && result.peCheck.isExecutable) {
        result.isDangerous = true;
        result.isSafe = false;
        result.reasons.push(`Windows executable file: ${result.peCheck.type}`);
      }
    }

    // Only check MZ header (DOS/Windows executables)
    if (!result.peCheck) {
      result.magicCheck = checkMagicNumber(content);
      if (result.magicCheck && result.magicCheck.isExecutable) {
        result.isDangerous = true;
        result.isSafe = false;
        result.reasons.push(`Windows executable file: ${result.magicCheck.type}`);
      }
    }
  }

  return result;
}

/**
 * Verify whether file is allowed to transfer
 * @param {File|Object} file - file object
 * @returns {Promise<Object>} validation result
 */
export async function validateFileForTransfer(file) {
  const fileInfo = {
    name: file.name || '',
    type: file.type || '',
    size: file.size || 0
  };

  // Try to read first 256 bytes for PE file check
  try {
    if (file.slice) {
      const slice = file.slice(0, 256);
      fileInfo.content = await slice.arrayBuffer();
    }
  } catch (e) {
    // ignore read error
  }

  const checkResult = checkFileSecurity(fileInfo);

  return {
    allowed: checkResult.isSafe,
    ...checkResult,
    message: getSecurityWarningMessage(checkResult)
  };
}

// Export constants for other modules
export { DANGEROUS_EXTENSIONS, DANGEROUS_MIME_TYPES, EXECUTABLE_MAGIC_NUMBERS, PATHEXT_EXECUTABLES };

// Default export
export default {
  isDangerousExtension,
  isDangerousMimeType,
  checkMagicNumber,
  checkPEFile,
  isExecutableByPathExt,
  checkFileSecurity,
  getSecurityWarningMessage,
  validateFileForTransfer,
  DANGEROUS_EXTENSIONS,
  DANGEROUS_MIME_TYPES,
  EXECUTABLE_MAGIC_NUMBERS,
  PATHEXT_EXECUTABLES
};
