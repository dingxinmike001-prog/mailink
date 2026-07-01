/**
 * File transfer UI progress display module
 * Handles displaying transfer progress, updating progress bars, and showing interrupted state
 */

export class ProgressHandler {
  constructor(context) {
    this.context = context;
  }

  get logger() { return this.context.logger; }
  get utils() { return this.context.utils; }

  isTransferComplete(id) {
    return this.context.ui?.fileTransferUI?._completedTransfers?.has(id) || false;
  }

  showTransferProgress(filename, size, id, replaceExisting = false, targetEmail) {
    const chatDisplay = this.context.ui.chatDisplay;
    if (!chatDisplay) return;

    const shadowRoot = this.context.shadowRoot;
    let existingRequest = shadowRoot ? shadowRoot.querySelector(`#file-request-${id}`) : null;
    if (!existingRequest) {
      existingRequest = this.context.root.querySelector(`#file-request-${id}`);
    }
    
    if (replaceExisting && existingRequest) {
      const statusEl = existingRequest.querySelector('.file-status');
      const progressBar = existingRequest.querySelector('.progress-bar');
      const progressContainer = existingRequest.querySelector('.progress-container');
      const fileActions = existingRequest.querySelector('.file-actions');
      
      if (statusEl) statusEl.textContent = 'Accepted, transferring...';
      if (progressBar) {
        progressBar.style.width = '0%';
        progressBar.textContent = '0%';
      }
      if (progressContainer) progressContainer.style.display = 'block';
      if (fileActions) fileActions.style.display = 'none';
      
      chatDisplay.scrollTop = chatDisplay.scrollHeight;
      return;
    }
    
    if (replaceExisting && !existingRequest) {
      return;
    }

    const progressDiv = document.createElement('div');
    progressDiv.className = 'file-transfer-progress';
    progressDiv.innerHTML = `
      <div class="file-info">
        <span class="file-name">${filename}</span>
        <span class="file-size">${this.utils.formatBytes(size)}</span>
      </div>
      <div class="progress-bar-container">
        <div id="progress-${id}" class="progress-bar" style="width: 0%">0%</div>
      </div>
      <div id="status-${id}" class="transfer-status">preparereceive...</div>
    `;
    
    const msgContainer = document.createElement('div');
    msgContainer.className = 'message-container message-received';
    
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar avatar';
    avatarDiv.dataset.email = targetEmail || ''; 
    avatarDiv.textContent = 'Peer';
    
    if (this.context.avatarManager) {
        this.context.avatarManager.getAvatar(targetEmail).then(avatar => {
             avatarDiv.innerHTML = this.context.avatarManager.buildAvatarHtml(avatar);
        }).catch(() => {});
    }

    const msgContent = document.createElement('div');
    msgContent.className = 'message-content';
    msgContent.appendChild(progressDiv);

    msgContainer.appendChild(avatarDiv);
    msgContainer.appendChild(msgContent);
    
    chatDisplay.appendChild(msgContainer);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
  }

  updateProgressDisplay(id, progress, receivedSize, totalSize, transferSpeed, customText) {
    if (this.isTransferComplete(id)) {
      return;
    }

    const normalizedReceivedSize = typeof receivedSize === 'number' ? receivedSize : Number(receivedSize) || 0;
    const normalizedTotalSize = typeof totalSize === 'number' ? totalSize : Number(totalSize) || 0;
    const normalizedProgress = typeof progress === 'number'
      ? progress
      : (normalizedTotalSize > 0 ? Math.min(100, Math.round((normalizedReceivedSize / normalizedTotalSize) * 100)) : 0);

    const shadowRoot = this.context.shadowRoot;
    let progressBar = null;
    let statusText = null;

    let container = shadowRoot ? shadowRoot.querySelector(`#file-request-${id}`) : null;
    if (!container && shadowRoot) {
      const msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
      if (msgContainer) {
        container = msgContainer.querySelector(`#file-request-${id}`);
      }
    }
    if (!container) {
      container = this.context.root.querySelector(`#file-request-${id}`);
    }

    if (container) {
      progressBar = container.querySelector(`#progress-${id}`) || container.querySelector('.progress-bar');
      statusText = container.querySelector(`#status-${id}`) || container.querySelector('.file-status') || container.querySelector('.transfer-status');
    }

    if (!progressBar && shadowRoot) {
      const normalComponents = shadowRoot.querySelectorAll('normal-file-display');
      for (const comp of normalComponents) {
        if (comp.shadowRoot) {
          const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
          if (innerContainer) {
            progressBar = innerContainer.querySelector(`#progress-${id}`) || innerContainer.querySelector('.progress-bar');
            statusText = innerContainer.querySelector(`#status-${id}`) || innerContainer.querySelector('.file-status');
            if (progressBar) break;
          }
        }
      }

      if (!progressBar) {
        const imageComponents = shadowRoot.querySelectorAll('image-file-display');
        for (const comp of imageComponents) {
          if (comp.shadowRoot) {
            const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
            if (innerContainer) {
              progressBar = innerContainer.querySelector(`#progress-${id}`) || innerContainer.querySelector('.progress-bar');
              statusText = innerContainer.querySelector(`#status-${id}`) || innerContainer.querySelector('.file-status');
              if (progressBar) break;
            }
          }
        }
      }

      if (!progressBar) {
        const videoComponents = shadowRoot.querySelectorAll('video-file-display');
        for (const comp of videoComponents) {
          if (comp.shadowRoot) {
            const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
            if (innerContainer) {
              progressBar = innerContainer.querySelector(`#stream-progress-${id}`) || innerContainer.querySelector('.stream-progress');
              statusText = innerContainer.querySelector('.stream-status');
              if (progressBar) break;
            }
          }
        }
      }
    }

    if (progressBar) {
      progressBar.style.width = `${normalizedProgress}%`;
      if (!progressBar.classList.contains('stream-progress')) {
        progressBar.textContent = `${normalizedProgress}%`;
      }
    }

    if (statusText) {
      const speed = transferSpeed ? `(${this.utils.formatBytes(transferSpeed)}/s)` : '';
      if (normalizedProgress >= 100) {
        // Transfer completion status
        statusText.textContent = 'Transfer completed';
      } else if (statusText.classList.contains('stream-status')) {
        statusText.textContent = `Sending ${normalizedProgress}% (${this.utils.formatBytes(normalizedReceivedSize)} / ${this.utils.formatBytes(normalizedTotalSize)})`;
      } else if (customText) {
        statusText.textContent = `Transferring... ${customText} ${speed}`;
      } else {
        statusText.textContent = `Transferring... ${this.utils.formatBytes(normalizedReceivedSize)} / ${this.utils.formatBytes(normalizedTotalSize)} ${speed}`;
      }
    }

    // Update MP4 video component's transfer info row (consistent with regular files)
    if (shadowRoot) {
      const videoComponents = shadowRoot.querySelectorAll('video-file-display');
      for (const comp of videoComponents) {
        if (comp.updateTransferProgress && comp._offer?.id === id) {
          comp.updateTransferProgress(normalizedProgress, normalizedReceivedSize, normalizedTotalSize, transferSpeed);
          break;
        }
      }
    }

    return normalizedProgress;
  }

  showTransferInterrupted(id, receivedSize, totalSize, isSender = true) {
    if (this.isTransferComplete(id)) {
      return;
    }

    const normalizedReceivedSize = typeof receivedSize === 'number' ? receivedSize : Number(receivedSize) || 0;
    const normalizedTotalSize = typeof totalSize === 'number' ? totalSize : Number(totalSize) || 0;

    const shadowRoot = this.context.shadowRoot;
    let statusText = null;

    let container = shadowRoot ? shadowRoot.querySelector(`#file-request-${id}`) : null;
    if (!container && shadowRoot) {
      const msgContainer = shadowRoot.querySelector(`#msg-container-${id}`);
      if (msgContainer) {
        container = msgContainer.querySelector(`#file-request-${id}`);
      }
    }
    if (!container) {
      container = this.context.root.querySelector(`#file-request-${id}`);
    }

    if (container) {
      statusText = container.querySelector(`#status-${id}`) || container.querySelector('.file-status') || container.querySelector('.transfer-status');
    }

    if (!statusText && shadowRoot) {
      const normalComponents = shadowRoot.querySelectorAll('normal-file-display');
      for (const comp of normalComponents) {
        if (comp.shadowRoot) {
          const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
          if (innerContainer) {
            statusText = innerContainer.querySelector(`#status-${id}`) || innerContainer.querySelector('.file-status');
            if (statusText) break;
          }
        }
      }

      if (!statusText) {
        const imageComponents = shadowRoot.querySelectorAll('image-file-display');
        for (const comp of imageComponents) {
          if (comp.shadowRoot) {
            const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
            if (innerContainer) {
              statusText = innerContainer.querySelector(`#status-${id}`) || innerContainer.querySelector('.file-status');
              if (statusText) break;
            }
          }
        }
      }

      if (!statusText) {
        const videoComponents = shadowRoot.querySelectorAll('video-file-display');
        for (const comp of videoComponents) {
          if (comp.shadowRoot) {
            const innerContainer = comp.shadowRoot.querySelector(`#file-request-${id}`);
            if (innerContainer) {
              statusText = innerContainer.querySelector('.stream-status');
              if (statusText) break;
            }
          }
        }
      }
    }

    if (statusText) {
      const actionText = isSender ? 'Sent' : 'Received';
      const continueText = isSender ? 'can be re-sendimmediatelybreakpointresume transfer' : 'pleasepeerresendimmediatelybreakpointresume transfer';
      statusText.innerHTML = `Transfer interrupted(${actionText} ${this.utils.formatBytes(normalizedReceivedSize)} / ${this.utils.formatBytes(normalizedTotalSize)})<br>${continueText}`;
      this.logger.info(`[FileTransferUI] Transfer interruptedstatusDisplayed: id=${id}, received=${normalizedReceivedSize}, total=${normalizedTotalSize}`);
    } else {
      this.logger.warn(`[FileTransferUI] status element not found, unable todisplayTransfer interrupted: id=${id}`);
    }

    // Update MP4 video component's transfer interrupted state (consistent with regular files)
    if (shadowRoot) {
      const videoComponents = shadowRoot.querySelectorAll('video-file-display');
      for (const comp of videoComponents) {
        if (comp.showTransferInterrupted && comp._offer?.id === id) {
          comp.showTransferInterrupted(normalizedReceivedSize, normalizedTotalSize);
          break;
        }
      }
    }
  }
}