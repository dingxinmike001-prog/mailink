/**
 * MP4 Moov reassembly Worker
 * Processes binary data and range management in Worker thread to avoid blocking main thread
 */

const logger = {
  info: (msg) => self.postMessage({ type: 'log', level: 'info', message: msg }),
  warn: (msg) => self.postMessage({ type: 'log', level: 'warn', message: msg }),
  error: (msg) => self.postMessage({ type: 'log', level: 'error', message: msg })
};

function resolveMoovLayout(fileData, rangeStart, rangeEnd, chunkOffset, chunkLength) {
  const start = Number.isFinite(fileData?.moovRangeStart)
    ? fileData.moovRangeStart
    : (Number.isFinite(rangeStart) ? rangeStart : chunkOffset);
  const endFromState = Number.isFinite(fileData?.moovRangeEnd) && fileData.moovRangeEnd > start
    ? fileData.moovRangeEnd
    : null;
  const endFromChunk = Number.isFinite(rangeEnd) && rangeEnd > start
    ? rangeEnd
    : null;

  const sizeFromState = fileData?.moovSize || 0;
  const sizeFromRange = endFromChunk ? (endFromChunk - start) : 0;
  const resolvedSize = Math.max(sizeFromState, sizeFromRange, chunkLength || 0);
  const resolvedEnd = Math.max(endFromState || 0, endFromChunk || 0, start + resolvedSize);

  return {
    start,
    end: resolvedEnd,
    size: resolvedSize,
    moovRangeStart: start,
    moovRangeEnd: resolvedEnd,
    moovSize: resolvedSize
  };
}

function recordWrittenRange(ranges, start, end) {
  if (!Array.isArray(ranges) || end <= start) {
    return;
  }

  ranges.push({ start, end });
  mergeWrittenRanges(ranges);
}

function mergeWrittenRanges(ranges) {
  ranges.sort((a, b) => a.start - b.start);
  const merged = [];

  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ start: range.start, end: range.end });
    } else {
      last.end = Math.max(last.end, range.end);
    }
  }

  ranges.splice(0, ranges.length, ...merged);
}

function getContiguousWrittenEndFrom(ranges, start = 0) {
  if (!Array.isArray(ranges) || !ranges.length) {
    return start;
  }

  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let cursor = start;

  for (const range of sorted) {
    if (range.end <= cursor) {
      continue;
    }
    if (range.start > cursor) {
      break;
    }

    cursor = Math.max(cursor, range.end);
  }

  return cursor;
}

function appendMoovChunkForReassembly(moovAssemblyBuffer, moovAssemblyRanges, chunk, chunkOffset, moovLayout) {
  if (!moovLayout?.size || !chunk?.length) {
    return { complete: false, moovAssemblyBuffer, moovAssemblyRanges };
  }

  if (!moovAssemblyBuffer || moovAssemblyBuffer.length !== moovLayout.size) {
    moovAssemblyBuffer = new Uint8Array(moovLayout.size);
    moovAssemblyRanges = [];
  }

  const relativeOffset = chunkOffset - moovLayout.start;
  if (relativeOffset < 0 || relativeOffset >= moovLayout.size) {
    logger.warn(
      `[MP4MoovReassemblerWorker] moov chunk out of range: offset=${chunkOffset}, moovStart=${moovLayout.start}, moovSize=${moovLayout.size}`
    );
    return { complete: false, moovAssemblyBuffer, moovAssemblyRanges };
  }

  const writableLength = Math.min(chunk.length, moovLayout.size - relativeOffset);
  if (writableLength <= 0) {
    return { complete: false, moovAssemblyBuffer, moovAssemblyRanges };
  }

  moovAssemblyBuffer.set(chunk.subarray(0, writableLength), relativeOffset);
  recordWrittenRange(moovAssemblyRanges, relativeOffset, relativeOffset + writableLength);

  if (writableLength < chunk.length) {
    logger.warn(
      `[MP4MoovReassemblerWorker] moov chunk truncated: offset=${chunkOffset}, chunk=${chunk.length}, accepted=${writableLength}, moovSize=${moovLayout.size}`
    );
  }

  const complete = getContiguousWrittenEndFrom(moovAssemblyRanges, 0) >= moovLayout.size;
  return {
    complete,
    chunk: complete ? moovAssemblyBuffer.slice() : null,
    originalOffset: moovLayout.start,
    moovAssemblyBuffer,
    moovAssemblyRanges
  };
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  try {
    if (type === 'resolveMoovLayout') {
      const { fileData, rangeStart, rangeEnd, chunkOffset, chunkLength } = payload;
      const layout = resolveMoovLayout(fileData, rangeStart, rangeEnd, chunkOffset, chunkLength);
      
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: layout
      });
    } else if (type === 'appendMoovChunk') {
      const { moovAssemblyBuffer, moovAssemblyRanges, chunk, chunkOffset, moovLayout } = payload;
      
      const chunkUint8 = new Uint8Array(chunk);
      const result = appendMoovChunkForReassembly(
        moovAssemblyBuffer,
        moovAssemblyRanges || [],
        chunkUint8,
        chunkOffset,
        moovLayout
      );

      const transferList = [];
      if (result.chunk) {
        transferList.push(result.chunk.buffer);
      }
      if (result.moovAssemblyBuffer && result.moovAssemblyBuffer.buffer) {
        transferList.push(result.moovAssemblyBuffer.buffer);
      }

      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: {
          complete: result.complete,
          chunk: result.chunk,
          originalOffset: result.originalOffset,
          moovAssemblyRanges: result.moovAssemblyRanges
        }
      }, transferList);
    } else if (type === 'recordWrittenRange') {
      const { ranges, start, end } = payload;
      const rangesCopy = [...ranges];
      recordWrittenRange(rangesCopy, start, end);
      
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: { ranges: rangesCopy }
      });
    } else if (type === 'getContiguousWrittenEndFrom') {
      const { ranges, start } = payload;
      const end = getContiguousWrittenEndFrom(ranges, start);
      
      self.postMessage({
        id,
        type: 'result',
        success: true,
        data: { end }
      });
    } else {
      throw new Error(`Unknown operation type: ${type}`);
    }
  } catch (error) {
    logger.error(`[MP4MoovReassemblerWorker] Error: ${error.message}`);
    self.postMessage({
      id,
      type: 'result',
      success: false,
      error: error.message || 'Worker processing failed'
    });
  }
};
