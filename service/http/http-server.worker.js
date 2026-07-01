const { parentPort } = require('worker_threads');
const http = require('http');
const fs = require('fs');
const path = require('path');

let server = null;
let serverConfig = null;

/**
 * Send message to main thread
 * @param {Object} data - message data
 */
function sendMessage(id, data) {
  parentPort.postMessage({
    id,
    success: true,
    data
  });
}

/**
 * Send error message to main thread
 * @param {Error} error - error object
 */
function sendError(id, error) {
  parentPort.postMessage({
    id,
    success: false,
    error: error.message
  });
}

/**
 * Send log message to main thread
 * @param {string} level - Log level (info, warn, error)
 * @param {string} message - Log message
 */
function sendLog(level, message) {
  parentPort.postMessage({
    type: 'log',
    level,
    message: `[HTTP] ${message}`
  });
}

/**
 * Parse file path, supporting user-isolated directory structure
 * Path formats: /{username}/files/{recvs|sends}/{filename}
 * Or old format: /files/{recvs|sends}/{filename} (try to find in all user directories)
 * @param {string} pathname - request path
 * @returns {Promise<Object|null>} - parse result {fullPath, username, fileType, fileName} or null
 */
async function resolveFilePath(pathname) {
  const parts = pathname.split('/').filter(p => p.length > 0);

  // New format: /{username}/files/{recvs|sends}/{filename}
  if (parts.length >= 4 && parts[1] === 'files' && (parts[2] === 'recvs' || parts[2] === 'sends')) {
    const username = parts[0];
    const fileType = parts[2];
    const fileName = parts.slice(3).join('/');
    const fullPath = path.join(serverConfig.resourcesDir, 'users', username, 'files', fileType, fileName);
    return { fullPath, username, fileType, fileName };
  }

  // Old format: /files/{recvs|sends}/{filename} - need to search all user directories
  // And root format: /{recvs|sends}/{filename} - also need to search all user directories
  const isOldFilesFormat = parts.length >= 3 && parts[0] === 'files' && (parts[1] === 'recvs' || parts[1] === 'sends');
  const isRootFolderFormat = parts.length >= 2 && (parts[0] === 'recvs' || parts[0] === 'sends');

  if (isOldFilesFormat || isRootFolderFormat) {
    const fileType = isOldFilesFormat ? parts[1] : parts[0];
    const fileName = isOldFilesFormat ? parts.slice(2).join('/') : parts.slice(1).join('/');

    // Try to find file in all user directories (async version)
    try {
      const resourcesDir = serverConfig.resourcesDir;
      const usersDir = path.join(resourcesDir, 'users');
      const entries = await fs.promises.readdir(usersDir);

      for (const entry of entries) {
        const entryPath = path.join(usersDir, entry);
        try {
          const stat = await fs.promises.stat(entryPath);

          // Check if it is a mailbox directory
          if (stat.isDirectory() && entry.includes('@')) {
            const candidatePath = path.join(entryPath, 'files', fileType, fileName);
            try {
              await fs.promises.access(candidatePath, fs.constants.F_OK);
              return { fullPath: candidatePath, username: entry, fileType, fileName };
            } catch {
              // file does not exist，continue searching
            }
          }
        } catch {
          // unable to get directory status，skip
        }
      }
    } catch (e) {
      sendLog('error', `Search file failed: ${e.message}`);
    }

    // If not found, return default path (will trigger 404)
    const defaultPath = path.join(serverConfig.resourcesDir, 'files', fileType, fileName);
    return { fullPath: defaultPath, username: null, fileType, fileName };
  }

  // /assets/ path maps to resources/sys/assets/
  if (parts[0] === 'assets') {
    const fullPath = path.join(serverConfig.resourcesDir, 'sys', pathname);
    return { fullPath, username: null, fileType: null, fileName: pathname };
  }

  // Other paths are relative to resourcesDir directly
  const fullPath = path.join(serverConfig.resourcesDir, pathname);
  return { fullPath, username: null, fileType: null, fileName: pathname };
}

/**
 * Handle HTTP request
 * @param {http.IncomingMessage} req - request object
 * @param {http.ServerResponse} res - response object
 */
async function handleRequest(req, res) {
  // Handle GET and HEAD requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Parse request path and query parameters
  const urlObj = new URL(req.url, 'http://127.0.0.1');
  let filePath = decodeURIComponent(urlObj.pathname);
  const totalSizeParam = urlObj.searchParams.get('totalSize');
  const snapshotSizeParam = urlObj.searchParams.get('snapshotSize');
  const streamFormatParam = urlObj.searchParams.get('streamFormat');

  // Handle API requests
  if (filePath.startsWith('/api/')) {
    handleApiRequest(req, res, urlObj);
    return;
  }

  // Root path redirects to index.html (if it exists)
  if (filePath === '/') {
    filePath = '/index.html';
  }

  // Parse file path (supporting user-isolated directory structure)
  const resolved = await resolveFilePath(filePath);
  if (!resolved) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File Not Found');
    return;
  }

  const { fullPath } = resolved;

  // Check if file exists
  try {
    const stats = await fs.promises.stat(fullPath);
    
    // Check if it is a directory
    if (stats.isDirectory()) {
      // If directory, try to return index.html
      const indexPath = path.join(fullPath, 'index.html');
      try {
        await fs.promises.access(indexPath, fs.constants.F_OK);
        await sendFile(req, res, indexPath, null, null, null);
      } catch (e) {
        // If no index.html, return directory listing
        sendDirectoryList(res, fullPath, filePath);
      }
      return;
    }

    // Send file
    await sendFile(req, res, fullPath, totalSizeParam, snapshotSizeParam, streamFormatParam);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File does not exist
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File Not Found');
    } else {
      // Other errors
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
}

/**
 * Handle API requests
 * @param {http.IncomingMessage} req - request object
 * @param {http.ServerResponse} res - response object
 * @param {URL} urlObj - URL object
 */
async function handleApiRequest(req, res, urlObj) {
  const pathname = urlObj.pathname;

  // Transfer progress query endpoint
  if (pathname === '/api/progress') {
    const fileId = urlObj.searchParams.get('fileId');
    const fileName = urlObj.searchParams.get('fileName');
    const directory = urlObj.searchParams.get('directory') || 'recvs';
    const username = urlObj.searchParams.get('username'); // Added: username parameter

    if (!fileId && !fileName) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...getCorsHeaders() });
      res.end(JSON.stringify({ error: 'Missing fileId or fileName parameter' }));
      return;
    }

    // Build possible file paths
    const targetFileName = fileName || `${fileId}`;
    let filePath;

    if (username) {
      // New format: use user-specific directory
      filePath = path.join(serverConfig.resourcesDir, username, 'files', directory, targetFileName);
    } else {
      // Old format: try to find in all user directories
      filePath = await findFileInUserDirs(directory, targetFileName);
    }

    // Get expected size (from query parameters or stored metadata)
    const expectedSize = parseInt(urlObj.searchParams.get('expectedSize'), 10) || 0;

    try {
      const stats = await fs.promises.stat(filePath);
      const response = {
        fileId,
        fileName: targetFileName,
        received: stats.size,
        total: expectedSize || stats.size,
        percent: expectedSize > 0
          ? Math.min(100, Math.round((stats.size / expectedSize) * 100))
          : 100,
        exists: true,
        isComplete: expectedSize > 0 ? stats.size >= expectedSize : true,
        lastModified: stats.mtime
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...getCorsHeaders()
      });
      res.end(JSON.stringify(response));
    } catch (err) {
      // File does not exist or cannot be accessed
      const response = {
        fileId,
        fileName: targetFileName,
        received: 0,
        total: expectedSize,
        percent: 0,
        exists: false,
        isComplete: false
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...getCorsHeaders()
      });
      res.end(JSON.stringify(response));
    }
    return;
  }

  // Video stream status query endpoint (for streaming while transferring)
  if (pathname === '/api/stream-status') {
    const fileName = urlObj.searchParams.get('fileName');
    const directory = urlObj.searchParams.get('directory') || 'recvs';
    const username = urlObj.searchParams.get('username'); // Added: username parameter

    if (!fileName) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...getCorsHeaders() });
      res.end(JSON.stringify({ error: 'Missing fileName parameter' }));
      return;
    }

    let filePath;
    if (username) {
      // New format: use user-specific directory
      filePath = path.join(serverConfig.resourcesDir, username, 'files', directory, fileName);
    } else {
      // Old format: try to find in all user directories
      filePath = await findFileInUserDirs(directory, fileName);
    }

    const expectedSize = parseInt(urlObj.searchParams.get('expectedSize'), 10) || 0;

    try {
      const stats = await fs.promises.stat(filePath);
      const received = stats.size;
      const total = expectedSize || stats.size;
      const percent = expectedSize > 0
        ? Math.min(100, Math.round((stats.size / expectedSize) * 100))
        : 100;

      // Simple heuristic: if received more than 5% or first 500KB, consider playable
      const minPlayablePercent = 5;
      const minPlayableBytes = 500 * 1024;
      const canPlay = percent >= minPlayablePercent || received >= minPlayableBytes;

      const response = {
        fileName,
        canPlay,
        received,
        total,
        percent,
        hasMoov: false,
        moovPosition: null
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...getCorsHeaders()
      });
      res.end(JSON.stringify(response));
    } catch (err) {
      // File does not exist or cannot be accessed
      const response = {
        fileName,
        canPlay: false,
        received: 0,
        total: expectedSize,
        percent: 0,
        hasMoov: false,
        moovPosition: null
      };

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        ...getCorsHeaders()
      });
      res.end(JSON.stringify(response));
    }
    return;
  }

  // Unknown API path
  res.writeHead(404, { 'Content-Type': 'application/json', ...getCorsHeaders() });
  res.end(JSON.stringify({ error: 'API endpoint not found' }));
}

/**
 * Find file in all user directories
 * @param {string} directory - directory name (recvs or sends)
 * @param {string} fileName - file name
 * @returns {Promise<string>} - found file path or default path
 */
async function findFileInUserDirs(directory, fileName) {
  try {
    const resourcesDir = serverConfig.resourcesDir;
    const usersDir = path.join(resourcesDir, 'users');
    const entries = await fs.promises.readdir(usersDir);

    for (const entry of entries) {
      const entryPath = path.join(usersDir, entry);
      try {
        const stat = await fs.promises.stat(entryPath);

        // Check if it is a mailbox directory
        if (stat.isDirectory() && entry.includes('@')) {
          const candidatePath = path.join(entryPath, 'files', directory, fileName);
          try {
            await fs.promises.access(candidatePath, fs.constants.F_OK);
            return candidatePath;
          } catch {
            // file does not exist，continue searching
          }
        }
      } catch {
        // unable to get directory status，skip
      }
    }
  } catch (e) {
    sendLog('error', `Search file failed: ${e.message}`);
  }

  // If not found, return default path
  return path.join(serverConfig.resourcesDir, 'users', 'files', directory, fileName);
}

/**
 * Parse Range request header
 * @param {string} range - Range header value
 * @param {number} fileSize - file size
 * @returns {Object|null} - parsed range object in {start: number, end: number} format, null on failure
 */
function parseRange(range, fileSize) {
  if (!range) return null;

  // Check Range header format
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  let start = parseInt(match[1], 10);
  let end = parseInt(match[2], 10);

  // Handle edge cases - fix: check start first, then handle missing start
  if (isNaN(start) && !isNaN(end)) {
    // bytes=-500 format: request last end bytes
    start = Math.max(0, fileSize - end);
    end = fileSize - 1;
  } else if (!isNaN(start) && isNaN(end)) {
    // bytes=500- format: from start byte to end of file (keep open range; sendFile decides actual end)
    end = null;
  } else if (isNaN(start) && isNaN(end)) {
    // Format error, treat as whole file
    start = 0;
    end = null;
  }

  if (!Number.isFinite(start)) {
    start = 0;
  }
  start = Math.max(0, start);
  if (end !== null && Number.isFinite(end)) {
    end = Math.max(start, end);
  } else {
    end = null;
  }

  return { start, end };
}

/**
 * Send file content
 * @param {http.IncomingMessage} req - request object
 * @param {http.ServerResponse} res - response object
 * @param {string} filePath - file path
 * @param {string} totalSizeParam - optional total size parameter
 */
async function sendFile(req, res, filePath, totalSizeParam, snapshotSizeParam, streamFormatParam) {
  // Get file extension
  const extname = path.extname(filePath);

  // Set Content-Type
  const contentType = getContentType(extname);

  try {
    let stats = await fs.promises.stat(filePath);
    let fileSize = stats.size;
    const range = req.headers.range;
    const snapshotSizeValueRaw = snapshotSizeParam ? parseInt(snapshotSizeParam, 10) : 0;
    const hasSnapshot = Number.isFinite(snapshotSizeValueRaw) && snapshotSizeValueRaw > 0;
    const isHeadRequest = req.method === 'HEAD';
    
    // Plan B: disable cache for dynamic files under recvs and sends directories
    // Support both old and new path formats:
    // New format: /{username}/files/{recvs|sends}/{filename}
    // Old format: /files/{recvs|sends}/{filename}
    const isDynamicFile = filePath.includes(path.sep + 'recvs' + path.sep) || 
                          filePath.includes(path.sep + 'sends' + path.sep) ||
                          (filePath.includes(path.sep + 'files' + path.sep + 'recvs') ||
                           filePath.includes(path.sep + 'files' + path.sep + 'sends'));
    const cacheControl = isDynamicFile 
      ? 'no-cache, no-store, must-revalidate' 
      : 'public, max-age=3600';

    // Add file integrity check
    if (totalSizeParam && parseInt(totalSizeParam) !== fileSize) {
      sendLog('warn', `File size mismatch warning: param=${totalSizeParam}, actual=${fileSize}, file=${filePath}`);
    }

    if (hasSnapshot) {
      fileSize = Math.min(fileSize, snapshotSizeValueRaw);
    }

    const totalSizeValue = hasSnapshot
      ? Math.min(snapshotSizeValueRaw, totalSizeParam ? parseInt(totalSizeParam, 10) : snapshotSizeValueRaw)
      : (totalSizeParam ? parseInt(totalSizeParam, 10) : 0);
    const parsedRange = parseRange(range, fileSize);
    
    // Calculate actual available data range (for streaming while transferring)
    const availableEnd = hasSnapshot ? fileSize : Math.min(fileSize, totalSizeValue || fileSize);
    const isRangeBeyondAvailable = parsedRange && parsedRange.start >= availableEnd;

    const isRangeZeroToNull = parsedRange && parsedRange.start === 0 && parsedRange.end === null;

    // HEAD request: return headers only, no content
    if (isHeadRequest) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        ...getCorsHeaders()
      });
      res.end();
      return;
    }

    // MP4 streaming: when file is not fully written, use totalSize as Content-Length and push in controlled manner
    const isActiveMp4Stream = isDynamicFile
      && streamFormatParam === 'mp4'
      && totalSizeValue > 0
      && totalSizeValue > fileSize
      && !hasSnapshot;

    // Add X-Available-Range header to inform client of actual available data range
    const availableRangeHeader = isActiveMp4Stream 
      ? { 'X-Available-Range': `bytes=0-${fileSize - 1}` }
      : {};

    if (isActiveMp4Stream && (!parsedRange || isRangeZeroToNull)) {
      if (!hasSnapshot && fileSize === 0) {
        sendLog('info', `dynamic file is empty, waiting for first bytes: ${path.basename(filePath)}, target=${totalSizeValue}`);
        const newSize = await waitForFileGrowth(filePath, 1);
        if (newSize !== null) {
          fileSize = newSize;
        }
      }

      sendLog('info', `MP4 streaming push (forced sequential): ${path.basename(filePath)}, current=${fileSize}, target=${totalSizeValue}`);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': totalSizeValue,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        ...availableRangeHeader,
        ...getCorsHeaders()
      });
      await streamFileWithGrowth(res, filePath, totalSizeValue);
      return;
    }

    if (!parsedRange) {
      if (!hasSnapshot && isDynamicFile && fileSize === 0 && totalSizeValue > 0) {
        sendLog('info', `dynamic file is empty, waiting for first bytes: ${path.basename(filePath)}, target=${totalSizeValue}`);
        const newSize = await waitForFileGrowth(filePath, 1);
        if (newSize !== null) {
          fileSize = newSize;
        }
      }

      sendLog('info', `Sending complete file: ${path.basename(filePath)}, size=${fileSize}, Content-Type=${contentType}`);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        ...getCorsHeaders()
      });

      const stream = fs.createReadStream(filePath);
      stream.on('error', (error) => {
        sendLog('error', `File read error: ${filePath}, ${error.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('File read error');
        }
      });

      stream.pipe(res);
      return;
    }

    let { start, end } = parsedRange;
    const requestedEnd = end;
    const growthWindowBytes = chooseGrowthWindowBytes({
      contentType,
      fileSize,
      totalSize: totalSizeValue
    });
    
    // Streaming while transferring support: handle empty or in-transit files
    if (fileSize === 0) {
      if (!hasSnapshot && isDynamicFile && totalSizeValue > 0) {
        sendLog('info', `Range request hit empty file, waiting for first byte: ${path.basename(filePath)}`);
        const newSize = await waitForFileGrowth(filePath, 1);
        if (newSize !== null) {
          fileSize = newSize;
        }
      }
      
      if (fileSize === 0) {
        sendLog('info', `File is still empty or in transit: ${path.basename(filePath)}, fileSize=0`);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': 0,
          'Accept-Ranges': 'bytes',
          'Cache-Control': cacheControl,
          ...getCorsHeaders()
        });
        res.end();
        return;
      }
    }
    
    // Streaming while transferring support: if requested start exceeds current file size but within expected range, wait
    if (start >= fileSize) {
      if (!hasSnapshot && totalSizeValue > start && isDynamicFile) {
        sendLog('info', `Range request exceeds current size, starting to wait for data: start=${start}, fileSize=${fileSize}, target=${totalSizeValue}`);
        const newSize = await waitForFileGrowth(filePath, start + 1);
        if (newSize !== null) {
          fileSize = newSize;
        }
      }
    }
    
    // Recheck available end position
    const currentAvailableEnd = hasSnapshot ? fileSize : Math.min(fileSize, totalSizeValue || fileSize);

    // If browser's requested end is ahead of current file size, prefer waiting for a small growth
    // This reduces repeated buffer-edge waiting/canplay jitter.
    if (
      !hasSnapshot &&
      isDynamicFile &&
      totalSizeValue > fileSize &&
      start < fileSize &&
      (requestedEnd === null || requestedEnd >= fileSize)
    ) {
      const desiredEndExclusive = requestedEnd === null
        ? Math.min(totalSizeValue, fileSize + growthWindowBytes)
        : Math.min(totalSizeValue, requestedEnd + 1, fileSize + growthWindowBytes);

      if (desiredEndExclusive > fileSize) {
        sendLog('info', `Range request reached current file end, waiting for more data: start=${start}, current=${fileSize}, desired=${desiredEndExclusive}, file=${path.basename(filePath)}`);
        const newSize = await waitForFileGrowth(
          filePath,
          desiredEndExclusive,
          chooseGrowthWaitTimeout({
            contentType,
            fileSize,
            totalSize: totalSizeValue
          })
        );
        if (newSize !== null) {
          fileSize = newSize;
        }
      }
    }

    // Recheck if start exceeds current available range
    if (start >= currentAvailableEnd) {
      if (!hasSnapshot && isDynamicFile && totalSizeValue > fileSize) {
        sendLog('warn', `Range request out of range, continuously waiting for data download to avoid playback interruption: start=${start}, fileSize=${fileSize}, available=${currentAvailableEnd}`);
        while (start >= fileSize && fileSize < totalSizeValue) {
          const newSize = await waitForFileGrowth(filePath, start + 1, 30000, { idleTimeout: 30000 });
          if (newSize !== null && newSize > fileSize) {
            fileSize = newSize;
          } else {
            try {
              const stats = await fs.promises.stat(filePath);
              fileSize = stats.size;
            } catch (e) {
              break;
            }
          }
        }
        // Update available end position
        fileSize = Math.min(fileSize, totalSizeValue || fileSize);
      }

      if (start >= fileSize) {
        // Request range exceeds current file size and wait timed out or not needed
        // Return 416 but include actual available range info
        sendLog('warn', `Range request out of range: start=${start}, fileSize=${fileSize}, file=${filePath}`);
        const displayTotalSize = (totalSizeParam && parseInt(totalSizeParam) > fileSize) ? parseInt(totalSizeParam) : fileSize;
        res.writeHead(416, { 
          'Content-Type': 'text/plain', 
          'Content-Range': `bytes */${displayTotalSize}`,
          'X-Available-Range': `bytes=0-${Math.max(0, fileSize - 1)}`,
          ...getCorsHeaders() 
        });
        res.end('Requested Range Not Satisfiable');
        return;
      }
    }
    
    if (end === null) {
      end = fileSize - 1;
    }

    // If end exceeds file size, adjust to end of file
    if (end >= fileSize) {
      end = Math.max(start, fileSize - 1);
    }
    
    // If start == end (only one byte), return 200 instead of 206
    if (start === end && fileSize === 1) {
      sendLog('info', `File has only one byte: ${path.basename(filePath)}`);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        ...getCorsHeaders()
      });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      return;
    }

    const chunkSize = end - start + 1;
    sendLog('info', `Sending Range request: ${path.basename(filePath)}, Range=${start}-${end}/${fileSize}, ChunkSize=${chunkSize}`);

    // Build response headers including available range info
    const responseHeaders = {
      'Content-Type': contentType,
      'Content-Length': chunkSize,
      'Content-Range': `bytes ${start}-${end}/${(totalSizeParam && parseInt(totalSizeParam) > fileSize) ? parseInt(totalSizeParam) : fileSize}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      ...getCorsHeaders()
    };

    // If dynamic file and in transfer, add available range header
    if (isDynamicFile && totalSizeValue > fileSize) {
      responseHeaders['X-Available-Range'] = `bytes=0-${fileSize - 1}`;
    }

    res.writeHead(206, responseHeaders);

    const stream = fs.createReadStream(filePath, { start, end });

    stream.on('error', (error) => {
      sendLog('error', `Range file read error: ${filePath}, Range=${start}-${end}, ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Range file read error');
      }
    });

    stream.pipe(res);
  } catch (e) {
    sendLog('error', `File processing exception: ${filePath}, ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
}

/**
 * Send directory listing
 * @param {http.ServerResponse} res - response object
 * @param {string} dirPath - directory path
 * @param {string} reqPath - request path
 */
async function sendDirectoryList(res, dirPath, reqPath) {
  try {
    const files = await fs.promises.readdir(dirPath);

    // Generate HTML directory listing
    let html = `<html><head><title>Directory Listing - ${reqPath}</title></head><body>`;
    html += `<h1>Directory Listing - ${reqPath}</h1>`;
    html += `<ul>`;

    // Add parent directory link
    if (reqPath !== '/') {
      const parentPath = path.dirname(reqPath);
      html += `<li><a href="${parentPath}">../</a></li>`;
    }

    // Add file and subdirectory links (async parallel retrieval of file stats)
    const fileStats = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(reqPath, file);
        const fullPath = path.join(dirPath, file);
        try {
          const stats = await fs.promises.stat(fullPath);
          return { file, filePath, isDirectory: stats.isDirectory() };
        } catch {
          return { file, filePath, isDirectory: false };
        }
      })
    );

    fileStats.forEach(({ file, filePath, isDirectory }) => {
      if (isDirectory) {
        html += `<li><a href="${filePath}/">${file}/</a></li>`;
      } else {
        html += `<li><a href="${filePath}">${file}</a></li>`;
      }
    });

    html += `</ul></body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error reading directory');
  }
}

/**
 * Get Content-Type by file extension
 * @param {string} extname - file extension
 * @returns {string} Content-Type
 */
function getContentType(extname) {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.woff': 'application/font-woff',
    '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'application/font-otf',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    // Video formats for streaming
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.m4a': 'audio/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.flv': 'video/x-flv'
  };

  return mimeTypes[extname] || 'application/octet-stream';
}

/**
 * Controlled streaming push: loop read and send data, wait for file growth until target size
 * @param {http.ServerResponse} res - HTTP response object
 * @param {string} filePath - file path
 * @param {number} targetSize - target total bytes (totalSize)
 * @param {Object} options - optional parameters
 */
async function streamFileWithGrowth(res, filePath, targetSize, options = {}) {
  const pollInterval = options.pollInterval || 300;
  const idleTimeout = options.idleTimeout || 30000;
  const readChunkSize = options.readChunkSize || 256 * 1024; // 256KB per read
  let bytesSent = 0;
  let lastGrowthAt = Date.now();
  let connectionClosed = false;

  res.on('close', () => {
    connectionClosed = true;
  });

  while (bytesSent < targetSize && !connectionClosed) {
    // Get current file size
    let currentFileSize;
    try {
      const stats = await fs.promises.stat(filePath);
      currentFileSize = stats.size;
    } catch (e) {
      sendLog('error', `streamFileWithGrowth stat error: ${e.message}`);
      break;
    }

    // Calculate readable byte range
    const readableEnd = Math.min(currentFileSize, targetSize);

    if (bytesSent < readableEnd) {
      // New data available, read and send in batches
      lastGrowthAt = Date.now();

      while (bytesSent < readableEnd && !connectionClosed) {
        const chunkEnd = Math.min(bytesSent + readChunkSize, readableEnd);
        try {
          const fd = await fs.promises.open(filePath, 'r');
          try {
            const buf = Buffer.alloc(chunkEnd - bytesSent);
            const { bytesRead } = await fd.read(buf, 0, buf.length, bytesSent);
            if (bytesRead > 0) {
              const data = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
              const canContinue = res.write(data);
              bytesSent += bytesRead;

              // Backpressure handling: if write returns false, wait for drain
              if (!canContinue && !connectionClosed) {
                await new Promise(resolve => res.once('drain', resolve));
              }
            } else {
              // bytesRead === 0, file may be truncated or concurrent read/write conflict, wait briefly
              break;
            }
          } finally {
            await fd.close();
          }
        } catch (e) {
          sendLog('error', `streamFileWithGrowth read error at offset ${bytesSent}: ${e.message}`);
          break;
        }
      }
    } else {
      // All current disk data sent, wait for file growth
      if (Date.now() - lastGrowthAt > idleTimeout) {
        sendLog('warn', `streamFileWithGrowth idle timeout: sent=${bytesSent}/${targetSize}, file=${path.basename(filePath)}`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  if (!connectionClosed) {
    res.end();
  }

  if (bytesSent < targetSize) {
    sendLog('warn', `streamFileWithGrowth incomplete: sent=${bytesSent}/${targetSize}, file=${path.basename(filePath)}`);
  } else {
    sendLog('info', `streamFileWithGrowth complete: sent=${bytesSent}/${targetSize}, file=${path.basename(filePath)}`);
  }
}

/**
 * Wait for file to grow to specified size (supports streaming while transferring)
 * @param {string} filePath - file path
 * @param {number} targetSize - target size
 * @param {number} timeout - timeout in milliseconds
 * @returns {Promise<number|null>} returns new file size, or null on timeout
 */
async function waitForFileGrowth(filePath, targetSize, timeout = 10000, options = {}) {
  const startTime = Date.now();
  const pollInterval = typeof options.pollInterval === 'number' ? options.pollInterval : 300;
  const idleTimeout = typeof options.idleTimeout === 'number' ? options.idleTimeout : timeout;
  const maxTotalTimeout = typeof options.maxTotalTimeout === 'number' ? options.maxTotalTimeout : timeout;
  let lastObservedSize = -1;
  let lastGrowthAt = Date.now();

  while (Date.now() - startTime < maxTotalTimeout) {
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.size >= targetSize) {
        return stats.size;
      }

      if (stats.size > lastObservedSize) {
        lastObservedSize = stats.size;
        lastGrowthAt = Date.now();
      }
    } catch (e) {
      // ignore file stat error
    }

    if (Date.now() - lastGrowthAt >= idleTimeout) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  return null;
}

function chooseGrowthWindowBytes({ contentType, fileSize, totalSize }) {
  if (contentType?.startsWith('video/')) {
    if (totalSize > 0 && fileSize > 0) {
      const remain = Math.max(0, totalSize - fileSize);
      return Math.min(remain, 8 * 1024 * 1024);
    }
    return 8 * 1024 * 1024;
  }
  return 1 * 1024 * 1024;
}

function chooseGrowthWaitTimeout({ contentType, totalSize, fileSize }) {
  if (contentType?.startsWith('video/')) {
    const remain = Math.max(0, (totalSize || 0) - (fileSize || 0));
    if (remain > 64 * 1024 * 1024) {
      return 2500;
    }
    return 1800;
  }
  return 1000;
}

function chooseFutureRangeWaitConfig({ contentType, totalSize, fileSize, start }) {
  if (contentType?.startsWith('video/')) {
    const gap = Math.max(0, (start + 1) - (fileSize || 0));
    const remain = Math.max(0, (totalSize || 0) - (fileSize || 0));

    if (gap > 32 * 1024 * 1024 || remain > 64 * 1024 * 1024) {
      return {
        idleTimeout: 12000,
        maxTotalTimeout: 45000,
        pollInterval: 250
      };
    }

    if (gap > 8 * 1024 * 1024 || remain > 24 * 1024 * 1024) {
      return {
        idleTimeout: 8000,
        maxTotalTimeout: 30000,
        pollInterval: 250
      };
    }

    return {
      idleTimeout: 5000,
      maxTotalTimeout: 15000,
      pollInterval: 250
    };
  }

  return {
    idleTimeout: 2000,
    maxTotalTimeout: 5000,
    pollInterval: 250
  };
}

function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length',
    'Cross-Origin-Resource-Policy': 'cross-origin'
  };
}

/**
 * Start HTTP server
 * @param {Object} config - server config
 */
function startServer(config) {
  serverConfig = config;

  // Create HTTP server
  server = http.createServer(handleRequest);

  // Listen on specified port
  server.listen(config.port, config.host, () => {
    sendLog('info', `HTTP Server running at http://${config.host}:${config.port}`);
    sendLog('info', `Resources directory: ${config.resourcesDir}`);
    sendMessage(config.__taskId, `HTTP Server running at http://${config.host}:${config.port}`);
  });

  // Handle server errors
  server.on('error', (err) => {
    sendLog('error', `HTTP Server error: ${err.message}`);
    sendError(config.__taskId, err);
  });
}

/**
 * Stop HTTP server
 */
function stopServer() {
  if (server) {
    server.close(() => {
      sendLog('info', 'HTTP Server stopped');
      sendMessage(serverConfig ? serverConfig.__taskId : undefined, 'HTTP Server stopped');
      server = null;
    });
  }
}

// Listen to main thread messages
parentPort.on('message', (message) => {
  const { id, action, ...data } = message;

  switch (action) {
    case 'start':
      if (server) {
        sendMessage(id, `HTTP Server already running at http://${serverConfig.host}:${serverConfig.port}`);
        break;
      }
      startServer({ ...data, __taskId: id });
      break;
    case 'stop':
      if (!server) {
        sendMessage(id, 'HTTP Server not running');
        break;
      }
      if (serverConfig) serverConfig.__taskId = id;
      stopServer();
      break;
    default:
      sendError(id, new Error(`Unknown action: ${action}`));
  }
});

// Send ready message
parentPort.postMessage({
  success: true,
  data: 'HTTP Server Worker ready'
});
