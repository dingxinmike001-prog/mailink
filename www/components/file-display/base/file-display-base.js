/**
 * File display component base abstract class
 * all concrete file display components must inherit this class
 */

import { ContextMenu } from '../../context-menu/context-menu.js';

export class FileDisplayBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._offer = null;
    this._isSender = false;
    this._filePath = null;
    this._context = null;
    this._rendered = false;
    this._transferCompleted = false;
    this._contextMenu = new ContextMenu();
  }

  // Static property: component name
  static get componentName() {
    throw new Error('Subclass must implement componentName property');
  }

  // Static property: supported MIME types
  static get supportedMimeTypes() {
    return [];
  }

  // Observed attributes
  static get observedAttributes() {
    return ['offer', 'is-sender', 'file-path'];
  }

  // Set context (used to get logger, utils, etc.)
  setContext(context) {
    this._context = context;
  }

  // Get logger
  get logger() {
    return this._context?.logger || console;
  }

  // Get utils
  get utils() {
    return this._context?.utils;
  }

  // Get electronAPI
  get electronAPI() {
    return window.electronAPI;
  }

  // Attribute changed callback
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    this.logger?.info?.(`[FileDisplayBase] attributeChangedCallback: ${name} = ${newValue?.substring(0, 50)}...`);

    switch (name) {
      case 'offer':
        try {
          this._offer = JSON.parse(newValue);
          this.logger?.info?.(`[FileDisplayBase] offer parsed successfully: id=${this._offer?.id}`);
        } catch (e) {
          this.logger?.error?.('[FileDisplayBase] Failed to parse offer:', e);
          this._offer = null;
        }
        break;
      case 'is-sender':
        this._isSender = newValue === 'true';
        break;
      case 'file-path':
        this._filePath = newValue;
        break;
    }
    // Only re-render if already rendered
    if (this._rendered) {
      this.logger?.info?.(`[FileDisplayBase] Triggering re-render`);
      this.render();
    }
  }

  // Connected callback
  connectedCallback() {
    this.logger?.info?.(`[FileDisplayBase] connectedCallback: _rendered=${this._rendered}, _offer=${this._offer?.id}`);
    if (!this._rendered) {
      this.render();
      this._rendered = true;
    }
  }

  // Abstract method: render component (subclasses must implement)
  render() {
    throw new Error('Subclass must implement render method');
  }

  // Abstract method: update progress (subclasses may implement)
  updateProgress(progress, receivedSize, totalSize, transferSpeed) {
    // default implementation is empty
  }

  // Abstract method: show complete status (subclasses may implement)
  showComplete(filePath) {
    // default implementation is empty
  }

  // Mark transfer as complete
  markTransferComplete() {
    this._transferCompleted = true;
    const fileRequest = this.shadowRoot?.querySelector('.file-request');
    if (fileRequest) {
      fileRequest.classList.add('transfer-completed');
      this.logger?.info?.(`[FileDisplayBase] Transfer marked as complete: id=${this._offer?.id}, fileRequest className: ${fileRequest.className}`);
    } else {
      this.logger?.warn?.(`[FileDisplayBase] .file-request element not found: id=${this._offer?.id}`);
    }
  }

  // Check whether transfer is complete
  isTransferComplete() {
    return this._transferCompleted;
  }

  // Utility method: format file size
  formatFileSize(bytes) {
    return this.utils?.formatBytes(bytes) || `${bytes} bytes`;
  }

  // Utility method: get HTTP server port
  async getHttpServerPort() {
    if (this.electronAPI?.getHttpServerPort) {
      try {
        const result = await this.electronAPI.getHttpServerPort();
        if (result?.success && result.port > 0) {
          return result.port;
        }
      } catch (e) {
        this.logger.warn?.(`[FileDisplayBase] Port retrieval exception: ${e.message}`);
      }
    }
    return 8080; // Default port
  }

  // Utility method: generate file URL
  async getFileUrl(fileName, isSender) {
    const port = await this.getHttpServerPort();
    const directory = isSender ? 'sends' : 'recvs';
    const username = this._context?.myEmail || '';
    
    // New format: /{username}/files/{recvs|sends}/{filename}
    return `http://127.0.0.1:${port}/${username}/files/${directory}/${encodeURIComponent(fileName)}`;
  }

  /**
   * Show context menu
   * @param {MouseEvent} event - mouse event
   */
  showContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();

    this.logger?.info?.(`[FileDisplayBase] Context menu triggered: _transferCompleted=${this._transferCompleted}, _filePath=${this._filePath}`);

    // Only show context menu after transfer completes
    if (!this._transferCompleted || !this._filePath) {
      this.logger?.info?.(`[FileDisplayBase] Transfer not complete or file path empty, not showing context menu: _transferCompleted=${this._transferCompleted}, _filePath=${this._filePath}`);
      return;
    }

    const menuItems = [
      { label: window.i18n?.t ? window.i18n.t('common.openFolder') : 'Open Folder', action: 'open-folder' },
      { label: window.i18n?.t ? window.i18n.t('common.saveAs') : 'Save As', action: 'save-as' }
    ];

    const context = {
      filePath: this._filePath,
      offer: this._offer,
      isSender: this._isSender
    };

    this.logger?.info?.(`[FileDisplayBase] Preparing to show context menu: filePath=${this._filePath}, menu item count=${menuItems.length}`);

    this._contextMenu.show(event.clientX, event.clientY, menuItems, context);
    this._contextMenu.setOnMenuAction((action, ctx) => {
      this.handleContextMenuAction(action, ctx);
    });

    this.logger?.info?.(`[FileDisplayBase] Context menu shown: filePath=${this._filePath}`);
  }

  /**
   * Handle context menu action
   * @param {string} action - action type
   * @param {Object} context - context data
   */
  async handleContextMenuAction(action, context) {
    this.logger?.info?.(`[FileDisplayBase] Context menu action: ${action}, filePath=${context.filePath}`);

    switch (action) {
      case 'open-folder':
        await this.handleOpenFolder(context.filePath);
        break;
      case 'save-as':
        await this.handleSaveAs(context.filePath);
        break;
    }
  }

  /**
   * Handle open folder action
   * @param {string} filePath - file path
   */
  async handleOpenFolder(filePath) {
    try {
      this.logger?.info?.(`[FileDisplayBase] handleOpenFolder: filePath=${filePath}`);

      if (!this.electronAPI || !this.electronAPI.showItemInFolder) {
        this.logger?.warn?.('[FileDisplayBase] showItemInFolder API unavailable');
        return;
      }

      const result = await this.electronAPI.showItemInFolder(filePath);
      this.logger?.info?.(`[FileDisplayBase] showItemInFolder result:`, result);
    } catch (error) {
      this.logger?.error?.(`[FileDisplayBase] Failed to open folder:`, error);
    }
  }

  /**
   * Handle save-as action
   * @param {string} sourcePath - source file path
   */
  async handleSaveAs(sourcePath) {
    try {
      this.logger?.info?.(`[FileDisplayBase] handleSaveAs: sourcePath=${sourcePath}`);

      if (!this.electronAPI || !this.electronAPI.showSaveDialog) {
        this.logger?.warn?.('[FileDisplayBase] showSaveDialog API unavailable');
        return;
      }

      const fileName = sourcePath ? sourcePath.split(/[/\\]/).pop() : 'unknown';
      this.logger?.info?.(`[FileDisplayBase] Default filename: ${fileName}`);

      const result = await this.electronAPI.showSaveDialog({
        defaultPath: fileName,
        filters: [
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      this.logger?.info?.(`[FileDisplayBase] showSaveDialog result:`, result);

      if (result && !result.canceled && result.filePath) {
        if (this.electronAPI && this.electronAPI.copyFile) {
          this.logger?.info?.(`[FileDisplayBase] Calling copyFile: ${sourcePath} -> ${result.filePath}`);
          const copyResult = await this.electronAPI.copyFile(sourcePath, result.filePath);
          if (copyResult && copyResult.success) {
            this.logger?.info?.(`[FileDisplayBase] File saved as successfully: ${result.filePath}`);
          } else {
            this.logger?.error?.(`[FileDisplayBase] Failed to save file as:`, copyResult?.error);
          }
        }
      }
    } catch (error) {
      this.logger?.error?.(`[FileDisplayBase] Save-as operation failed:`, error);
    }
  }
}
