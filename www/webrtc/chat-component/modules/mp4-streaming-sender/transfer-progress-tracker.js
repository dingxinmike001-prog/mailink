/**
 * Transfer Progress Tracker
 * Tracks transfer progress and sends progress updates
 */

export class TransferProgressTracker {
  constructor(sender, uiManager) {
    this.sender = sender;
    this.uiManager = uiManager;
    this.sentRanges = [];
    this.sentUniqueBytes = 0;
    this.lastProgressReportAt = 0;
    this.lastProgressReportBytes = 0;
    this.transferSpeed = 0;
    this.progressReportIntervalMs = 250;
    this.progressReportMinBytes = 256 * 1024; // chunkSize
  }

  /**
   * Record sent range
   * @param {number} start - Start position
   * @param {number} end - End position
   */
  recordSentRange(start, end) {
    if (!(end > start)) {
      return;
    }

    const ranges = [...this.sentRanges, { start, end }].sort((a, b) => a.start - b.start);
    const merged = [];
    let total = 0;

    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (!last || range.start > last.end) {
        const next = { start: range.start, end: range.end };
        merged.push(next);
        total += next.end - next.start;
        continue;
      }

      if (range.end > last.end) {
        total += range.end - last.end;
        last.end = range.end;
      }
    }

    this.sentRanges = merged;
    this.sentUniqueBytes = total;
  }

  /**
   * Build progress snapshot
   * @returns {Object} Progress snapshot
   */
  buildProgressSnapshot() {
    const fileSize = this.sender.file?.size || 0;
    const sentBytes = Math.min(this.sentUniqueBytes, fileSize);
    const progress = fileSize > 0
      ? Math.min(100, Math.round((sentBytes / fileSize) * 100))
      : 0;
    const elapsed = Math.max(1, Date.now() - (this.sender.startTime || Date.now()));
    const transferSpeed = sentBytes > 0 ? sentBytes / (elapsed / 1000) : 0;

    this.transferSpeed = transferSpeed;

    return {
      sentBytes,
      fileSize,
      progress,
      transferSpeed
    };
  }

  /**
   * Update local progress display
   * @param {Object} snapshot - Progress snapshot
   */
  updateLocalProgressDisplay(snapshot) {
    if (!snapshot) {
      return;
    }

    this.uiManager?.updateProgressDisplay(
      this.sender.transferId,
      snapshot.progress,
      snapshot.sentBytes,
      snapshot.fileSize,
      snapshot.transferSpeed
    );
  }

  /**
   * Determine if progress update should be sent
   * @param {Object} snapshot - Progress snapshot
   * @param {boolean} force - Whether to force send
   * @returns {boolean} Whether it should be sent
   */
  shouldSendProgressUpdate(snapshot, force = false) {
    if (force) {
      return true;
    }

    const now = Date.now();
    const bytesDelta = snapshot.sentBytes - this.lastProgressReportBytes;
    const timeDelta = now - this.lastProgressReportAt;

    return bytesDelta >= this.progressReportMinBytes || timeDelta >= this.progressReportIntervalMs;
  }

  /**
   * Send progress update
   * @param {boolean} force - Whether to force send
   */
  async sendProgressUpdate(force = false) {
    if (!this.sender.file || !this.sender.transferId) {
      return;
    }

    const snapshot = this.buildProgressSnapshot();
    this.updateLocalProgressDisplay(snapshot);

    if (!this.shouldSendProgressUpdate(snapshot, force)) {
      return;
    }

    const progressMsg = {
      type: 'file-progress',
      id: this.sender.transferId,
      progress: snapshot.progress,
      receivedSize: snapshot.sentBytes,
      totalSize: snapshot.fileSize,
      chunkSize: this.sender.chunkSize
    };

    if (typeof this.sender.connection.sendDataReliable === 'function') {
      this.sender.connection.sendDataReliable(progressMsg, { timeoutMs: 5000, intervalMs: 50 })
        .catch(error => this.sender.logger.debug('[TransferProgressTracker] send progress failed:', error));
    } else {
      this.sender.connection.sendData(progressMsg);
    }

    // Record sender's sent bytes to local transfer_metadata
    // When loading history after restart, actual progress can be restored from here to avoid showing 0%
    if (this.sender.electronAPI?.updateTransferMetadata) {
      const fileName = this.sender.file.name;
      const storedFileName = this.sender.file._storedFileName || `${this.sender.transferId}-${fileName}`;
      this.sender.electronAPI.updateTransferMetadata({
        msgId: this.sender.transferId,
        fileName: fileName,
        storedFileName: storedFileName,
        totalSize: snapshot.fileSize,
        receivedSize: snapshot.sentBytes,
        status: 'sending',
        userId: this.sender.context.myEmail
      }).catch(err => this.sender.logger.debug('[TransferProgressTracker] savesendprogressfailed:', err));
    }

    this.lastProgressReportAt = Date.now();
    this.lastProgressReportBytes = snapshot.sentBytes;
  }

  /**
   * Reset progress tracker
   */
  reset() {
    this.sentRanges = [];
    this.sentUniqueBytes = 0;
    this.lastProgressReportAt = 0;
    this.lastProgressReportBytes = 0;
    this.transferSpeed = 0;
  }

  /**
   * Get the number of bytes sent
   * @returns {number} Number of bytes sent
   */
  getSentUniqueBytes() {
    return this.sentUniqueBytes;
  }

  /**
   * Get the list of sent ranges
   * @returns {Array} List of sent ranges
   */
  getSentRanges() {
    return [...this.sentRanges];
  }
}
