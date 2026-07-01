/**
 * File transfer UI action button module
 * Handles showing completion action buttons and hiding accept/reject buttons
 */

import { ContextMenu } from '../../../../components/context-menu/context-menu.js';

export class ActionsHandler {
  constructor(context) {
    this.context = context;
    this._contextMenu = new ContextMenu();
  }

  get logger() { return this.context.logger; }
  get electronAPI() { return window.electronAPI; }

  markTransferComplete(id) {
    this.context.ui?.fileTransferUI?._completedTransfers?.add(id);
    this.logger.info(`[FileTransferUI] markTransfer completed: id=${id}, lockstatus`);
  }

  isTransferComplete(id) {
    return this.context.ui?.fileTransferUI?._completedTransfers?.has(id) || false;
  }

  hideAcceptRejectButtons(id) {
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) return;

    let container = null;
    
    const normalComponents = shadowRoot.querySelectorAll('normal-file-display');
    for (const comp of normalComponents) {
      if (comp.shadowRoot) {
        const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
        if (innerContainer) {
          container = innerContainer;
          break;
        }
      }
    }

    if (!container) {
      const imageComponents = shadowRoot.querySelectorAll('image-file-display');
      for (const comp of imageComponents) {
        if (comp.shadowRoot) {
          const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
          if (innerContainer) {
            container = innerContainer;
            break;
          }
        }
      }
    }

    if (!container) {
      container = shadowRoot.querySelector(`#file-request-${id}`);
    }
    if (!container) {
      const msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
      if (msgContainer) {
        container = msgContainer.querySelector(`#file-request-${id}`);
      }
    }

    if (!container) {
      this.logger.warn(`[FileTransferUI] hideAcceptRejectButtons: container element not found #file-request-${id}`);
      return;
    }

    const fileActions = container.querySelector('.file-actions');
    if (fileActions) {
      fileActions.style.display = 'none';
    }
  }

  showFileCompleteActions(id, filePath) {
    this.logger.info(`[FileTransferUI] showFileCompleteActions called: id=${id}, filePath=${filePath}`);

    if (!filePath) {
      this.logger.error(`[FileTransferUI] filePath is empty, cannot show action buttons: id=${id}`);
      return false;
    }

    if (this.isTransferComplete(id)) {
      this.logger.info(`[FileTransferUI] transfer completed, ignoring showFileCompleteActions: id=${id}`);
      return false;
    }

    this.markTransferComplete(id);
    
    const shadowRoot = this.context.shadowRoot;
    if (!shadowRoot) {
      this.logger.warn(`[FileTransferUI] showFileCompleteActions: shadowRoot does not exist`);
      return false;
    }

    const allNormalComponents = shadowRoot.querySelectorAll('normal-file-display');
    this.logger.info(`[FileTransferUI] found ${allNormalComponents.length}  normal-file-display components`);
    allNormalComponents.forEach((comp, index) => {
      const innerId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
      this.logger.info(`[FileTransferUI] normal-file-display[${index}]: tagName=${comp.tagName}, innerId=${innerId}, expectedid=file-request-${id}`);
    });

    const allElements = shadowRoot.querySelectorAll('*');
    this.logger.info(`[FileTransferUI] shadowRoot has total ${allElements.length} childelement`);
    allElements.forEach((el, index) => {
      if (el.tagName && el.tagName.toLowerCase().includes('file')) {
        this.logger.info(`[FileTransferUI] element[${index}]: tagName=${el.tagName}, id=${el.id}, class=${el.className}`);
      }
    });

    let container = null;
    let isWebComponent = false;
    
    const normalComponents = shadowRoot.querySelectorAll('normal-file-display');
    for (const comp of normalComponents) {
      const innerId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
      if (innerId === `file-request-${id}`) {
        container = comp;
        isWebComponent = true;
        this.logger.info(`[FileTransferUI] found normal-file-display component`);
        break;
      }
    }
    
    if (!container) {
      const imageComponents = shadowRoot.querySelectorAll('image-file-display');
      for (const comp of imageComponents) {
        const innerId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
        if (innerId === `file-request-${id}`) {
          container = comp;
          isWebComponent = true;
          this.logger.info(`[FileTransferUI] found image-file-display component`);
          break;
        }
      }
    }
    
    if (!container) {
      const videoComponents = shadowRoot.querySelectorAll('video-file-display');
      for (const comp of videoComponents) {
        const innerId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
        if (innerId === `file-request-${id}`) {
          container = comp;
          isWebComponent = true;
          this.logger.info(`[FileTransferUI] found video-file-display component`);
          break;
        }
      }
    }
    
    if (!container) {
      const audioComponents = shadowRoot.querySelectorAll('audio-file-display');
      for (const comp of audioComponents) {
        const innerId = comp.shadowRoot?.querySelector('[id^="file-request-"]')?.id;
        if (innerId === `file-request-${id}`) {
          container = comp;
          isWebComponent = true;
          this.logger.info(`[FileTransferUI] found audio-file-display component`);
          break;
        }
      }
    }
    
    if (!container) {
      container = shadowRoot.querySelector(`#file-request-${id}`);
      this.logger.info(`[FileTransferUI] first search #file-request-${id}: ${container ? 'found' : 'Not found'}`);
      
      if (!container) {
        const msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
        if (msgContainer) {
          container = msgContainer.querySelector(`#file-request-${id}`);
          this.logger.info(`[FileTransferUI] search in msgContainer: ${container ? 'found' : 'Not found'}`);
        }
      }
      
      if (!container) {
        const allFileRequests = shadowRoot.querySelectorAll('[id^="file-request-"]');
        this.logger.info(`[FileTransferUI] traversing all file-request elements, total ${allFileRequests.length} `);
        for (const elem of allFileRequests) {
          if (elem.id === `file-request-${id}`) {
            container = elem;
            this.logger.info(`[FileTransferUI] found container by traversal: ${elem.id}`);
            break;
          }
        }
      }
    }
    
    if (!container) {
      this.logger.warn(`[FileTransferUI] showFileCompleteActions: container element not found #file-request-${id}`);
      return false;
    }

    if (isWebComponent) {
      this.logger.info(`[FileTransferUI] calling Web Component showComplete method`);
      try {
        if (container.markTransferComplete) {
          container.markTransferComplete();
          this.logger.info(`[FileTransferUI] markTransferComplete call succeeded`);
        } else {
          this.logger.warn(`[FileTransferUI] markTransferComplete method does not exist`);
        }
        
        if (container.showComplete) {
          container.showComplete(filePath);
          this.logger.info(`[FileTransferUI] showComplete call succeeded, filePath=${filePath}`);
        } else {
          this.logger.warn(`[FileTransferUI] showComplete method does not exist`);
        }
      } catch (error) {
        this.logger.error(`[FileTransferUI] calling Web Component method failed:`, error);
      }
      return true;
    }

    const hasFileRequestClass = container.classList.contains('file-request');
    this.logger.info(`[FileTransferUI] container className: ${container.className}, whether it has file-request class: ${hasFileRequestClass}`);
    
    if (!hasFileRequestClass) {
      container.classList.add('file-request');
      this.logger.info(`[FileTransferUI] added file-request class to container`);
    }

    container.classList.add('transfer-completed');
    this.logger.info(`[FileTransferUI] added transfer-completed class to container, currentclass name: ${container.className}`);

    container.dataset.filePath = filePath;
    this.logger.info(`[FileTransferUI] set data-file-path: ${filePath}`);

    const progressContainer = container.querySelector('.progress-container');
    const fileStatus = container.querySelector('.file-status');

    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    if (fileStatus) {
      fileStatus.style.display = 'none';
    }

    let actionsContainer = container.querySelector('.file-complete-actions');
    if (!actionsContainer) {
      actionsContainer = document.createElement('div');
      actionsContainer.className = 'file-complete-actions';
      container.appendChild(actionsContainer);
      this.logger.info(`[FileTransferUI] create new file-complete-actions container`);
    } else {
      this.logger.info(`[FileTransferUI] found existing file-complete-actions container`);
    }

    actionsContainer.innerHTML = '';

    const openFolderBtn = document.createElement('button');
    openFolderBtn.className = 'open-folder-btn';
    openFolderBtn.dataset.filePath = filePath;
    openFolderBtn.textContent = 'Open folder';

    const saveAsBtn = document.createElement('button');
    saveAsBtn.className = 'save-as-btn';
    saveAsBtn.dataset.filePath = filePath;
    saveAsBtn.textContent = 'Save as';

    actionsContainer.appendChild(openFolderBtn);
    actionsContainer.appendChild(saveAsBtn);

    this.logger.info(`[FileTransferUI] button created@:  openFolderBtn=${!!openFolderBtn}, saveAsBtn=${!!saveAsBtn}`);

    if (openFolderBtn) {
      openFolderBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.logger.info(`[FileTransferUI] Open folder button clicked: filePath=${filePath}`);
        this.logger.info(`[FileTransferUI] electronAPI @: `, !!this.electronAPI);
        this.logger.info(`[FileTransferUI] showItemInFolder @: `, !!(this.electronAPI && this.electronAPI.showItemInFolder));
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

    if (saveAsBtn) {
      saveAsBtn.addEventListener('click', () => {
        this.logger.info(`[FileTransferUI] Save as button clicked: id=${id}, filePath=${filePath}`);
        this.context.ui?.fileTransferUI?.handleSaveAs?.(id, filePath);
      });
    }
    
    this.logger.info(`[FileTransferUI] file action buttons shown: id=${id}, container structureverify: file-request=${container.classList.contains('file-request')}, actions=${!!actionsContainer}`);
    return true;
  }
}