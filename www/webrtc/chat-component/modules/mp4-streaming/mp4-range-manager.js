/**
 * MP4 range management module
 * Handles write range recording, merging, and querying
 */

export class MP4RangeManager {
  constructor(receiver) {
    this.receiver = receiver;
    this.logger = receiver.logger;
  }

  /**
   * Get range list for specified phase
   */
  getPhaseRanges(fileData, phase) {
    return fileData?.playbackPlan?.phases?.find(item => item.phase === phase)?.ranges || [];
  }

  /**
   * Record write range
   */
  recordWrittenRange(ranges, start, end) {
    if (!Array.isArray(ranges) || end <= start) {
      return;
    }

    ranges.push({ start, end });
    this.mergeWrittenRanges(ranges);
  }

  /**
   * Merge write ranges
   */
  mergeWrittenRanges(ranges) {
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

  /**
   * Check if range is fully written
   */
  isRangeFullyWritten(ranges, start, end) {
    return ranges.some(range => range.start <= start && range.end >= end);
  }

  /**
   * Get continuous write end position from specified offset
   */
  getContiguousWrittenEndFrom(ranges, start = 0) {
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

  /**
   * Get playable metadata end position
   */
  getPlayableMetadataEnd(fileData) {
    if (!fileData) {
      return 0;
    }

    if (!fileData.needsReassembly) {
      return this.receiver.stateManager.getMetadataEnd(fileData);
    }

    if (!fileData.ftypWritten) {
      return 0;
    }

    let metadataEnd = fileData.ftypSize || 0;
    if (!fileData.moovWritten) {
      return metadataEnd;
    }

    return metadataEnd + (fileData.moovSize || 0);
  }

  /**
   * Get playable continuous end position
   */
  getPlayableContiguousEnd(fileData) {
    if (!fileData) {
      return 0;
    }

    if (!fileData.needsReassembly) {
      return this.getContiguousWrittenEnd(fileData);
    }

    const metadataEnd = this.getPlayableMetadataEnd(fileData);
    if (!metadataEnd || !fileData.moovWritten) {
      return metadataEnd;
    }

    const startupRanges = this.getPhaseRanges(fileData, 'startup');
    if (!startupRanges.length) {
      return metadataEnd;
    }

    let playableEnd = metadataEnd;
    for (const range of startupRanges) {
      const contiguousEnd = this.getContiguousWrittenEndFrom(fileData.writtenRanges, range.start);
      if (contiguousEnd <= range.start) {
        break;
      }

      playableEnd += Math.min(contiguousEnd, range.end) - range.start;
      if (contiguousEnd < range.end) {
        break;
      }
    }

    return playableEnd;
  }

  /**
   * Get continuous write end position
   */
  getContiguousWrittenEnd(fileData) {
    return this.getContiguousWrittenEndFrom(fileData?.writtenRanges || [], 0);
  }
}
