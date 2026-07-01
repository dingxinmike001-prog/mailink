/**
 * MP4 poster handling module
 * Handles saving and loading of video posters
 */

export class MP4PosterHandler {
  constructor(receiver) {
    this.receiver = receiver;
    this.logger = receiver.logger;
    this.context = receiver.context;
    this.electronAPI = receiver.electronAPI;
  }

  /**
   * Save poster image to recvs directory and set display
   * @private
   */
  async _saveAndSetPoster(transferId, posterDataUrl, component) {
    this.logger.info(`[MP4PosterHandler] _saveAndSetPoster start: transferId=${transferId}, posterDataUrllength=${posterDataUrl?.length || 0}`);
    try {
      if (this.electronAPI?.saveReceiverVideoPoster) {
        this.logger.info(`[MP4PosterHandler] call saveReceiverVideoPoster API saveposterto  recvs, transferId=${transferId}`);
        const saveResult = await window.electronAPI.saveReceiverVideoPoster({
          transferId: transferId,
          posterDataUrl: posterDataUrl,
          userId: this.context.myEmail
        });

        this.logger.info(`[MP4PosterHandler] saveReceiverVideoPoster return: success=${saveResult?.success}, posterFileName=${saveResult?.posterFileName}`);
        if (saveResult?.success) {
          const posterFileName = saveResult.posterFileName;
          const port = await this.receiver.utilsModule.getHttpPort();
          const userId = this.context.myEmail || '';
          const posterUrl = `http://127.0.0.1:${port}/${userId}/files/recvs/${encodeURIComponent(posterFileName)}`;

          this.logger.info(`[MP4PosterHandler] ✅ receiverposter savedto  recvs: ${posterFileName}, posterURL: ${posterUrl}`);
          component.setPoster(posterUrl);

          const offer = this.receiver.fileOffers.get(transferId);
          this.logger.info(`[MP4PosterHandler] offer Peericon/elephantexists: ${!!offer}, current offer.posterFileName=${offer?.posterFileName}`);
          if (offer) {
            offer.posterFileName = posterFileName;
            this.logger.info(`[MP4PosterHandler] ✅ will  posterFileName=${posterFileName} updateto  offer Peericon/elephant`);

            if (component && typeof component.setAttribute === 'function') {
              component.setAttribute('offer', JSON.stringify(offer));
              this.logger.info(`[MP4PosterHandler] component propertiesUpdated offer`);
            }

            if (this.electronAPI?.updateChatMessageContent) {
              this.logger.info(`[MP4PosterHandler] prepareupdatedatalibrarymessagecontent, msgid=${transferId}, fromer=${this.context.targetEmail}, toer=${this.context.myEmail}`);
              setTimeout(async () => {
                try {
                  let updatedContent = component.outerHTML;
                  if (component && component.tagName && component.tagName.toLowerCase() === 'video-file-display') {
                    const offerAttr = JSON.stringify(offer).replace(/"/g, '&quot;');
                    const isSenderAttr = component.getAttribute('is-sender') || 'false';
                    const filePathAttr = component.getAttribute('file-path');

                    let newComponentHtml = `<video-file-display offer="${offerAttr}" is-sender="${isSenderAttr}"`;
                    if (filePathAttr) {
                      newComponentHtml += ` file-path="${filePathAttr}"`;
                    }
                    newComponentHtml += `></video-file-display>`;

                    updatedContent = newComponentHtml;
                    this.logger.info(`[MP4PosterHandler] manual buildupdateaftercomponent HTML, include posterFileName: ${posterFileName}`);
                  }

                  const updateResult = await this.electronAPI.updateChatMessageContent({
                    msgid: transferId,
                    fromer: this.context.targetEmail,
                    toer: this.context.myEmail,
                    content: updatedContent,
                    dbUser: this.context.myEmail
                  });
                  this.logger.info(`[MP4PosterHandler] ✅ syncposterinfoto datalibrary: transferId=${transferId}, result=${JSON.stringify(updateResult)}`);
                } catch (e) {
                  this.logger.error(`[MP4PosterHandler] ❌ syncposterto datalibraryfailed:`, e);
                }
              }, 500);
            } else {
              this.logger.warn(`[MP4PosterHandler] ❌ electronAPI.updateChatMessageContent unavailable`);
            }
          } else {
            this.logger.warn(`[MP4PosterHandler] ❌ offer Peericon/elephantdoes not exist: transferId=${transferId}`);
          }
        } else {
          this.logger.warn(`[MP4PosterHandler] ❌ savereceiver posterfailed: ${saveResult?.error}`);
          this.logger.info(`[MP4PosterHandler] fallback: directuse data URL setposter`);
          component.setPoster(posterDataUrl);
        }
      } else {
        this.logger.warn(`[MP4PosterHandler] ❌ electronAPI.saveReceiverVideoPoster unavailable, directuse data URL`);
        component.setPoster(posterDataUrl);
      }
    } catch (error) {
      this.logger.error(`[MP4PosterHandler] ❌ _saveAndSetPoster exception:`, error);
      try {
        component.setPoster(posterDataUrl);
      } catch (e) {
        this.logger.error(`[MP4PosterHandler] ❌ set data URL posteralsofailed:`, e);
      }
    }
  }

  /**
   * Load poster image
   * @private
   */
  async _loadPosterImage(transferId, posterFileName, component) {
    this.logger.info(`[MP4PosterHandler] _loadPosterImage start: transferId=${transferId}, posterFileName=${posterFileName}`);
    try {
      const offer = this.receiver.fileOffers.get(transferId);
      const senderPort = offer?.senderPort || offer?.port;
      const localPort = await this.receiver.utilsModule.getHttpPort();

      this.logger.info(`[MP4PosterHandler] portinfo: senderPort=${senderPort}, localPort=${localPort}`);
      const port = senderPort || localPort;

      const userId = this.context.myEmail || '';
      const posterUrl = `http://127.0.0.1:${port}/${userId}/files/sends/${encodeURIComponent(posterFileName)}`;
      this.logger.info(`[MP4PosterHandler] buildposterURL: ${posterUrl}`);

      component.setPoster(posterUrl);
      this.logger.info(`[MP4PosterHandler] SetposterURLto component`);

      try {
        this.logger.info(`[MP4PosterHandler] tryfrom remotedownloadposterto localsave`);
        const response = await fetch(posterUrl);
        this.logger.info(`[MP4PosterHandler] fetch response: ok=${response.ok}, status=${response.status}`);
        if (response.ok) {
          const blob = await response.blob();
          this.logger.info(`[MP4PosterHandler] poster blob size: ${blob.size}`);
          const reader = new FileReader();
          reader.onloadend = async () => {
            const dataUrl = reader.result;
            this.logger.info(`[MP4PosterHandler] FileReader convertcompleted, dataUrllength=${dataUrl?.length || 0}`);
            this.logger.info(`[MP4PosterHandler] call _saveAndSetPoster saveto local`);
            await this._saveAndSetPoster(transferId, dataUrl, component);
          };
          reader.onerror = (err) => {
            this.logger.error(`[MP4PosterHandler] ❌ FileReader readposterdatafailed:`, err);
          };
          reader.readAsDataURL(blob);
        } else {
          this.logger.warn(`[MP4PosterHandler] ❌ downloadposterfailed: HTTP ${response.status} ${response.statusText}, URL: ${posterUrl}`);
        }
      } catch (e) {
        this.logger.error(`[MP4PosterHandler] ❌ trydownload and localsaveposterfailed: ${e.message}, URL: ${posterUrl}`);
      }
    } catch (error) {
      this.logger.error(`[MP4PosterHandler] ❌ _loadPosterImage exception:`, error);
    }
  }
}
