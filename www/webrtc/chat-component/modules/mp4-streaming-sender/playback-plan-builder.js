/**
 * Playback Plan Builder
 * Responsible for building MP4 playback plans and resume management
 */

export class PlaybackPlanBuilder {
  /**
   * Build playback plan
   * @param {Object} mp4Structure - MP4 structure info
   * @param {File} file - File object
   * @returns {Object} Playback plan
   */
  buildPlaybackPlan(mp4Structure, file) {
    const metadataRanges = mp4Structure?.metadataRanges || [];
    const startupRange = mp4Structure?.startupRange;
    
    // Priority handling: if moov is at tail, special send ordering is needed
    // Ensure moov data is sent before mdat so receiver can play immediately
    const isMoovAtBack = mp4Structure?.moovPosition === 'back';
    
    const occupiedRanges = [
      ...metadataRanges.map(range => ({ start: range.start, end: range.end })),
      startupRange
    ].filter(range => range && range.end > range.start);

    const tailRanges = this.subtractRanges({
      start: 0,
      end: file.size
    }, occupiedRanges).map(range => ({
      ...range,
      chunkType: 'data'
    }));

    // If moov is at tail, reorder tail ranges to ensure continuity with startup
    // This maximizes the playable continuous data range
    let orderedTailRanges = tailRanges;
    if (isMoovAtBack && startupRange) {
      orderedTailRanges = this.optimizeTailRangesForSeek(tailRanges, startupRange, mp4Structure);
    }

    const playbackPlan = {
      phases: [
        {
          phase: 'metadata',
          ranges: metadataRanges.map(range => ({ ...range }))
        },
        {
          phase: 'startup',
          ranges: startupRange && startupRange.end > startupRange.start
            ? [{ ...startupRange, chunkType: 'startup' }]
            : []
        },
        {
          phase: 'tail',
          ranges: orderedTailRanges
        }
      ],
      // Add seeking support info
      seekSupport: {
        isMoovAtBack,
        metadataEnd: isMoovAtBack 
          ? (mp4Structure.ftypSize || 0) + (mp4Structure.moovSize || 0)
          : Math.max(...metadataRanges.map(r => r.end), 0),
        continuousPlaybackStart: isMoovAtBack 
          ? (mp4Structure.ftypSize || 0) + (mp4Structure.moovSize || 0)
          : (startupRange?.start || 0)
      }
    };

    mp4Structure.playbackPlan = playbackPlan;
    return playbackPlan;
  }

  /**
   * Optimize tail range order for better seeking
   * Prioritize sending data continuous with startup range to form larger playable continuous region
   * @param {Array} tailRanges - Tail range list
   * @param {Object} startupRange - Startup range
   * @param {Object} mp4Structure - MP4 structure info
   * @returns {Array} Optimized range list
   */
  optimizeTailRangesForSeek(tailRanges, startupRange, mp4Structure) {
    if (!tailRanges.length || !startupRange) {
      return tailRanges;
    }

    // Find tail range continuous with startup range
    const startupEnd = startupRange.end;
    const continuousRange = tailRanges.find(r => r.start === startupEnd);
    
    if (continuousRange) {
      // Move range continuous with startup to the front
      const otherRanges = tailRanges.filter(r => r.start !== startupEnd);
      return [
        { ...continuousRange, priority: 'high', chunkType: 'data' },
        ...otherRanges.map(r => ({ ...r, chunkType: 'data' }))
      ];
    }

    // If no fully continuous range, sort by start position
    return tailRanges
      .sort((a, b) => a.start - b.start)
      .map(r => ({ ...r, chunkType: 'data' }));
  }

  /**
   * Range subtraction - subtract occupied ranges from full range
   * @param {Object} fullRange - Full range
   * @param {Array} occupiedRanges - Occupied range list
   * @returns {Array} Remaining range list
   */
  subtractRanges(fullRange, occupiedRanges) {
    const sorted = occupiedRanges
      .filter(range => range && range.end > range.start)
      .sort((a, b) => a.start - b.start);

    const result = [];
    let cursor = fullRange.start;

    for (const range of sorted) {
      if (range.start > cursor) {
        result.push({ start: cursor, end: range.start });
      }
      cursor = Math.max(cursor, range.end);
    }

    if (cursor < fullRange.end) {
      result.push({ start: cursor, end: fullRange.end });
    }

    return result;
  }

  /**
   * Build resume state
   * @param {number} startOffset - Start offset
   * @param {Object} mp4Structure - MP4 structure info
   * @returns {Object} Resume state
   */
  buildResumeState(startOffset = 0, mp4Structure) {
    const completedRanges = [];
    if (startOffset > 0) {
      completedRanges.push({ start: 0, end: startOffset });
    }

    if (
      mp4Structure?.moovPosition === 'back' &&
      mp4Structure?.moovRange &&
      startOffset > (mp4Structure.ftypRange?.end ?? mp4Structure.ftypSize ?? 0)
    ) {
      completedRanges.push({ ...mp4Structure.moovRange });
    }

    return {
      globalOffset: startOffset,
      completedRanges: this.mergeRangesForResume(completedRanges)
    };
  }

  /**
   * Merge ranges (for resume)
   * @param {Array} ranges - Range list
   * @returns {Array} Merged range list
   */
  mergeRangesForResume(ranges) {
    if (!Array.isArray(ranges) || !ranges.length) {
      return [];
    }

    const sorted = [...ranges]
      .filter(range => range && range.end > range.start)
      .sort((a, b) => a.start - b.start);
    const merged = [];

    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (!last || range.start > last.end) {
        merged.push({ start: range.start, end: range.end });
        continue;
      }
      last.end = Math.max(last.end, range.end);
    }

    return merged;
  }

  /**
   * Check if range is covered by resume state
   * @param {Object} range - Range
   * @param {Array} completedRanges - Completed range list
   * @returns {boolean} Whether covered
   */
  isRangeCoveredByResume(range, completedRanges = []) {
    return completedRanges.some(item => item.start <= range.start && item.end >= range.end);
  }

  /**
   * Parse resume start point
   * @param {Object} range - Target range
   * @param {Object} resumeState - Resume state
   * @returns {number} Resume start offset
   */
  resolveResumeStartForRange(range, resumeState) {
    if (this.isRangeCoveredByResume(range, resumeState?.completedRanges)) {
      return range.end;
    }

    if (!resumeState?.globalOffset) {
      return range.start;
    }

    if (resumeState.globalOffset <= range.start) {
      return range.start;
    }

    if (resumeState.globalOffset >= range.end) {
      return range.end;
    }

    return resumeState.globalOffset;
  }
}
