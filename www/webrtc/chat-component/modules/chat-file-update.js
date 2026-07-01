import { parseFileSize, inferIsSenderFromMessageContent } from './chat-utils.js';
import { getThumbnailFileName } from '../../../utils/thumbnail-utils.js';

export async function checkAndUpdateFileTransfers(context, messages) {
  if (!context.fileTransferManager || !messages || messages.length === 0) {
    return;
  }

  for (const msg of messages) {
    if (!msg.msgid) continue;

    const content = msg.content;

    if (content.includes('image-file-display') || content.includes('normal-file-display') || content.includes('video-file-display') || content.includes('audio-file-display')) {
      const offerMatch = content.match(/offer="([^"]+)"/) || content.match(/offer='([^']+)'/);
      if (offerMatch) {
        try {
          const offerJson = offerMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
          const offer = JSON.parse(offerJson);
          // Strictly validate offer.id
          if (offer && offer.id) {
            const validId = String(offer.id).trim();
            if (validId && validId !== 'undefined' && validId !== 'null' && validId !== '') {
              offer.id = validId; // Normalize id
              if (!context.fileTransferManager.fileOffers.has(validId)) {
                context.fileTransferManager.fileOffers.set(validId, offer);
                context.logger.info(`[ChatManager] from  Web Component history message in progressparsefileinfo: ${validId} - ${offer.filename}, storedFileName=${offer.storedFileName}`);
              }
            } else {
              context.logger.warn(`[ChatManager] offer.id invalid, skip: "${offer.id}"`);
            }
          } else {
            context.logger.warn(`[ChatManager] offer object missing id field, skip`);
          }
        } catch (e) {
          context.logger.warn(`[ChatManager] failed to parse Web Component offer: ${e.message}`);
        }
      }
    }

    if (content.includes('file-request-')) {
      const match = content.match(/id="file-request-([^"]+)"/);
      if (match) {
        const transferId = match[1];
        // Strictly validate transferId
        const validTransferId = String(transferId).trim();
        if (!validTransferId || validTransferId === 'undefined' || validTransferId === 'null' || validTransferId === '') {
          context.logger.warn(`[ChatManager] parsed invalid transferId from history message: "${transferId}", skip`);
          continue;
        }
        if (!context.fileTransferManager.fileOffers.has(validTransferId)) {
          const fileNameMatch = content.match(/<div class="file-name"[^>]*>([^<]+)<\/div>/);
          const fileSizeMatch = content.match(/<div class="file-size"[^>]*>([^<]+)<\/div>/);
          const fileSizeAttrMatch = content.match(/data-file-size="(\d+)"|data-file-size='(\d+)'/);
          const mimeTypeMatch = content.match(/data-mime-type="([^"]+)"|data-mime-type='([^']+)'|mimeType["\s:]+([^\s",]+)/);
          const storedFileNameMatch = content.match(/data-stored-filename="([^"]+)"/);

          let fileName = fileNameMatch ? fileNameMatch[1] : null;
          let fileSize = fileSizeMatch ? parseFileSize(fileSizeMatch[1]) : 0;
          let mimeType = mimeTypeMatch ? (mimeTypeMatch[1] || mimeTypeMatch[2] || mimeTypeMatch[3]) : 'application/octet-stream';
          let storedFileName = storedFileNameMatch ? storedFileNameMatch[1] : null;

          if (fileName && fileName.includes(transferId)) {
            const originalFileName = fileName.substring(fileName.indexOf(transferId) + transferId.length + 1);
            if (originalFileName) {
              context.logger.info(`[ChatManager] extract original filename from stored filename: ${fileName} -> ${originalFileName}`);
              storedFileName = fileName;
              fileName = originalFileName;
            }
          }

          if (!fileName && content.includes('image-message')) {
            const imgAltMatch = content.match(/<img[^>]+alt="([^"]+)"/);
            if (imgAltMatch) {
              fileName = imgAltMatch[1];
              const ext = fileName.split('.').pop().toLowerCase();
              if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
                mimeType = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
              }
            }
          }

          if (fileName) {
            const exactSize = fileSizeAttrMatch ? Number(fileSizeAttrMatch[1] || fileSizeAttrMatch[2]) || 0 : 0;
            const mockOffer = {
              id: validTransferId,
              filename: fileName,
              size: exactSize > 0 ? exactSize : fileSize,
              mimeType: mimeType,
              storedFileName: storedFileName
            };
            context.fileTransferManager.fileOffers.set(validTransferId, mockOffer);
            context.logger.info(`[ChatManager] parsed file info from history message: ${validTransferId} - ${mockOffer.filename}, storedFileName=${storedFileName}`);
          }
        }
      }
    }
  }

  for (const msg of messages) {
    if (!msg.msgid) continue;

    const content = msg.content;
    const isSender = resolveIsSenderUpdate(context, msg);
    const senderTransferPending = isSender && msg.status < 100;
    context.logger.info(`[ChatManager] checking message: msgid=${msg.msgid}, isSender=${isSender}, fromer=${msg.fromer}`);

    if (content.includes('image-message')) {
      if (senderTransferPending) {
        context.logger.info(`[ChatManager] send€[Image transfer not yet confirmed]keep breakpoints and continue displaying? ${msg.msgid}, status=${msg.status}`);
        continue;
      }

      if (!content.includes('file-complete-actions')) {
        context.logger.info(`[ChatManager] image message missing action buttons, trying to add: ${msg.msgid}`);
        const match = content.match(/id="file-request-([^"]+)"/);
        if (match) {
          const transferId = match[1];
          const offer = context.fileTransferManager.fileOffers.get(transferId);
          if (!offer) {
            context.logger.warn(`[ChatManager] fileOffers  in progressfindnot to  offer: ${transferId}`);
          } else {
            context.logger.info(`[ChatManager] found offer: ${transferId}, filename=${offer.filename}, storedFileName=${offer.storedFileName}, isSender=${isSender}`);
            const checkResult = await context.fileTransferManager.checkFileExists(transferId, offer.filename, isSender, offer.storedFileName);
            context.logger.info(`[ChatManager] checkResult: exists=${checkResult.exists}, filePath=${checkResult.filePath}`);
            if (checkResult.exists && checkResult.filePath) {
              if (context.fileTransferManager?.uiManager?.showFileCompleteActions) {
                context.fileTransferManager.uiManager.showFileCompleteActions(transferId, checkResult.filePath);
                context.logger.info(`[ChatManager] already hasimage messageAddaction buttonssucceeded: ${transferId}`);

                const shadowRoot = context.shadowRoot;
                if (shadowRoot) {
                  const fileRequestEl = shadowRoot.querySelector(`#file-request-${transferId}`);
                  if (fileRequestEl) {
                    await context.fileTransferManager.electronAPI.updateChatMessageContent({
                      msgid: transferId,
                      fromer: msg.fromer,
                      toer: msg.toer,
                      content: fileRequestEl.outerHTML,
                      dbUser: context.myEmail
                    });
                  }
                }
              }
            } else {
              context.logger.warn(`[ChatManager] filedoes not exist or path cannot be retrieved: ${transferId}, exists=${checkResult.exists}`);
            }
          }
        }
      } else {
        const match = content.match(/id="file-request-([^"]+)"/);
        if (match) {
          const transferId = match[1];
          const offer = context.fileTransferManager.fileOffers.get(transferId);

          const filePathMatch = content.match(/data-file-path="([^"]+)"/);
          const currentFilePath = filePathMatch ? filePathMatch[1] : null;

          let pathNeedsUpdate = false;
          if (currentFilePath) {
            const pathIsSends = /[\\/](files[\\/])?sends[\\/]/i.test(currentFilePath);
            const pathIsRecvs = /[\\/](files[\\/])?recvs[\\/]/i.test(currentFilePath);
            if (isSender && pathIsRecvs) {
              pathNeedsUpdate = true;
              context.logger.info(`[ChatManager] sender file path error (points to recvs), needs correction: ${transferId}, currentPath=${currentFilePath}`);
            } else if (!isSender && pathIsSends) {
              pathNeedsUpdate = true;
              context.logger.info(`[ChatManager] receiver file path error (points to sends), needs correction: ${transferId}, currentPath=${currentFilePath}`);
            }
          } else {
            pathNeedsUpdate = true;
            context.logger.info(`[ChatManager] message missing data-file-path, needs to add: ${transferId}`);
          }

          if (pathNeedsUpdate && offer) {
            const checkResult = await context.fileTransferManager.checkFileExists(transferId, offer.filename, isSender, offer.storedFileName);
            if (checkResult.exists && checkResult.filePath) {
              context.logger.info(`[ChatManager] correct file path: ${transferId}, newPath=${checkResult.filePath}`);

              if (context.fileTransferManager?.uiManager?.showFileCompleteActions) {
                context.fileTransferManager.uiManager.showFileCompleteActions(transferId, checkResult.filePath);

                const shadowRoot = context.shadowRoot;
                if (shadowRoot) {
                  const fileRequestEl = shadowRoot.querySelector(`#file-request-${transferId}`);
                  if (fileRequestEl) {
                    await context.fileTransferManager.electronAPI.updateChatMessageContent({
                      msgid: transferId,
                      fromer: msg.fromer,
                      toer: msg.toer,
                      content: fileRequestEl.outerHTML,
                      dbUser: context.myEmail
                    });
                    context.logger.info(`[ChatManager] file path corrected and saved to database: ${transferId}`);
                  }
                }
              }
            }
          } else {
            context.logger.info(`[ChatManager] message already in image display format and action button path correct, skip: ${msg.msgid}`);
          }
        }
      }
      continue;
    }

    if (content.includes('file-attachment')) {
      const fileNameMatch = content.match(/<div class="file-name"[^>]*>([^<]+)<\/div>/);
      if (fileNameMatch) {
        const fileName = fileNameMatch[1];

        const ext = fileName.split('.').pop().toLowerCase();
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext);

        if (isImage) {
          context.logger.info(`[ChatManager] found email attachment image: ${fileName}, prepare to update to image display`);

          const checkResult = await context.fileTransferManager.checkFileExists(msg.msgid, fileName, isSender);

          if (checkResult.exists) {
            context.logger.info(`[ChatManager] email attachment image file exists: ${fileName}, start updating`);

            const shadowRoot = context.shadowRoot;
            if (shadowRoot) {
              const msgContainer = shadowRoot.querySelector(`#msg-container-${msg.msgid}`);
              if (msgContainer) {
                const msgContent = msgContainer.querySelector('.message-content');
                if (msgContent) {
                  let port = 8080;
                  if (window.electronAPI && window.electronAPI.getHttpServerPort) {
                    try {
                      const result = await window.electronAPI.getHttpServerPort();
                      if (result && result.success && result.port && result.port > 0) {
                        port = result.port;
                      }
                    } catch (e) {}
                  }

                  const userId = context.myEmail || '';
                  // Generate URL using checkResult.storedFileName (actual file name with UID prefix)
                  const actualFileName = checkResult.storedFileName || fileName;
                  const imageUrl = `http://127.0.0.1:${port}/${userId}/files/recvs/${encodeURIComponent(actualFileName)}`;
                  const thumbFileName = getThumbnailFileName(actualFileName);
                  const thumbnailUrl = `http://127.0.0.1:${port}/${userId}/files/recvs/${encodeURIComponent(thumbFileName)}`;
                  const transferId = `email-attachment-${msg.msgid}`;

                  const newImageHtml = `
                    <div class="image-message file-request" id="file-request-${transferId}" style="margin-top: 8px;">
                      <img src="${thumbnailUrl}"
                           data-original-src="${imageUrl}"
                           alt="${fileName}"
                           style="max-width: 200px; height: auto; border-radius: 4px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.1);"
                           onclick="window.open(this.dataset.originalSrc || this.src, '_blank');"
                           onerror="if(this.dataset.originalSrc && this.src!==this.dataset.originalSrc && !this._fb){this._fb=1;this.src=this.dataset.originalSrc;}else{this.style.display='none';}">
                    </div>
                  `;

                  msgContent.innerHTML = newImageHtml;

                  if (checkResult.filePath && context.fileTransferManager?.uiManager?.showFileCompleteActions) {
                    setTimeout(() => {
                      context.fileTransferManager.uiManager.showFileCompleteActions(transferId, checkResult.filePath);
                    }, 100);
                  }

                  await context.fileTransferManager.electronAPI.updateChatMessageContent({
                    msgid: msg.msgid,
                    fromer: msg.fromer,
                    toer: msg.toer,
                    content: newImageHtml,
                    dbUser: context.myEmail
                  });

                  context.logger.info(`[ChatManager] email attachment image updated to image display: ${fileName}`);
                }
              }
            }
          }
        }
      }
      continue;
    }

    if (content.includes('file-request-')) {
      const match = content.match(/id="file-request-([^"]+)"/);
      if (match) {
        const transferId = match[1];
        const offer = context.fileTransferManager.fileOffers.get(transferId);

        if (offer && context.fileTransferManager.electronAPI) {
          try {
            if (senderTransferPending) {
              context.logger.info(`[ChatManager] send€[File transfer not yet confirmed]keep breakpoints and continue displaying? ${transferId}, status=${msg.status}`);
              continue;
            }

            const isImage = offer.mimeType && offer.mimeType.startsWith('image/');
            const isVideo = offer.mimeType && offer.mimeType.startsWith('video/');

            if (isImage) {
              const checkResult = await context.fileTransferManager.checkFileExists(transferId, offer.filename, isSender, offer.storedFileName);
              if (checkResult.exists) {
                context.logger.info(`[ChatManager] file exists, updated to image display: ${transferId}`);
                offer.storedFileName = checkResult.storedFileName;
                await context.fileTransferManager.updateMessageToImageDisplayAndSave(transferId, offer, isSender, checkResult.filePath);

                context.logger.info(`[ChatManager] ${isSender ? 'sender' : 'receiver'}imagefile action buttons shown: ${transferId}, path=${checkResult.filePath}`);

                const shadowRoot = context.shadowRoot;
                if (shadowRoot) {
                  const fileRequestEl = shadowRoot.querySelector(`#file-request-${transferId}`);
                  if (fileRequestEl) {
                    await context.fileTransferManager.electronAPI.updateChatMessageContent({
                      msgid: transferId,
                      fromer: msg.fromer,
                      toer: msg.toer,
                      content: fileRequestEl.outerHTML,
                      dbUser: context.myEmail
                    });
                  }
                }
              } else {
                context.logger.warn(`[ChatManager] file does not exist, cannot display image: ${transferId}, file: ${offer.filename}`);
              }
            } else if (isVideo) {
              context.logger.info(`[ChatManager] detected video file: ${transferId}, filename=${offer.filename}, isSender=${isSender}`);
              const checkResult = await context.fileTransferManager.checkFileExists(transferId, offer.filename, isSender, offer.storedFileName);
              if (checkResult.exists) {
                context.logger.info(`[ChatManager] video file exists, updating video display: ${transferId}, path=${checkResult.filePath}`);
                offer.storedFileName = checkResult.storedFileName;

                let port = 8080;
                if (window.electronAPI && window.electronAPI.getHttpServerPort) {
                  try {
                    const result = await window.electronAPI.getHttpServerPort();
                    if (result && result.success && result.port && result.port > 0) {
                      port = result.port;
                    }
                  } catch (e) {}
                }

                const folder = isSender ? 'sends' : 'recvs';
                const videoFileName = encodeURIComponent(checkResult.storedFileName || offer.filename);
                const videoUrl = `http://127.0.0.1:${port}/${folder}/${videoFileName}`;

                const shadowRoot = context.shadowRoot;
                if (shadowRoot) {
                  const videoContainer = shadowRoot.querySelector(`#video-container-${transferId}`);
                  if (videoContainer) {
                    const videoEl = videoContainer.querySelector('video');
                    if (videoEl) {
                      let sourceEl = videoEl.querySelector('source');
                      if (!sourceEl) {
                        sourceEl = document.createElement('source');
                        videoEl.appendChild(sourceEl);
                      }
                      sourceEl.src = videoUrl;
                      sourceEl.type = 'video/mp4';
                      videoEl.load();
                      context.logger.info(`[ChatManager] video source updated: ${videoUrl}`);

                      setTimeout(() => {
                        const statusSpan = shadowRoot.getElementById(`msg-status-${transferId}`) ||
                                         shadowRoot.querySelector(`#msg-container-${transferId} .message-status`);
                        if (statusSpan) {
                          if (isSender) {
                            statusSpan.textContent = ' (Transfer incomplete)';
                            context.logger.info(`[ChatManager] fallback path: overridden message status to"Transfer incomplete": ${transferId}`);
                          } else {
                            statusSpan.textContent = ' (Transfer interrupted)';
                            context.logger.info(`[ChatManager] fallback path: overridden message status to"Transfer interrupted": ${transferId}`);
                          }
                          statusSpan.style.color = '#e67e22';
                          statusSpan.dataset.transferIncomplete = 'true';
                        }
                      }, 500);

                      if (context.fileTransferManager?.uiManager?.showFileCompleteActions) {
                        context.fileTransferManager.uiManager.showFileCompleteActions(transferId, checkResult.filePath);
                        context.logger.info(`[ChatManager] video file action buttons shown: ${transferId}`);
                      }

                      const fileRequestEl = shadowRoot.querySelector(`#file-request-${transferId}`);
                      if (fileRequestEl) {
                        await context.fileTransferManager.electronAPI.updateChatMessageContent({
                          msgid: transferId,
                          fromer: msg.fromer,
                          toer: msg.toer,
                          content: fileRequestEl.outerHTML,
                          dbUser: context.myEmail
                        });
                        context.logger.info(`[ChatManager] video message HTML updated to database: ${transferId}`);
                      }
                    } else {
                      context.logger.warn(`[ChatManager] video element not found: #video-container-${transferId} video`);
                    }
                  } else {
                    context.logger.warn(`[ChatManager] video container not found: #video-container-${transferId}`);
                  }
                }
              } else {
                context.logger.warn(`[ChatManager] video file does not exist: ${transferId}, file: ${offer.filename}`);
              }
            } else {
              if (isSender) {
                const checkResult = await context.fileTransferManager.checkFileExists(transferId, offer.filename, true, offer.storedFileName);
                if (checkResult.exists) {
                  context.logger.info(`[ChatManager] sender file exists, updated to send completed@:  ${transferId}`);
                  const rendered = findRenderedFileRequest(context, transferId);
                  const fileRequestEl = rendered?.container;
                  const queryRoot = rendered?.queryRoot;
                  if (fileRequestEl && queryRoot) {
                    const statusEl = queryRoot.querySelector(`#status-${transferId}`) || queryRoot.querySelector('.file-status');
                    const progressBar = queryRoot.querySelector(`#progress-${transferId}`) || queryRoot.querySelector('.progress-bar');
                    const actionsEl = queryRoot.querySelector('.file-actions');

                    if (statusEl) statusEl.textContent = 'Send completed';
                    if (progressBar) {
                      progressBar.style.width = '100%';
                      progressBar.textContent = '100%';
                    }
                    if (actionsEl) actionsEl.remove();

                    const filePath = checkResult.filePath;
                    if (filePath && context.fileTransferManager?.uiManager?.showFileCompleteActions) {
                      context.fileTransferManager.uiManager.showFileCompleteActions(transferId, filePath);
                      context.logger.info(`[ChatManager] sender file action buttons shown: ${transferId}, path=${filePath}`);
                    }

                    await context.fileTransferManager.electronAPI.updateChatMessageContent({
                      msgid: transferId,
                      fromer: msg.fromer,
                      toer: msg.toer,
                      content: rendered.isWebComponent ? rendered.host.outerHTML : fileRequestEl.outerHTML,
                      dbUser: context.myEmail
                    });
                    context.logger.info(`[ChatManager] sender non-image file status updated and saved: ${transferId}`);
                  } else {
                    context.logger.warn(`[ChatManager] sender file request element not found: ${transferId}`);
                  }
                } else {
                  context.logger.warn(`[ChatManager] sender file does not exist: ${transferId}, file: ${offer.filename}`);
                }
                continue;
              }
              const integrity = await context.fileTransferManager.verifyFileIntegrity(transferId, offer.filename, offer.size);
              let metadata = null;
              if (context.fileTransferManager.electronAPI?.getTransferMetadata) {
                try {
                  metadata = await context.fileTransferManager.electronAPI.getTransferMetadata({
                    msgId: transferId,
                    userId: context.myEmail
                  });
                } catch (e) {
                  metadata = null;
                }
              }
              const completedMessageWithFile = !isSender && msg.status >= 100 && !!integrity.filePath;
              if ((integrity.complete || completedMessageWithFile) && metadata && context.fileTransferManager.electronAPI?.deleteTransferMetadata) {
                try {
                  await context.fileTransferManager.electronAPI.deleteTransferMetadata({
                    msgId: transferId,
                    userId: context.myEmail
                  });
                } catch (e) { context.logger?.debug('Delete transfer metadata failed:', e); }
              }
              const rendered = findRenderedFileRequest(context, transferId);
              const fileRequestEl = rendered?.container;
              const queryRoot = rendered?.queryRoot;
              if (fileRequestEl && queryRoot) {
                const statusEl = queryRoot.querySelector(`#status-${transferId}`) || queryRoot.querySelector('.file-status');
                const progressBar = queryRoot.querySelector(`#progress-${transferId}`) || queryRoot.querySelector('.progress-bar');
                const actionsEl = queryRoot.querySelector('.file-actions');
                if ((integrity.complete && integrity.actualSize > 0) || completedMessageWithFile) {
                  if (statusEl) statusEl.textContent = 'Receive completed';
                  if (progressBar) {
                    progressBar.style.width = '100%';
                    progressBar.textContent = '100%';
                  }
                  if (actionsEl) actionsEl.remove();
                  if (integrity.filePath && context.fileTransferManager?.uiManager?.showFileCompleteActions) {
                    context.fileTransferManager.uiManager.showFileCompleteActions(transferId, integrity.filePath);
                  }
                } else {
                  const metadataReceived = typeof metadata?.received_size === 'number' ? metadata.received_size : Number(metadata?.received_size) || 0;
                  const metadataTotal = typeof metadata?.total_size === 'number' ? metadata.total_size : Number(metadata?.total_size) || 0;
                  const totalSize = offer.size || metadataTotal || 0;
                  const actualSize = Math.max(integrity.actualSize || 0, metadataReceived || 0);
                  const progress = totalSize > 0 ? Math.min(100, Math.round((actualSize / totalSize) * 100)) : 0;
                  const tolerance = totalSize > 0 ? Math.max(64 * 1024, Math.round(totalSize * 0.01)) : 0;
                  const looksCompleteByMetadata = metadataTotal > 0 && metadataReceived >= metadataTotal && (integrity.actualSize || 0) >= metadataTotal;
                  const looksCompleteBySize = totalSize > 0 && (integrity.actualSize || 0) > 0 && Math.abs((integrity.actualSize || 0) - totalSize) <= tolerance;
                  const shouldTreatComplete = looksCompleteByMetadata || looksCompleteBySize || completedMessageWithFile;

                  if (shouldTreatComplete) {
                    if (statusEl) statusEl.textContent = 'Receive completed';
                    if (progressBar) {
                      progressBar.style.width = '100%';
                      progressBar.textContent = '100%';
                    }
                    if (actionsEl) actionsEl.remove();
                    if (integrity.filePath && context.fileTransferManager?.uiManager?.showFileCompleteActions) {
                      context.fileTransferManager.uiManager.showFileCompleteActions(transferId, integrity.filePath);
                    }
                    if (metadata && context.fileTransferManager.electronAPI?.deleteTransferMetadata) {
                      try {
                        await context.fileTransferManager.electronAPI.deleteTransferMetadata({
                          msgId: transferId,
                          userId: context.myEmail
                        });
                      } catch (e) {}
                    }
                  } else {
                    if (statusEl) {
                      statusEl.textContent = actualSize > 0
                        ? `transfer interrupted (received ${context.utils.formatBytes(actualSize)} / ${context.utils.formatBytes(totalSize)}), can/maycontinue receiving`
                        : 'transfer incomplete, can continue receiving';
                    }
                    if (progressBar) {
                      progressBar.style.width = `${progress}%`;
                      progressBar.textContent = `${progress}%`;
                    }
                    if (actionsEl) {
                      const acceptBtn = actionsEl.querySelector('.accept-btn');
                      if (acceptBtn) {
                        acceptBtn.textContent = 'continue receiving';
                      }
                    } else {
                      const newActions = document.createElement('div');
                      newActions.className = 'file-actions';
                      const acceptBtn = document.createElement('button');
                      acceptBtn.className = 'accept-btn';
                      acceptBtn.dataset.transferId = transferId;
                      acceptBtn.textContent = 'continue receiving';
                      newActions.appendChild(acceptBtn);
                      (queryRoot.querySelector('.file-request') || fileRequestEl).appendChild(newActions);
                    }
                  }
                }
                let contentToSave = rendered.isWebComponent ? rendered.host.outerHTML : fileRequestEl.outerHTML;
                if (rendered.isWebComponent && rendered.host?.tagName === 'NORMAL-FILE-DISPLAY') {
                  const fileName = fileRequestEl.shadowRoot?.querySelector('.file-name')?.textContent || offer.filename || 'file';
                  const fileSize = fileRequestEl.shadowRoot?.querySelector('.file-size')?.textContent || context.utils.formatBytes(offer.size) || '';
                  const storedFileName = (offer?.storedFileName || (integrity?.filePath ? integrity.filePath.split(/[\\/]/).pop() : '')).trim();
                  const filePathAttr = integrity?.filePath ? ` data-file-path="${integrity.filePath}"` : '';
                  const storedFileAttr = storedFileName ? ` data-stored-filename="${storedFileName}"` : '';
                  const mimeTypeAttr = offer?.mimeType ? ` data-mime-type="${offer.mimeType}"` : '';
                  const fileSizeAttr = Number.isFinite(offer?.size) ? ` data-file-size="${offer.size}"` : '';
                  contentToSave = `<div class="file-request" id="file-request-${transferId}"${mimeTypeAttr}${fileSizeAttr}${storedFileAttr}${filePathAttr} data-is-sender="false">
                    <div class="file-info">
                      <span class="file-icon">📔</span>
                      <div class="file-details">
                        <div class="file-name">${fileName}</div>
                        <div class="file-meta">
                          <span class="file-size">${fileSize}</span>
                          <span class="file-status">Receive completed</span>
                        </div>
                      </div>
                    </div>
                  </div>`;
                }

                await context.fileTransferManager.electronAPI.updateChatMessageContent({
                  msgid: transferId,
                  fromer: msg.fromer,
                  toer: msg.toer,
                  content: contentToSave,
                  dbUser: context.myEmail
                });
                context.logger.info(`[ChatManager] non-image file status calibrated and saved: ${transferId}`);
              } else {
                context.logger.warn(`[ChatManager] file request element not found: ${transferId}`);
              }
            }
          } catch (error) {
            context.logger.error(`[ChatManager] failed to check file status: ${transferId}`, error);
          }
        }
      }
    }
  }
}

function findRenderedFileRequest(context, transferId) {
  const shadowRoot = context.shadowRoot;
  if (!shadowRoot) return null;

  const direct = shadowRoot.querySelector(`#file-request-${transferId}`);
  if (direct) {
    return {
      host: direct,
      container: direct,
      queryRoot: direct,
      isWebComponent: false
    };
  }

  const componentTags = [
    'normal-file-display',
    'image-file-display',
    'video-file-display',
    'audio-file-display'
  ];

  for (const tag of componentTags) {
    const components = shadowRoot.querySelectorAll(tag);
    for (const comp of components) {
      const inner = comp.shadowRoot?.querySelector(`#file-request-${transferId}`);
      if (inner) {
        return {
          host: comp,
          container: comp,
          queryRoot: comp.shadowRoot,
          isWebComponent: true
        };
      }
    }
  }

  const msgContainer = shadowRoot.querySelector(`#msg-container-${transferId}`);
  const nested = msgContainer?.querySelector(`#file-request-${transferId}`);
  if (nested) {
    return {
      host: nested,
      container: nested,
      queryRoot: nested,
      isWebComponent: false
    };
  }

  return null;
}

function resolveIsSenderUpdate(context, msg) {
  const myEmail = (context.myEmail || '').trim().toLowerCase();
  const targetEmail = (context.targetEmail || '').trim().toLowerCase();
  const fromEmail = (msg.fromer || '').trim().toLowerCase();
  const toEmail = (msg.toer || '').trim().toLowerCase();

  if (myEmail) {
    return fromEmail === myEmail;
  }

  if (targetEmail) {
    if (fromEmail === targetEmail) return false;
    if (toEmail === targetEmail) return true;
  }

  return false;
}
