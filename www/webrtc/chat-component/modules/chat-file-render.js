import { createFileDisplayComponent } from '../../../components/file-display/index.js';

/**
 * Determine MP4 file playability
 * @param {number} actualSize - Actual file size
 * @param {Object} transferMetadata - Transfer metadata
 * @param {number} totalSize - Total file size
 * @param {Object} logger - Logger object
 * @returns {Object|null} Playback status object
 */
function _determineMP4PlayState(actualSize, transferMetadata, totalSize, logger) {
  try {
    // Parse MP4 metadata
    let mp4Metadata = null;
    if (transferMetadata?.metadata) {
      try {
        mp4Metadata = JSON.parse(transferMetadata.metadata);
      } catch (e) {
        logger?.warn?.(`[ChatManager] Failed to parse MP4 metadata:`, e);
      }
    }

    // If no MP4 metadata, return null and let the browser detect
    if (!mp4Metadata) {
      return null;
    }

    const {
      moovReceived = false,
      moovAssembled = false,
      ftypSize = 0,
      moovSize = 0,
      needsReassembly = false,
      moovPosition = 'front'
    } = mp4Metadata;

    // Base status
    const state = {
      metadataReady: false,
      startupReady: false,
      mediaReady: false,
      progress: totalSize > 0 ? Math.min(100, Math.round((actualSize / totalSize) * 100)) : 0
    };

    // Check if metadata is ready (moov received and reassembled)
    if (moovReceived && moovAssembled) {
      state.metadataReady = true;
    }

    // Special handling for MP4 files with moov at the end
    if (needsReassembly && moovPosition === 'back') {
      // Case where moov is at the end:
      // - File header has ftyp + moov (reassembled)
      // - Followed by mdat data
      
      if (moovReceived && moovAssembled) {
        // moov received and reassembled to header
        state.metadataReady = true;
        
        // Check if enough startup data received (first N seconds of video)
        // Simple check: if file size exceeds ftyp + moov + 1MB, consider it playable
        const headerSize = (ftypSize || 24) + (moovSize || 0);
        const startupThreshold = headerSize + 1024 * 1024; // 1MB startup data
        
        if (actualSize >= startupThreshold) {
          state.startupReady = true;
          state.mediaReady = true;
          logger?.info?.(`[ChatManager] MP4 playability check: moov reassembled, fileSize=${actualSize}, header=${headerSize}, exceeds startup threshold`);
        } else {
          logger?.info?.(`[ChatManager] MP4 not ready: moov reassembled but insufficient data, fileSize=${actualSize}, required=${startupThreshold}`);
        }
      } else {
        // moov not received, cannot play
        logger?.info?.(`[ChatManager] MP4 not ready: moov not received, moovReceived=${moovReceived}, moovAssembled=${moovAssembled}`);
      }
    } else {
      // moov at header case (normal MP4)
      if (moovReceived) {
        state.metadataReady = true;
        
        // Check if enough mdat data received
        const headerSize = ftypSize || 24;
        const startupThreshold = headerSize + 1024 * 1024; // 1MB
        
        if (actualSize >= startupThreshold) {
          state.startupReady = true;
          state.mediaReady = true;
        }
      }
    }

    // Mark as fully playable if file is completely received
    if (actualSize >= totalSize && totalSize > 0) {
      state.metadataReady = true;
      state.startupReady = true;
      state.mediaReady = true;
      state.progress = 100;
    }

    return state;
  } catch (error) {
    logger?.warn?.(`[ChatManager] Failed to determine MP4 playback state:`, error);
    return null;
  }
}

export async function _renderHistoryFileMessage(context, msg, sender, senderEmail, parseResult) {
  const { type, offer, posterUrl, posterFileName } = parseResult;
  const isSender = sender === 'Me';

  let checkResult = { exists: false, filePath: null, fileName: null };
  let fileIntegrity = { complete: false, actualSize: 0 };

  // First try to get transfer metadata from database (for accurate file size)
  let transferMetadata = null;
  if (context.fileTransferManager?.electronAPI?.getTransferMetadata) {
    try {
      transferMetadata = await context.fileTransferManager.electronAPI.getTransferMetadata({
        msgId: offer.id,
        userId: context.myEmail
      });
      if (transferMetadata) {
        context.logger.info(`[ChatManager] Retrieved transfer metadata: ${offer.id}, received_size=${transferMetadata.received_size}, total_size=${transferMetadata.total_size}`);
        // Use accurate size from database
        if (transferMetadata.total_size > 0) {
          offer.size = transferMetadata.total_size;
        }
      }
    } catch (e) {
      context.logger.warn(`[ChatManager] Failed to retrieve transfer metadata: ${offer.id}`, e);
    }
  }

  if (context.fileTransferManager) {
    // [FIX] Verify storedFileName matches transferId to prevent incorrect storedFileName in historical messages
    let storedFileNameToUse = offer.storedFileName;
    if (storedFileNameToUse && !storedFileNameToUse.includes(offer.id)) {
      context.logger.warn(`[ChatManager] storedFileName does not match transferId: transferId=${offer.id}, storedFileName=${storedFileNameToUse}; will use transferId to build filename lookup`);
      storedFileNameToUse = null; // Do not use incorrect storedFileName
    }

    checkResult = await context.fileTransferManager.checkFileExists(
      offer.id,
      offer.filename,
      isSender,
      storedFileNameToUse
    );

    if (checkResult.exists && checkResult.filePath) {
      try {
        fileIntegrity = await context.fileTransferManager.verifyFileIntegrity(
          offer.id,
          offer.filename,
          offer.size || 0,
          isSender  // Pass isSender parameter to decide whether to look in sends or recvs directory
        );
        context.logger.info(`[ChatManager] File integrity check: ${offer.id}, isSender=${isSender}, complete=${fileIntegrity.complete}, actualSize=${fileIntegrity.actualSize}, expectedSize=${offer.size}`);
      } catch (e) {
        context.logger.warn(`[ChatManager] File integrity check failed: ${offer.id}`, e);
      }
    }
  }

  const hasLocalFile = checkResult.exists && checkResult.filePath;
  const senderTransferCompleted = isSender && msg.status >= 100 && hasLocalFile;
  const receiverTransferCompleted =
    !isSender &&
    hasLocalFile &&
    (fileIntegrity.complete || msg.status >= 100);

  if (senderTransferCompleted || receiverTransferCompleted) {
    offer.storedFileName = checkResult.fileName || offer.storedFileName;
  }

  const isTransferComplete = senderTransferCompleted || receiverTransferCompleted;
  const isPartialTransfer = !isSender && hasLocalFile && !fileIntegrity.complete;

  // Retry fetching metadata if not previously obtained and transfer is incomplete (for progress recovery)
  if (!transferMetadata && !isTransferComplete && context.fileTransferManager?.electronAPI?.getTransferMetadata) {
    try {
      transferMetadata = await context.fileTransferManager.electronAPI.getTransferMetadata({
        msgId: offer.id,
        userId: context.myEmail
      });
      if (transferMetadata) {
        context.logger.info(`[ChatManager] Retrieved transfer metadata: ${offer.id}, isSender=${isSender}, received_size=${transferMetadata.received_size}, total_size=${transferMetadata.total_size}`);
      }
    } catch (e) {
      context.logger.warn(`[ChatManager] Failed to retrieve transfer metadata: ${offer.id}`, e);
    }
  }

  let receivedSize = 0;
  let totalSize = offer.size || 0;

  // For sender: prefer transferMetadata (sender doesn't write to local disk)
  // For receiver: prefer actual file size (actual bytes written to disk)
  if (isSender) {
    // Sender: prefer transferMetadata to recover progress
    if (transferMetadata) {
      receivedSize = typeof transferMetadata.received_size === 'number'
        ? transferMetadata.received_size
        : Number(transferMetadata.received_size) || 0;
      const metadataTotalSize = typeof transferMetadata.total_size === 'number'
        ? transferMetadata.total_size
        : Number(transferMetadata.total_size) || 0;
      if (metadataTotalSize > 0 && totalSize === 0) {
        totalSize = metadataTotalSize;
      }
      context.logger.info(`[ChatManager] Sender uses transfer_metadata progress: ${offer.id}, receivedSize=${receivedSize}, totalSize=${totalSize}`);
    } else if (context.fileTransferManager?.sender?.progressSnapshots?.has(offer.id)) {
      // Fall back to in-memory progress snapshot
      const senderSnapshot = context.fileTransferManager.sender.progressSnapshots.get(offer.id);
      if (senderSnapshot) {
        receivedSize = senderSnapshot.receivedSize || 0;
        totalSize = senderSnapshot.totalSize || totalSize;
        context.logger.info(`[ChatManager] Sender uses progressSnapshots progress: ${offer.id}, receivedSize=${receivedSize}, totalSize=${totalSize}`);
      }
    } else {
      context.logger.warn(`[ChatManager] Sender has no progress data: ${offer.id}, transferMetadata=${!!transferMetadata}`);
    }
  } else {
    // Receiver: prefer actual file size
    if (fileIntegrity.actualSize > 0) {
      receivedSize = fileIntegrity.actualSize;
      context.logger.info(`[ChatManager] Receiver uses actual file size: ${offer.id}, actualSize=${receivedSize}`);
    } else if (transferMetadata) {
      // Fall back to transferMetadata
      receivedSize = typeof transferMetadata.received_size === 'number'
        ? transferMetadata.received_size
        : Number(transferMetadata.received_size) || 0;
      const metadataTotalSize = typeof transferMetadata.total_size === 'number'
        ? transferMetadata.total_size
        : Number(transferMetadata.total_size) || 0;
      if (metadataTotalSize > 0 && totalSize === 0) {
        totalSize = metadataTotalSize;
      }
      context.logger.info(`[ChatManager] Receiver uses transfer_metadata progress: ${offer.id}, receivedSize=${receivedSize}, totalSize=${totalSize}`);
    }
  }

  const hasProgress = receivedSize > 0 && totalSize > 0;
  const senderAwaitingConfirmation =
    isSender &&
    !isTransferComplete &&
    totalSize > 0 &&
    receivedSize >= totalSize;
  const isSenderInterrupted = isSender && !isTransferComplete && !hasProgress && msg.status < 100 && totalSize > 0;

  try {
    const component = await createFileDisplayComponent(
      offer,
      isSender,
      context,
      checkResult.exists ? checkResult.filePath : null
    );

    // [FIX] If transfer is complete, set _transferCompleted = true before component render
    // So render() shows completed status instead of "Sending..."
    if (isTransferComplete) {
      component._transferCompleted = true;
      component._filePath = checkResult.filePath;
    }

    if (type === 'video' && component.setPoster) {
      const currentPort = context.httpServerPort || 8080;
      const targetPosterFileName = posterFileName || offer.posterFileName;

      context.logger.info(`[ChatManager] History video poster loading: transferId=${offer.id}, type=${type}, isSender=${isSender}`);
      context.logger.info(`[ChatManager] Poster parameters: posterFileName=${posterFileName}, offer.posterFileName=${offer.posterFileName}, targetPosterFileName=${targetPosterFileName}`);
      context.logger.info(`[ChatManager] Original posterUrl=${posterUrl}`);

      const useLocalHttp = targetPosterFileName && (isSender || !posterUrl || !posterUrl.startsWith('data:'));
      context.logger.info(`[ChatManager] Poster loading strategy: useLocalHttp=${useLocalHttp}, conditions: targetPosterFileName=${!!targetPosterFileName}, isSender=${isSender}, hasPosterUrl=${!!posterUrl}, isDataUrl=${posterUrl?.startsWith('data:')}`);

      if (useLocalHttp) {
        const primaryFolder = isSender ? 'sends' : 'recvs';
        const fallbackFolder = isSender ? 'recvs' : 'sends';
        let posterHttpUrl = null;

        context.logger.info(`[ChatManager] Loading poster via local HTTP: primaryFolder=${primaryFolder}, targetPosterFileName=${targetPosterFileName}`);

        if (window.electronAPI?.getSentFilePath) {
          try {
            const userId = context.myEmail;
            context.logger.info(`[ChatManager] Calling getSentFilePath to check poster: fileName=${targetPosterFileName}, isSender=${isSender}, userId=${userId}`);
            const primaryResult = await window.electronAPI.getSentFilePath(targetPosterFileName, isSender, userId);
            context.logger.info(`[ChatManager] getSentFilePath primary returned: success=${primaryResult?.success}, filePath=${primaryResult?.filePath}`);
            if (primaryResult?.success) {
              posterHttpUrl = `http://127.0.0.1:${currentPort}/${userId}/files/${primaryFolder}/${encodeURIComponent(targetPosterFileName)}`;
              context.logger.info(`[ChatManager] ✅ Poster file exists in ${primaryFolder}/: ${targetPosterFileName}, URL=${posterHttpUrl}`);
            } else {
              context.logger.warn(`[ChatManager] Poster file does not exist in ${primaryFolder}/, trying fallback directory`);
              const fallbackResult = await window.electronAPI.getSentFilePath(targetPosterFileName, !isSender, userId);
              context.logger.info(`[ChatManager] getSentFilePath fallback returned: success=${fallbackResult?.success}, filePath=${fallbackResult?.filePath}`);
              if (fallbackResult?.success) {
                posterHttpUrl = `http://127.0.0.1:${currentPort}/${userId}/files/${fallbackFolder}/${encodeURIComponent(targetPosterFileName)}`;
                context.logger.info(`[ChatManager] ✅ Poster file found in fallback directory ${fallbackFolder}/: ${targetPosterFileName}, URL=${posterHttpUrl}`);
              } else {
                context.logger.error(`[ChatManager] ❌ Poster file does not exist in either directory: ${targetPosterFileName}`);
              }
            }
          } catch (e) {
            context.logger.error(`[ChatManager] ❌ Exception checking poster file existence: ${e.message}`);
            const userId = context.myEmail;
            posterHttpUrl = `http://127.0.0.1:${currentPort}/${userId}/files/${primaryFolder}/${encodeURIComponent(targetPosterFileName)}`;
          }
        } else {
          posterHttpUrl = `http://127.0.0.1:${currentPort}/${primaryFolder}/${encodeURIComponent(targetPosterFileName)}`;
          context.logger.info(`[ChatManager] Using old format path: ${posterHttpUrl}`);
        }

        if (posterHttpUrl) {
          component.setPoster(posterHttpUrl);
          context.logger.info(`[ChatManager] ✅ History video poster set via posterFileName (HTTP): ${posterHttpUrl}`);
        }
      } else if (posterUrl) {
        context.logger.info(`[ChatManager] Loading poster directly via posterUrl: ${posterUrl.substring(0, 100)}...`);
        if (posterUrl.startsWith('data:')) {
          component.setPoster(posterUrl);
          context.logger.info(`[ChatManager] ✅ History video poster set (data URL): ${offer.id}`);
        } else if (posterUrl.includes('127.0.0.1')) {
          const correctedPosterUrl = posterUrl.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${currentPort}`);
          component.setPoster(correctedPosterUrl);
          context.logger.info(`[ChatManager] ✅ History video port corrected and poster set (HTTP): ${correctedPosterUrl}`);
        } else {
          component.setPoster(posterUrl);
          context.logger.info(`[ChatManager] ✅ History video poster set (Remote URL): ${posterUrl}`);
        }
      } else {
        context.logger.error(`[ChatManager] ❌ Cannot load poster: targetPosterFileName=${targetPosterFileName}, posterUrl=${posterUrl}`);
      }
    }

    // [FIX] If transfer is complete, add transfer-completed class (_transferCompleted was set during creation)
    if (isTransferComplete) {
      const fileRequestEl = component.shadowRoot?.querySelector('.file-request');
      if (fileRequestEl) {
        fileRequestEl.classList.add('transfer-completed');
      }
      context.logger.info(`[ChatManager] History file component marked as complete: ${offer.id}, filePath=${checkResult.filePath}`);
    } else if ((hasProgress || isSenderInterrupted) && component.setInitialProgress) {
      setTimeout(() => {
        component.setInitialProgress(receivedSize, totalSize, !senderAwaitingConfirmation);
        if (senderAwaitingConfirmation) {
          const componentStatus =
            component.shadowRoot?.querySelector('.file-status') ||
            component.shadowRoot?.querySelector('.stream-status');
          if (componentStatus) {
            componentStatus.textContent = window.i18n?.t ? window.i18n.t('chat.waitingForConfirm') : 'Sent, awaiting confirmation...';
          }
        }
        context.logger.info(`[ChatManager] History file component progress restored: ${offer.id}, ${receivedSize}/${totalSize}`);

        if (checkResult.exists) {
          const currentPort = context.httpServerPort || 8080;
          const folder = isSender ? 'sends' : 'recvs';
          const fileName = checkResult.fileName || offer.storedFileName || offer.filename;
          const videoUrl = `http://127.0.0.1:${currentPort}/${folder}/${encodeURIComponent(fileName)}`;
          
          // For MP4 videos, actively determine playability
          if (type === 'video' && component.updatePlayStatus) {
            const playState = _determineMP4PlayState(
              fileIntegrity.actualSize,
              transferMetadata,
              offer.size,
              context.logger
            );
            
            if (playState) {
              component.updatePlayStatus(playState);
              context.logger.info(`[ChatManager] MP4 history message playback state set: ${offer.id}, ` +
                `metadataReady=${playState.metadataReady}, startupReady=${playState.startupReady}, mediaReady=${playState.mediaReady}`);
            }
          }
          
          if (component.setVideoSource) {
            component.setVideoSource(videoUrl);
            context.logger.info(`[ChatManager] Partial transfer: video src loaded: ${videoUrl} (isSender=${isSender})`);
          }
        }

        {
          const shadowRoot = context.shadowRoot;
          const statusSpan = shadowRoot?.getElementById(`msg-status-${offer.id}`) ||
            shadowRoot?.querySelector(`#msg-container-${offer.id} .message-status`);
          if (statusSpan && senderAwaitingConfirmation) {
            statusSpan.textContent = ` (${window.i18n?.t ? window.i18n.t('chat.waitingForConfirm') : 'Awaiting confirmation...'})`;
            statusSpan.style.color = '#2196F3';
            delete statusSpan.dataset.transferIncomplete;
            context.logger.info(`[ChatManager] sender transfer reached 100%, showing awaiting confirmation state: ${offer.id}`);
            return;
          }
          if (statusSpan) {
            if (isSender) {
              statusSpan.textContent = ` (${window.i18n?.t ? window.i18n.t('chat.transferIncomplete') : 'Transfer incomplete'})`;
              context.logger.info(`[ChatManager] Message status overridden to "Transfer incomplete": ${offer.id}`);
            } else {
              statusSpan.textContent = ` (${window.i18n?.t ? window.i18n.t('chat.transferInterrupted') : 'Transfer interrupted'})`;
              context.logger.info(`[ChatManager] Message status overridden to "Transfer interrupted": ${offer.id}`);
            }
            statusSpan.style.color = '#e67e22';
            statusSpan.dataset.transferIncomplete = 'true';
          }
        }
      }, 600);
    }

    if (context.uiRenderer.displayMessageElement) {
      context.uiRenderer.displayMessageElement(
        sender,
        component,
        offer.id,
        msg.createtime,
        senderEmail,
        msg.status
      );
    } else {
      context.uiRenderer.displayMessage(
        sender,
        component.outerHTML,
        offer.id,
        msg.createtime,
        senderEmail,
        msg.status
      );
    }

    if (isTransferComplete) {
      setTimeout(() => {
        if (component.showComplete) {
          component.showComplete(checkResult.filePath);
          context.logger.info(`[ChatManager] Component showComplete method called: ${offer.id}`);
        }
      }, 50);
    }

    if (isTransferComplete && context.fileTransferManager) {
      setTimeout(() => {
        context.fileTransferManager.uiManager.showFileCompleteActions(
          offer.id,
          checkResult.filePath
        );
      }, 100);
    }
  } catch (error) {
    context.logger.error('[ChatManager] Failed to create history file component:', error);
    const unescapedContent = context.utils?.textToHtml ? context.utils.textToHtml(msg.content) : msg.content;
    context.uiRenderer.displayMessage(
      sender,
      unescapedContent,
      msg.msgid || null,
      msg.createtime,
      senderEmail,
      msg.status
    );
  }
}
