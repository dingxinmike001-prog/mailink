/**
 * File transfer UI event binding module
 * Handles event listener binding and rebinding
 */

export class EventsHandler {
  constructor(context) {
    this.context = context;
    this._contextMenu =
      this.context.ui?.fileTransferUI?._contextMenu ||
      this.context.uiRenderer?.fileTransferUI?._contextMenu ||
      this.context.fileTransferManager?.uiManager?._contextMenu;
  }

  get logger() { return this.context.logger; }
  get electronAPI() { return window.electronAPI; }
  get fileTransferUI() {
    return (
      this.context.ui?.fileTransferUI ||
      this.context.uiRenderer?.fileTransferUI ||
      this.context.fileTransferManager?.uiManager
    );
  }
  get contextMenu() {
    return this._contextMenu || this.fileTransferUI?._contextMenu;
  }

  handleFileAction(transferId, action, filePath) {
    if (this.fileTransferUI?.handleFileAction) {
      return this.fileTransferUI.handleFileAction(transferId, action, filePath);
    }

    // Last-resort fallback to avoid losing accept/reject actions if the UI alias
    // has not been attached yet.
    if (this.context.eventBus && transferId) {
      if (action === 'accept') {
        this.context.eventBus.emit('file-transfer:accept', { transferId });
        return;
      }
      if (action === 'reject') {
        this.context.eventBus.emit('file-transfer:reject', { transferId });
        return;
      }
    }

    this.logger?.warn?.(`[FileTransferUI] handleFileAction fallback failed: transferId=${transferId}, action=${action}`);
  }

  rebindFileTransferEvents(container) {
    if (!container) return;

    this.logger.info(`[FileTransferUI] rebindFileTransferEvents: container=${container.tagName || container.nodeName}`);

    const isWebComponent = container.tagName === 'NORMAL-FILE-DISPLAY' ||
                           container.tagName === 'IMAGE-FILE-DISPLAY' ||
                           container.tagName === 'VIDEO-FILE-DISPLAY' ||
                           container.tagName === 'AUDIO-FILE-DISPLAY';

    if (isWebComponent) {
      this._bindComponentAction(container);
      return;
    }

    const components = container.querySelectorAll('normal-file-display, image-file-display, video-file-display, audio-file-display');
    if (components.length > 0) {
      this.logger.info(`[FileTransferUI] rebindFileTransferEvents: found ${components.length}  internal Web Components`);
      components.forEach(comp => this._bindComponentAction(comp));
      return;
    }

    const acceptBtns = container.querySelectorAll('.accept-btn');
    this.logger.info(`[FileTransferUI] rebindFileTransferEvents: found ${acceptBtns.length}  traditional accept buttons`);
    
    acceptBtns.forEach(btn => {
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      const transferId = newBtn.dataset.transferId;
      if (transferId) {
        newBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.logger.info(`[FileTransferUI] history message accept button clicked: transferId=${transferId}`);
          this.handleFileAction(transferId, 'accept');
        });
      }
    });

    const rejectBtns = container.querySelectorAll('.reject-btn');
    rejectBtns.forEach(btn => {
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      const transferId = newBtn.dataset.transferId;
      if (transferId) {
        newBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.logger.info(`[FileTransferUI] history message reject button clicked: transferId=${transferId}`);
          this.handleFileAction(transferId, 'reject');
        });
      }
    });

    const openFolderBtns = container.querySelectorAll('.open-folder-btn');
    openFolderBtns.forEach(btn => {
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      const filePath = newBtn.dataset.filePath;
      if (filePath) {
        newBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.logger.info(`[FileTransferUI] history message Open folder button clicked: filePath=${filePath}`);
          if (this.electronAPI && this.electronAPI.showItemInFolder) {
            this.electronAPI.showItemInFolder(filePath).then(result => {
              this.logger.info(`[FileTransferUI] showItemInFolder result:`, result);
            }).catch(err => {
              this.logger.error(`[FileTransferUI] showItemInFolder error:`, err);
            });
          } else {
            this.logger.error(`[FileTransferUI] electronAPI.showItemInFolder unavailable`);
          }
        });
      }
    });

    const saveAsBtns = container.querySelectorAll('.save-as-btn');
    saveAsBtns.forEach(btn => {
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      const filePath = newBtn.dataset.filePath;
      if (filePath) {
        newBtn.addEventListener('click', () => {
          this.logger.info(`[FileTransferUI] history message Save as button clicked: filePath=${filePath}`);
          this.context.ui?.fileTransferUI?.handleSaveAs?.(null, filePath);
        });
      }
    });

    const imageMessages = container.querySelectorAll('.image-message img');
    imageMessages.forEach(img => {
      const newImg = img.cloneNode(true);
      img.parentNode.replaceChild(newImg, img);

      const imgSrc = newImg.dataset.originalSrc || newImg.src;
      if (imgSrc) {
        newImg.addEventListener('click', () => {
          this.logger.info(`[FileTransferUI] history message image clicked: src=${imgSrc}`);
          window.open(imgSrc, '_blank');
        });
        newImg.style.cursor = 'pointer';
      }

      if (newImg.dataset.originalSrc && !newImg._thumbnailFallbackSetup) {
        newImg._thumbnailFallbackSetup = true;
        newImg.addEventListener('error', function onThumbError() {
          if (this.dataset.originalSrc && this.src !== this.dataset.originalSrc && !this._fb) {
            this._fb = 1;
            this.src = this.dataset.originalSrc;
          } else {
            this.removeEventListener('error', onThumbError);
          }
        });
      }
    });

    const fileRequests = container.querySelectorAll('.file-request');
    fileRequests.forEach(fileRequest => {
      if (fileRequest._hasContextMenuListener) {
        return;
      }

      fileRequest.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        
        let filePath = fileRequest.dataset.filePath;
        this.logger.info(`[FileTransferUI] traditional HTML context menu triggered: filePath=${filePath}`);

        if (!filePath) {
          const safeDecode = (value) => {
            try {
              return decodeURIComponent(value);
            } catch (err) {
              return value;
            }
          };

          const fileRequestId = fileRequest.id || '';
          const transferId = fileRequestId.startsWith('file-request-')
            ? fileRequestId.slice('file-request-'.length)
            : '';
          const nameFromDom = (fileRequest.querySelector('.file-name')?.textContent ||
            fileRequest.querySelector('img')?.getAttribute('alt') ||
            '').trim();
          const storedFilename = fileRequest.dataset.storedFilename || fileRequest.dataset.storedFileName || nameFromDom;
          const isSenderStr = fileRequest.dataset.isSender;
          let isSender = isSenderStr === 'true';

          if (!isSenderStr) {
            const msgContainer = fileRequest.closest('.message-container');
            if (msgContainer && msgContainer.classList.contains('message-sent')) {
              isSender = true;
            }
          }

          if (this.electronAPI && this.electronAPI.getSentFilePath) {
            const candidates = [];
            if (storedFilename) {
              candidates.push(safeDecode(storedFilename));
            }
            if (transferId && storedFilename) {
              candidates.push(`${transferId}-${safeDecode(storedFilename)}`);
            }
            if (transferId) {
              candidates.push(transferId);
            }
            if (nameFromDom && !candidates.includes(nameFromDom)) {
              candidates.push(nameFromDom);
            }

            const userId = this.context.myEmail;
            for (const name of candidates) {
              try {
                const res = await this.electronAPI.getSentFilePath(name, isSender, userId);
                if (res && res.success && res.filePath) {
                  filePath = res.filePath;
                  fileRequest.dataset.filePath = filePath;
                  if (storedFilename) {
                    fileRequest.dataset.storedFilename = storedFilename;
                  }
                  this.logger.info(`[FileTransferUI] got file path: ${filePath}`);
                  break;
                }
              } catch (err) {
                this.logger.error(`[FileTransferUI] error getting file path:`, err);
              }
            }
          }
        }

        if (!filePath) {
          this.logger.warn(`[FileTransferUI] traditional HTML context menu: filePath is empty and dynamic fetch failed, do not show menu`);
          return;
        }

        const menuItems = [
          { label: 'Open folder', action: 'open-folder' },
          { label: 'Save as', action: 'save-as' }
        ];

        this.contextMenu?.show(e.clientX, e.clientY, menuItems, { filePath });
        this.contextMenu?.setOnMenuAction((action, ctx) => {
          this.logger.info(`[FileTransferUI] traditional HTML context menu action: ${action}, filePath=${ctx.filePath}`);
          
          switch (action) {
            case 'open-folder':
              if (this.electronAPI && this.electronAPI.showItemInFolder) {
                this.electronAPI.showItemInFolder(ctx.filePath).then(result => {
                  this.logger.info(`[FileTransferUI] showItemInFolder result:`, result);
                }).catch(err => {
                  this.logger.error(`[FileTransferUI] showItemInFolder error:`, err);
                });
              }
              break;
            case 'save-as':
              this.context.ui?.fileTransferUI?.handleSaveAs?.(null, ctx.filePath);
              break;
          }
        });
      });

      fileRequest._hasContextMenuListener = true;
      this.logger.info(`[FileTransferUI] bound context menu event for traditional HTML file request`);

      const isNormalFile = !fileRequest.classList.contains('image-message') && 
                           !fileRequest.classList.contains('streaming-video-message');
      if (isNormalFile && !fileRequest._hasClickListener) {
        fileRequest.addEventListener('click', async (e) => {
          if (e.target.tagName === 'BUTTON') return;

          let filePath = fileRequest.dataset.filePath;
          if (!filePath) {
            const safeDecode = (value) => {
              try {
                return decodeURIComponent(value);
              } catch (err) {
                return value;
              }
            };

            const fileRequestId = fileRequest.id || '';
            const transferId = fileRequestId.startsWith('file-request-')
              ? fileRequestId.slice('file-request-'.length)
              : '';
            const nameFromDom = (fileRequest.querySelector('.file-name')?.textContent || '').trim();
            const storedFilename = fileRequest.dataset.storedFilename || fileRequest.dataset.storedFileName || nameFromDom;
            const isSenderStr = fileRequest.dataset.isSender;
            let isSender = isSenderStr === 'true';

            if (!isSenderStr) {
              const msgContainer = fileRequest.closest('.message-container');
              if (msgContainer && msgContainer.classList.contains('message-sent')) {
                isSender = true;
              }
            }

            if (this.electronAPI && this.electronAPI.getSentFilePath) {
              const candidates = [];
              if (storedFilename) {
                candidates.push(safeDecode(storedFilename));
              }
              if (transferId && storedFilename) {
                candidates.push(`${transferId}-${safeDecode(storedFilename)}`);
              }
              if (transferId) {
                candidates.push(transferId);
              }
              if (nameFromDom && !candidates.includes(nameFromDom)) {
                candidates.push(nameFromDom);
              }

              const userId = this.context.myEmail;
              for (const name of candidates) {
                try {
                  const res = await this.electronAPI.getSentFilePath(name, isSender, userId);
                  if (res && res.success && res.filePath) {
                    filePath = res.filePath;
                    fileRequest.dataset.filePath = filePath;
                    break;
                  }
                } catch (err) {
                  this.logger.error(`[FileTransferUI] getSentFilePath error:`, err);
                }
              }
            }
          }

          if (!filePath) {
            this.logger.warn(`[FileTransferUI] left click to open file: filePath is empty and dynamic fetch failed, do not open file`);
            return;
          }

          this.logger.info(`[FileTransferUI] left click to open file: filePath=${filePath}`);
          if (this.electronAPI && this.electronAPI.openFile) {
            const result = await this.electronAPI.openFile(filePath);
            this.logger.info(`[FileTransferUI] openFile result:`, result);
          } else {
            this.logger.error(`[FileTransferUI] electronAPI.openFile unavailable`);
          }
        });

        fileRequest._hasClickListener = true;
        this.logger.info(`[FileTransferUI] bound left-click event for traditional HTML normal file request`);
      }
    });
  }

  _bindComponentAction(component) {
    if (!component) return;
    
    this.logger.info(`[FileTransferUI] for component ${component.tagName} bind file-action listener`);
    
    component.addEventListener('file-action', (e) => {
      const { transferId, action, filePath } = e.detail;
      this.logger.info(`[FileTransferUI] Web Component triggered file-action: transferId=${transferId}, action=${action}, filePath=${filePath}`);
      this.handleFileAction(transferId, action, filePath);
    });

    this._rebindContextMenu(component);
  }

  _rebindContextMenu(component) {
    if (!component || !component.shadowRoot) return;

    if (component._contextMenuBound) {
      this.logger.info(`[FileTransferUI] component ${component.tagName} context menu already bound, skip`);
      return;
    }

    this.logger.info(`[FileTransferUI] for component ${component.tagName} rebind context menu event`);

    const fileRequest = component.shadowRoot.querySelector('.file-request');
    if (fileRequest) {
      fileRequest.addEventListener('contextmenu', (e) => {
        this.logger.info(`[FileTransferUI] component ${component.tagName} context menu event triggered`);
        if (component.showContextMenu) {
          component.showContextMenu(e);
        } else {
          this.logger.warn(`[FileTransferUI] component ${component.tagName} no showContextMenu method`);
        }
      });

      this.logger.info(`[FileTransferUI] for component ${component.tagName} bind context menu event`);
    }

    const imageMessage = component.shadowRoot.querySelector('.image-message');
    if (imageMessage && imageMessage !== fileRequest) {
      imageMessage.addEventListener('contextmenu', (e) => {
        this.logger.info(`[FileTransferUI] component ${component.tagName} image element context menu event triggered`);
        if (component.showContextMenu) {
          component.showContextMenu(e);
        } else {
          this.logger.warn(`[FileTransferUI] component ${component.tagName} no showContextMenu method`);
        }
      });

      this.logger.info(`[FileTransferUI] for component ${component.tagName}  image element bound context menu event`);
    }

    component._contextMenuBound = true;
  }
}
