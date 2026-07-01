/**
 * File transfer UI state management module
 * Handles updating file request status text
 */

export class StatusHandler {
  constructor(context) {
    this.context = context;
  }

  get logger() { return this.context.logger; }

  isTransferComplete(id) {
    return this.context.ui?.fileTransferUI?._completedTransfers?.has(id) || false;
  }

  updateFileRequestStatus(id, statusMessage) {
    this.logger.info(`[FileTransferUI] updateFileRequestStatus called: id=${id}, status=${statusMessage}`);
    
    if (this.isTransferComplete(id)) {
      this.logger.info(`[FileTransferUI] transfer completed, ignoring status update request: id=${id}, requeststatus=${statusMessage}`);
      return;
    }
    
    const shadowRoot = this.context.shadowRoot;
    let statusEl = null;

    if (shadowRoot) {
      statusEl = shadowRoot.querySelector(`#status-${id}`);
      if (!statusEl) {
        const container = shadowRoot.querySelector(`#file-request-${id}`);
        if (container) {
          statusEl = container.querySelector(`#status-${id}`) || container.querySelector('.file-status');
        }
      }
    }
    this.logger.info(`[FileTransferUI] step 1 search result: statusEl=${statusEl ? 'found' : 'Not found'}`);

    if (!statusEl) {
      statusEl = this.context.root.querySelector(`#status-${id}`);
    }
    this.logger.info(`[FileTransferUI] step 2 search result: statusEl=${statusEl ? 'found' : 'Not found'}`);

    if (!statusEl && shadowRoot) {
      const normalComponents = shadowRoot.querySelectorAll('normal-file-display');
      this.logger.info(`[FileTransferUI] find Web Components: normal-file-display count=${normalComponents.length}`);
      for (const comp of normalComponents) {
        if (comp.shadowRoot) {
          const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
          this.logger.info(`[FileTransferUI] check component: innerContainer=${innerContainer ? 'found' : 'Not found'}`);
          if (innerContainer) {
            statusEl = innerContainer.querySelector(`#status-${id}`) || innerContainer.querySelector('.file-status');
            this.logger.info(`[FileTransferUI] search status element in component: statusEl=${statusEl ? 'found' : 'Not found'}`);
            if (statusEl) break;
          }
        }
      }

      if (!statusEl) {
        const imageComponents = shadowRoot.querySelectorAll('image-file-display');
        this.logger.info(`[FileTransferUI] find Web Components: image-file-display count=${imageComponents.length}`);
        for (const comp of imageComponents) {
          if (comp.shadowRoot) {
            const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
            if (innerContainer) {
              statusEl = innerContainer.querySelector(`#status-${id}`) || innerContainer.querySelector('.file-status');
              if (statusEl) break;
            }
          }
        }
      }

      if (!statusEl) {
        const videoComponents = shadowRoot.querySelectorAll('video-file-display');
        this.logger.info(`[FileTransferUI] find Web Components: video-file-display count=${videoComponents.length}`);
        for (const comp of videoComponents) {
          if (comp.shadowRoot) {
            const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
            if (innerContainer) {
              statusEl = innerContainer.querySelector('.stream-status');
              if (statusEl) break;
            }
          }
        }
      }

      if (!statusEl) {
        const audioComponents = shadowRoot.querySelectorAll('audio-file-display');
        this.logger.info(`[FileTransferUI] find Web Components: audio-file-display count=${audioComponents.length}`);
        for (const comp of audioComponents) {
          if (comp.shadowRoot) {
            const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
            if (innerContainer) {
              statusEl = innerContainer.querySelector(`#status-${id}`) || innerContainer.querySelector('.file-status');
              if (statusEl) break;
            }
          }
        }
      }
    }

    if (statusEl) {
      this.logger.info(`[FileTransferUI] update status text: ${statusMessage}`);
      statusEl.textContent = statusMessage;
    } else {
      this.logger.warn(`[FileTransferUI] status element not found: id=${id}`);
    }
  }
}