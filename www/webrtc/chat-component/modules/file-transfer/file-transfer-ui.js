/**
 * File transfer UI rendering module
 * Handles all UI-related rendering and updates
 *
 * Integrated file display component library, supports independent components for regular files, images, and videos
 */

import { ProgressHandler } from './ui-progress.js';
import { StatusHandler } from './ui-status.js';
import { ActionsHandler } from './ui-actions.js';
import { EventsHandler } from './ui-events.js';
import { FileOpsHandler } from './ui-file-ops.js';
import { RendererHandler } from './ui-renderer.js';
import { UpdaterHandler } from './ui-updater.js';
import { AttachmentHandler } from './ui-attachments.js';
import { ContextMenu } from '../../../../components/context-menu/context-menu.js';

export class FileTransferUIManager {
  constructor(context) {
    this.context = context;
    this._completedTransfers = new Set();
    this._contextMenu = new ContextMenu();

    this.progressHandler = new ProgressHandler(context);
    this.statusHandler = new StatusHandler(context);
    this.actionsHandler = new ActionsHandler(context);
    this.eventsHandler = new EventsHandler(context);
    this.fileOpsHandler = new FileOpsHandler(context);
    this.rendererHandler = new RendererHandler(context);
    this.updaterHandler = new UpdaterHandler(context);
    this.attachmentHandler = new AttachmentHandler(context);

    this._registerComponents();
  }

  get logger() { return this.context.logger; }
  get utils() { return this.context.utils; }
  get electronAPI() { return window.electronAPI; }

  markTransferComplete(id) {
    this._completedTransfers.add(id);
    this.logger.info(`[FileTransferUI] markTransfer completed: id=${id}, lockstatus`);
  }

  isTransferComplete(id) {
    return this._completedTransfers.has(id);
  }

  async _registerComponents() {
    try {
      await this.rendererHandler._registerComponents();
      this.logger.info?.('[FileTransferUI] file display component registration succeeded');
    } catch (error) {
      this.logger.error?.('[FileTransferUI] file display component registration failed:', error);
    }
  }

  showTransferProgress(filename, size, id, replaceExisting = false, targetEmail) {
    return this.progressHandler.showTransferProgress(filename, size, id, replaceExisting, targetEmail);
  }

  updateProgressDisplay(id, progress, receivedSize, totalSize, transferSpeed, customText) {
    return this.progressHandler.updateProgressDisplay(id, progress, receivedSize, totalSize, transferSpeed, customText);
  }

  showTransferInterrupted(id, receivedSize, totalSize, isSender = true) {
    return this.progressHandler.showTransferInterrupted(id, receivedSize, totalSize, isSender);
  }

  updateFileRequestStatus(id, statusMessage) {
    return this.statusHandler.updateFileRequestStatus(id, statusMessage);
  }

  hideAcceptRejectButtons(id) {
    return this.actionsHandler.hideAcceptRejectButtons(id);
  }

  showFileCompleteActions(id, filePath) {
    return this.actionsHandler.showFileCompleteActions(id, filePath);
  }

  rebindFileTransferEvents(container) {
    return this.eventsHandler.rebindFileTransferEvents(container);
  }

  _bindComponentAction(component) {
    return this.eventsHandler._bindComponentAction(component);
  }

  _rebindContextMenu(component) {
    return this.eventsHandler._rebindContextMenu(component);
  }

  handleOpenFolder(id, filePath) {
    return this.fileOpsHandler.handleOpenFolder(id, filePath);
  }

  handleSaveAs(id, sourcePath) {
    return this.fileOpsHandler.handleSaveAs(id, sourcePath);
  }

  renderFileRequestMessage(offer, isSender = false, autoAccepted = false) {
    return this.rendererHandler.renderFileRequestMessage(offer, isSender, autoAccepted);
  }

  _renderFileRequestMessageLegacy(offer, isSender = false, autoAccepted = false) {
    return this.rendererHandler._renderFileRequestMessageLegacy(offer, isSender, autoAccepted);
  }

  handleFileAction(transferId, action, filePath) {
    this.logger.info(`[FileTransferUI] handleFileAction: transferId=${transferId}, action=${action}, filePath=${filePath}`);
    
    if (!this.context.eventBus) {
      this.logger.error(`[FileTransferUI] handleFileAction: eventBus does not exist, unable toemit event`);
      return;
    }

    switch (action) {
      case 'accept':
        this.logger.info(`[FileTransferUI] trigger file-transfer:accept event: ${transferId}`);
        this.context.eventBus.emit('file-transfer:accept', { transferId });
        break;
      case 'reject':
        this.logger.info(`[FileTransferUI] trigger file-transfer:reject event: ${transferId}`);
        this.context.eventBus.emit('file-transfer:reject', { transferId });
        break;
      case 'open-folder':
        if (filePath) {
          this.handleOpenFolder(transferId, filePath);
        }
        break;
      case 'save-as':
        if (filePath) {
          this.handleSaveAs(transferId, filePath);
        }
        break;
    }
  }

  renderImageDisplay(offer, isSender, filePath = null) {
    return this.rendererHandler.renderImageDisplay(offer, isSender, filePath);
  }

  _renderImageDisplayLegacy(offer, isSender, filePath = null) {
    return this.rendererHandler._renderImageDisplayLegacy(offer, isSender, filePath);
  }

  updateMessageToImageDisplayWithHtml(id, imageHtml, isSender = false, filePath = null) {
    return this.updaterHandler.updateMessageToImageDisplayWithHtml(id, imageHtml, isSender, filePath);
  }

  updateMessageToImageDisplay(id, offer, isSender, filePath = null) {
    return this.updaterHandler.updateMessageToImageDisplay(id, offer, isSender, filePath);
  }

  updateVideoPlayStatus(transferId, canPlay, percent, receivedSize) {
    return this.updaterHandler.updateVideoPlayStatus(transferId, canPlay, percent, receivedSize);
  }

  showAttachment(file, from) {
    return this.attachmentHandler.showAttachment(file, from);
  }

  updateStagedFileUI(stagedFile, previewUrl, clearCallback) {
    return this.attachmentHandler.updateStagedFileUI(stagedFile, previewUrl, clearCallback);
  }

  removeMessageFromUI(msgId) {
    return this.attachmentHandler.removeMessageFromUI(msgId);
  }

  isMessageDisplayed(msgId) {
    return this.attachmentHandler.isMessageDisplayed(msgId);
  }

  renderStreamingVideoMessage(offer, isSender = false) {
    return this.rendererHandler.renderStreamingVideoMessage(offer, isSender);
  }

  _renderStreamingVideoMessageLegacy(offer, isSender = false) {
    return this.rendererHandler._renderStreamingVideoMessageLegacy(offer, isSender);
  }

  renderFileComponentFromHistory(offer, isSender, filePath = null) {
    return this.rendererHandler.renderFileComponentFromHistory(offer, isSender, filePath);
  }
}