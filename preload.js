const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Batch request ID counter
let batchRequestId = 0;

// Batch request handler function
function batchIpcRequest(requests) {
  const requestId = ++batchRequestId;
  const pending = new Map();

  requests.forEach(req => {
    pending.set(req.id, {
      resolve: null,
      reject: null,
      promise: new Promise((resolve, reject) => {
        pending.set(req.id, { ...pending.get(req.id), resolve, reject });
      })
    });
  });

  ipcRenderer.invoke('ipc-batch', { requestId, requests })
    .then(response => {
      if (response && response.results) {
        response.results.forEach(({ id, success, result, error }) => {
          const entry = pending.get(id);
          if (entry && entry.resolve) {
            if (success) {
              entry.resolve(result);
            } else {
              entry.reject(new Error(error));
            }
          }
        });
      }
    })
    .catch(err => {
      requests.forEach(req => {
        const entry = pending.get(req.id);
        if (entry && entry.reject) {
          entry.reject(err);
        }
      });
    });

  return requests.map(req => pending.get(req.id)?.promise || Promise.reject('Request not found'));
}

// Safely expose IPC APIs to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Batch IPC requests
  batchIpcRequest,

  // Get the real file path (recommended way for Electron 20+)
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (e) {
      console.error('Failed to get file path:', e);
      return file.path || '';
    }
  },
  readEmailConfigs: () => ipcRenderer.invoke('read-email-configs'),
  fetchEmails: (config, minutes, onlySignaling) => ipcRenderer.invoke('fetch-emails', config, minutes, onlySignaling),
  // 🚀 Fetch signaling emails and regular emails in parallel (using two independent Workers)
  fetchEmailsParallel: (config, signalingMinutes) => ipcRenderer.invoke('fetch-emails-parallel', config, signalingMinutes),
  // 🔄 Send emails asynchronously: return taskId immediately, emails are sent in background
  // Returns: { success: true, taskId: string, message: string }
  sendemail: (config, emailData) => ipcRenderer.invoke('sendmail', config, emailData),
  // 📬 Listen for email send result: triggered when email send completes or fails
  // Event data: { success: boolean, taskId: string, messageId?: string, error?: string }
  onSendmailResult: (callback) => ipcRenderer.on('sendmail-result', (event, result) => callback(result)),
  // 🧹 Remove email send result listener
  offSendmailResult: (callback) => ipcRenderer.off('sendmail-result', callback),
  loginImapConnection: (config) => ipcRenderer.invoke('login-imap-connection', config),
  preWarmImapConnection: (config) => ipcRenderer.invoke('pre-warm-imap-connection', config),
  prewarmSmtp: (config) => ipcRenderer.invoke('prewarm-smtp', config),
  getCurrentConfig: () => ipcRenderer.invoke('get-current-config'),
  checkAndCreateDatabase: (emailUsername) => ipcRenderer.invoke('checkAndCreateDatabase', emailUsername),
  resetDatabase: (emailUsername) => ipcRenderer.invoke('reset-database', emailUsername),
  searchAndDeleteEmails: (config, sender, subjectPrefix, options) => ipcRenderer.invoke('search-and-delete-emails', config, sender, subjectPrefix, options),
  deleteEmailsByUid: (config, uids) => ipcRenderer.invoke('delete-emails-by-uid', config, uids),
  loadEmailConfigsFromDB: () => ipcRenderer.invoke('load-email-configs-from-db'),
  saveEmailConfig: (config) => ipcRenderer.invoke('save-email-config', config),
  updateEmailConfig: (id, config) => ipcRenderer.invoke('update-email-config', id, config),
  disconnectImap: (config) => ipcRenderer.invoke('disconnect-imap', config),
  getImapStatus: (username) => ipcRenderer.invoke('get-imap-status', username),
  saveChatMessage: (data) => ipcRenderer.invoke('save-chat-message', data),
  getUnsentMessages: (query) => ipcRenderer.invoke('get-unsent-messages', query),
  getPendingImages: (query) => ipcRenderer.invoke('get-pending-images', query),
  updateMessageStatus: (data) => ipcRenderer.invoke('update-message-status', data),
  updateChatMessageContent: (data) => ipcRenderer.invoke('update-chat-message-content', data),
  deleteChatMessage: (msgId) => ipcRenderer.invoke('delete-chat-message', msgId),
  getChatMessageByMsgid: (data) => ipcRenderer.invoke('get-chat-message-by-msgid', data),
  getContacts: (username, options) => ipcRenderer.invoke('get-contacts', username, options),
  addContact: (username, contactData) => ipcRenderer.invoke('add-contact', username, contactData),
  updateContact: (username, contactData) => ipcRenderer.invoke('update-contact', username, contactData),
  deleteContact: (username, contactEmail) => ipcRenderer.invoke('delete-contact', username, contactEmail),
  getHistoryMessages: (query) => ipcRenderer.invoke('get-history-messages', query),
  clearChatHistory: (data) => ipcRenderer.invoke('clear-chat-history', data),
  markMessageRead: (data) => ipcRenderer.invoke('mark-message-read', data),
  markEmailMessageRead: (data) => ipcRenderer.invoke('mark-email-message-read', data),
  markAllMessagesRead: (data) => ipcRenderer.invoke('mark-all-messages-read', data),
  getUnreadCount: (data) => ipcRenderer.invoke('get-unread-count', data),
  getTotalUnreadCount: (data) => ipcRenderer.invoke('get-total-unread-count', data),
  // Write to log file
  writeFile: (filePath, content, append) => ipcRenderer.invoke('write-file', filePath, content, append),
  // Signaling transfer state management
  signalingState: (action) => ipcRenderer.invoke('signaling-state', action),
  // Listen for signaling state changes (used for signaling mode linkage)
  onSignalingStateChanged: (callback) => ipcRenderer.on('signaling-state-changed', callback),
  // Save received file
  saveReceivedFile: (fileName, fileData, userId) => ipcRenderer.invoke('save-received-file', fileName, fileData, userId),
  // Stream write file chunks
  streamWriteFileChunk: (fileName, fileData, offset, totalSize, msgId, userId, flush, storedFileName) => ipcRenderer.invoke('stream-write-file-chunk', fileName, fileData, offset, totalSize, msgId, userId, flush, storedFileName),
  // File transfer metadata persistence
  getTransferMetadata: (data) => ipcRenderer.invoke('get-transfer-metadata', data),
  findIncompleteTransferByHashAndSize: (data) => ipcRenderer.invoke('find-incomplete-transfer-by-hash', data),
  updateTransferMetadata: (data) => ipcRenderer.invoke('update-transfer-metadata', data),
  deleteTransferMetadata: (data) => ipcRenderer.invoke('delete-transfer-metadata', data),
  // Complete streaming file write
  finalizeStreamFile: (fileName, msgId, totalSize, userId) => ipcRenderer.invoke('finalize-stream-file', fileName, msgId, totalSize, userId),
  // Get path of sent file
  getSentFilePath: (fileName, isSender, userId) => ipcRenderer.invoke('get-sent-file-path', fileName, isSender, userId),
  // Get file size
  getFileSize: (filePath) => ipcRenderer.invoke('get-file-size', filePath),
  // Get file status (size, modification time, etc.)
  getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
  // Show save dialog
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  // Copy file
  copyFile: (sourcePath, targetPath) => ipcRenderer.invoke('copy-file', sourcePath, targetPath),
  // Show file in folder
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
  // Open file with system default program
  openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
  // Open image preview in new window (for web image formats like webp, svg)
  openImagePreviewWindow: (filePath, filename) => ipcRenderer.invoke('open-image-preview-window', { filePath, filename }),
  // Copy file to sends directory
  copyFileToSends: (sourcePath, transferId, userId) => ipcRenderer.invoke('copy-file-to-sends', sourcePath, transferId, userId),
  // Save sent file (when no local path)
  saveSentFile: (fileName, fileData, userId) => ipcRenderer.invoke('save-sent-file', fileName, fileData, userId),
  // Read file and convert to Base64
  readFileAsBase64: (filePath) => ipcRenderer.invoke('read-file-as-base64', filePath),
  // Batch write files
  batchWriteFiles: (fileList) => ipcRenderer.invoke('batch-write-files', fileList),
  // Get HTTP service port
  getHttpServerPort: () => ipcRenderer.invoke('get-http-server-port'),
  // Toggle developer tools
  toggleDevTools: () => ipcRenderer.invoke('toggle-devtools'),
  // Add new mail event listener
  onNewMail: (callback) => ipcRenderer.on('imap-new-mail', callback),
  // Listen for recv table email update events
  onRecvEmailsUpdated: (callback) => ipcRenderer.on('recv-emails-updated', callback),
  // Listen for new chat messages (emails converted to chat messages)
  onNewChatMessages: (callback) => ipcRenderer.on('new-chat-messages', callback),
  // Remove chat message listener
  offNewChatMessages: (callback) => ipcRenderer.removeListener('new-chat-messages', callback),
  // Listen for chat message content updates (e.g., after mailink_picture image download completes)
  onChatMessageContentUpdated: (callback) => ipcRenderer.on('chat-message-content-updated', callback),
  // Log (optionally pass userId to write to user-specific directory)
  log: (level, message, module, userId) => ipcRenderer.invoke('log-message', { level, message, module, userId }),
  // Get renderer process ID
  getRendererId: () => ipcRenderer.invoke('get-renderer-id'),
  // Tray icon flash control
  startTrayFlash: (avatarData) => ipcRenderer.invoke('start-tray-flash', avatarData),
  stopTrayFlash: () => ipcRenderer.invoke('stop-tray-flash'),
  // Set tray icon to current user avatar
  setTrayIconToUserAvatar: (avatarData) => ipcRenderer.invoke('set-tray-icon-to-user-avatar', avatarData),
  resetTrayIconToDefault: () => ipcRenderer.invoke('reset-tray-icon-to-default'),
  // Local email database operations
  getLocalEmails: (params) => ipcRenderer.invoke('get-local-emails', params),
  getLocalEmailDetail: (params) => ipcRenderer.invoke('get-local-email-detail', params),
  getLocalEmailByMessageId: (params) => ipcRenderer.invoke('get-local-email-by-message-id', params),
  fetchEmailBody: (params) => ipcRenderer.invoke('fetch-email-body', params),
  deleteLocalEmail: (params) => ipcRenderer.invoke('delete-local-email', params),
  getLocalSenders: (params) => ipcRenderer.invoke('get-local-senders', params),
  getRecvUnreadCount: (params) => ipcRenderer.invoke('get-recv-unread-count', params),
  markRecvEmailRead: (params) => ipcRenderer.invoke('mark-recv-email-read', params),
  batchMarkRecvEmailsRead: (params) => ipcRenderer.invoke('batch-mark-recv-emails-read', params),
  markAllEmailsAsRead: (params) => ipcRenderer.invoke('mark-all-emails-as-read', params),
  // Read clipboard content (files, images, text)
  clipboardReadFiles: () => ipcRenderer.invoke('clipboard-read-files'),
  // Save video cover image
  saveVideoPoster: (params) => ipcRenderer.invoke('save-video-poster', params),
  // Generate image thumbnail
  generateThumbnail: (filePath, maxWidth) => ipcRenderer.invoke('generate-thumbnail', { filePath, maxWidth }),
  // Receiver saves video cover image (save to recvs directory)
  saveReceiverVideoPoster: (params) => ipcRenderer.invoke('save-receiver-video-poster', params),
  // Download email attachment (traditional way)
  downloadEmailAttachment: (params) => ipcRenderer.invoke('download-email-attachment', params),
  // Resume download of email attachment
  downloadAttachmentResumable: (params) => ipcRenderer.invoke('download-attachment-resumable', params),
  // Check download task status (used for resume)
  checkDownloadTask: (params) => ipcRenderer.invoke('check-download-task', params),
  // Cancel download task
  cancelDownload: (params) => ipcRenderer.invoke('cancel-download', params),
  // Update attachment download status
  updateAttachmentStatus: (params) => ipcRenderer.invoke('update-attachment-status', params),
  verifyAttachmentFile: (params) => ipcRenderer.invoke('verify-attachment-file', params),
  // Calculate file hash
  calculateFileHash: (params) => ipcRenderer.invoke('calculate-file-hash', params),
  // Listen for download progress
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', callback),
  // Remove download progress listener
  offDownloadProgress: (callback) => ipcRenderer.removeListener('download-progress', callback),
  // Window control (minimize, maximize, close)
  windowControl: (action) => ipcRenderer.send('window-control', action),
  // Backup contacts to email
  backupContacts: (username, smtpConfig) => ipcRenderer.invoke('backup-contacts', { username, smtpConfig }),
  // Listen for contact restore completion event
  onContactsRestored: (callback) => ipcRenderer.on('contacts-restored', callback),
  // Remove contact recovery completion listener
  offContactsRestored: (callback) => ipcRenderer.removeListener('contacts-restored', callback),
  // After successful login, restore window size and show developer tools
  loginSuccess: () => ipcRenderer.invoke('login-success')
});