import { HistoryMessageParser } from './file-transfer/history-message-parser.js';
import { decodeHtmlEntities, dedupeImageMessageHtml, normalizeEmail } from './chat-utils.js';

class HistoryParserWorkerManager {
  constructor() {
    this.worker = null;
    this.pendingTasks = new Map();
    this.taskIdCounter = 0;
    this.isReady = false;
    this.readyPromise = null;
  }

  _getWorkerPath() {
    const currentPath = import.meta.url;
    const basePath = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
    return new URL('./file-transfer/history-message-parser.worker.js', basePath).href;
  }

  async init() {
    if (this.worker) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(this._getWorkerPath(), { type: 'module' });

        this.worker.onmessage = (event) => {
          const { type, taskId, payload } = event.data;

          if (type === 'ready') {
            this.isReady = true;
            resolve();
            return;
          }

          const pendingTask = this.pendingTasks.get(taskId);
          if (pendingTask) {
            this.pendingTasks.delete(taskId);
            pendingTask.resolve(payload);
          }
        };

        this.worker.onerror = (error) => {
          console.error('[HistoryParserWorker] Worker error:', error);
          if (!this.isReady) {
            reject(error);
          }
        };
      } catch (error) {
        console.error('[HistoryParserWorker] Failed to create Worker:', error);
        reject(error);
      }
    });

    return this.readyPromise;
  }

  async parseBatch(messages) {
    if (!this.isReady) {
      await this.init();
    }

    const taskId = ++this.taskIdCounter;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        reject(new Error('Worker timeout'));
      }, 30000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject
      });

      this.worker.postMessage({
        type: 'parseBatch',
        taskId,
        payload: { messages }
      });
    });
  }

  async sortAndParseBatch(messages) {
    if (!this.isReady) {
      await this.init();
    }

    const taskId = ++this.taskIdCounter;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        reject(new Error('Worker timeout'));
      }, 30000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject
      });

      this.worker.postMessage({
        type: 'sortAndParseBatch',
        taskId,
        payload: { messages }
      });
    });
  }

  async parse(content) {
    if (!this.isReady) {
      await this.init();
    }

    const taskId = ++this.taskIdCounter;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        reject(new Error('Worker timeout'));
      }, 5000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeoutId);
          resolve(result);
        },
        reject
      });

      this.worker.postMessage({
        type: 'parse',
        taskId,
        payload: { content }
      });
    });
  }

  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isReady = false;
      this.pendingTasks.clear();
    }
  }
}

const workerManager = new HistoryParserWorkerManager();

export async function loadHistoryMessages(context, fromEmail = null, toEmail = null) {
  const myEmail = context.myEmail;
  const targetEmail = toEmail || fromEmail || context.targetEmail || '';

  if (!myEmail || !targetEmail) {
    console.error('Cannot load history: missing email info');
    return;
  }

  if (window._webp2pAvatar && window._webp2pAvatar.getAvatar) {
    try {
      await Promise.all([
        window._webp2pAvatar.getAvatar(myEmail),
        window._webp2pAvatar.getAvatar(targetEmail)
      ]);
    } catch (e) {
      console.error('Preload avatar failed:', e);
    }
  }

  try {
    const messages = await window.electronAPI.getHistoryMessages({
      myEmail,
      targetEmail
    });

    await displayHistoryMessages(context, messages);
  } catch (error) {
    console.error('Load history messages failed:', error);
  }
}

export async function displayHistoryMessages(context, messages) {
  try {
    await displayHistoryMessagesOptimized(context, messages);
  } catch (error) {
    context.logger.error('[ChatManager] Optimized version failed to load, using fallback:', error);
    displayHistoryMessagesLegacy(context, messages);
  }
}

export async function displayHistoryMessagesOptimized(context, messages) {
  if (context.uiRenderer.clearChatDisplay) {
    context.uiRenderer.clearChatDisplay();
  }

  if (!messages || !Array.isArray(messages)) {
    console.error('Cannot display history: invalid messages format');
    return;
  }

  const myEmail = normalizeEmail(context.myEmail);
  
  if (context.uiRenderer.showLoadingIndicator) {
    context.uiRenderer.showLoadingIndicator(true, 'Loading history messages...');
  }

  let sortedMessages;
  let parseResults;

  try {
    const result = await workerManager.sortAndParseBatch(messages);
    sortedMessages = result.sortedMessages;
    parseResults = result.parseResults;
    console.log('[ChatHistory] Worker sorting and parsing completed, message count:', sortedMessages.length);
  } catch (error) {
    console.warn('[ChatHistory] Worker processing failed, falling back to main thread:', error);
    sortedMessages = [...messages].sort((a, b) => a.id - b.id);
    parseResults = sortedMessages.map((msg, index) => ({
      index,
      msgId: msg.msgid || msg.id,
      parseResult: HistoryMessageParser.parse(msg.content)
    }));
  }

  const parseResultMap = new Map();
  for (const result of parseResults) {
    parseResultMap.set(result.msgId, result.parseResult);
  }

  let pendingMessagesCount = 0;
  const BATCH_SIZE = 20;
  const totalMessages = sortedMessages.length;

  for (let i = 0; i < totalMessages; i++) {
    const msg = sortedMessages[i];
    const sender = resolveIsSenderHistory(msg, myEmail) ? 'Me' : 'Peer';
    const senderEmail = sender === 'Me' ? (myEmail || msg.fromer) : msg.fromer;

    const msgId = msg.msgid || msg.id;
    const fileParseResult = parseResultMap.get(msgId);

    if (fileParseResult && context._renderHistoryFileMessage) {
      await context._renderHistoryFileMessage(
        msg,
        sender,
        senderEmail,
        fileParseResult
      );
    } else {
      let unescapedContent = decodeHtmlEntities(msg.content);
      unescapedContent = dedupeImageMessageHtml(unescapedContent);

      // Debug email message is_read status
      // Detect email messages: start with 📧 or contain email-image-message class
      const isEmailMessage = unescapedContent.trimStart().startsWith('📧') || 
                             unescapedContent.includes('email-image-message') ||
                             unescapedContent.includes('email-subject-line');
      if (isEmailMessage) {
        console.log('[ChatHistory] Loading email message:', { msgId, emid: msg.emid, is_read: msg.is_read, content: unescapedContent.substring(0, 100) });
      }

      if (context.uiRenderer.displayMessage) {
        context.uiRenderer.displayMessage(
          sender,
          unescapedContent,
          msgId,
          msg.createtime,
          senderEmail,
          msg.status,
          msg.emid || '',
          msg.is_read || 0
        );
      }
    }

    if (resolveIsSenderHistory(msg, myEmail) && msg.status < 100) {
      pendingMessagesCount++;
    }

    if (i > 0 && i % BATCH_SIZE === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (context.uiRenderer.showLoadingIndicator) {
    context.uiRenderer.showLoadingIndicator(false);
  }

  setTimeout(() => {
    if (context.checkAndUpdateFileTransfers) {
      context.checkAndUpdateFileTransfers(sortedMessages).catch(error => {
        context.logger.error(`[ChatManager] Failed to check file transfer status:`, error);
      });
    }
  }, 100);

  if (sortedMessages.length > 0) {
    const lastMessage = sortedMessages[sortedMessages.length - 1];
    const unescapedLastMessage = decodeHtmlEntities(lastMessage.content);
    context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
      detail: {
        email: context.targetEmail,
        message: unescapedLastMessage
      },
      bubbles: true,
      composed: true
    }));
    context.logger.info(`📋 History loaded, synced last message to contact card`);
  }
}

export function displayHistoryMessagesLegacy(context, messages) {
  if (context.uiRenderer.clearChatDisplay) {
    context.uiRenderer.clearChatDisplay();
  }

  if (!messages || !Array.isArray(messages)) {
    console.error('Cannot display history: invalid messages format');
    return;
  }
  const myEmail = normalizeEmail(context.myEmail);

  messages.sort((a, b) => a.id - b.id);

  console.log('Loaded history messages count:', messages.length);

  let pendingMessagesCount = 0;

  messages.forEach(msg => {
    let unescapedContent = decodeHtmlEntities(msg.content);
    unescapedContent = dedupeImageMessageHtml(unescapedContent);

    const sender = resolveIsSenderHistory(msg, myEmail) ? 'Me' : 'Peer';
    const senderEmail = sender === 'Me' ? (myEmail || msg.fromer) : msg.fromer;

    // Debug email message is_read status (Legacy mode)
    const msgId = msg.msgid || msg.id;
    const isEmailMessage = unescapedContent.trimStart().startsWith('📧') || 
                           unescapedContent.includes('email-image-message') ||
                           unescapedContent.includes('email-subject-line');
    if (isEmailMessage) {
      console.log('[ChatHistory] Legacy mode loading email message:', { msgId, emid: msg.emid, is_read: msg.is_read, content: unescapedContent.substring(0, 100) });
    }

    if (context.uiRenderer.displayMessage) {
      context.uiRenderer.displayMessage(sender, unescapedContent, msgId, msg.createtime, senderEmail, msg.status, msg.emid || '', msg.is_read || 0);
    }

    if (resolveIsSenderHistory(msg, myEmail) && msg.status < 100) {
      pendingMessagesCount++;
    }
  });

  setTimeout(() => {
    if (context.checkAndUpdateFileTransfers) {
      context.checkAndUpdateFileTransfers(messages).catch(error => {
        context.logger.error(`[ChatManager] Failed to check file transfer status:`, error);
      });
    }
  }, 100);

  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    const unescapedLastMessage = decodeHtmlEntities(lastMessage.content);
    context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
      detail: {
        email: context.targetEmail,
        message: unescapedLastMessage
      },
      bubbles: true,
      composed: true
    }));
    context.logger.info(`📋 History loaded, synced last message to contact card`);
  }
}

function resolveIsSenderHistory(msg, myEmail) {
  const fromEmail = normalizeEmail(msg.fromer);
  const toEmail = normalizeEmail(msg.toer);

  if (myEmail) {
    return fromEmail === myEmail;
  }

  return false;
}

export async function markMessagesAsSent(context, messages) {
  if (!messages || messages.length === 0) return;

  if (window.electronAPI && window.electronAPI.updateMessageStatus) {
    const myEmail = context.myEmail;
    for (const msg of messages) {
      try {
         const msgId = msg.msgid || msg.id;
         await window.electronAPI.updateMessageStatus({
           msgid: msgId,
           status: 100,
           fromer: myEmail,
           dbUser: myEmail
         });

         if (context.uiRenderer.markMessageAsConfirmed) {
           await context.uiRenderer.markMessageAsConfirmed(msgId);
         }
      } catch (e) {
        context.logger.error(`Failed to mark message ${msg.id} as sent: ${e}`);
      }
    }
  }
}
