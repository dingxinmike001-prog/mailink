import { decodeHtmlEntities, dedupeImageMessageHtml, normalizeEmail, resolveIsSender, inferIsSenderFromMessageContent, parseFileSize } from './chat-utils.js';
import { handleChatMessage, processChatMessage, sendMessage, handleCarryTextMessage, processCarryTextMessage } from './chat-message.js';
import { getUnsentMessagesForEmail } from '../../../utils/message-utils.js';
import { loadHistoryMessages, displayHistoryMessages, displayHistoryMessagesOptimized, displayHistoryMessagesLegacy, markMessagesAsSent } from './chat-history.js';
import { _renderHistoryFileMessage } from './chat-file-render.js';
import { checkAndUpdateFileTransfers } from './chat-file-update.js';

export class ChatManager {
  constructor(context) {
    this.context = context;
    this._processedUnreadMsgIds = new Set();
    this.setupEventListeners();
  }

  setupEventListeners() {
    this.context.eventBus.on('datachannel:messageReceived', (data) => {
      if (data.type === 'chat' && data.content) {
        handleChatMessage(this.context, data);
      }
    });

    this.context.eventBus.on('chat:receiveCarryTextMessage', (data) => {
      handleCarryTextMessage(this.context, data);
    });
  }

  decodeHtmlEntities(input) {
    return decodeHtmlEntities(input);
  }

  dedupeImageMessageHtml(inputHtml) {
    return dedupeImageMessageHtml(inputHtml);
  }

  handleChatMessage(data) {
    return handleChatMessage(this.context, data);
  }

  processChatMessage(data, unescapedContent) {
    return processChatMessage(this.context, data, unescapedContent);
  }

  sendMessage(plainTextMsg) {
    return sendMessage(this.context, plainTextMsg);
  }

  getUnsentMessagesForEmail(toEmail) {
    return getUnsentMessagesForEmail(toEmail);
  }

  loadHistoryMessages(fromEmail = null, toEmail = null) {
    return loadHistoryMessages(this.context, fromEmail, toEmail);
  }

  displayHistoryMessages(messages) {
    return displayHistoryMessages(this.context, messages);
  }

  async _renderHistoryFileMessage(msg, sender, senderEmail, parseResult) {
    return await _renderHistoryFileMessage(this.context, msg, sender, senderEmail, parseResult);
  }

  checkAndUpdateFileTransfers(messages) {
    return checkAndUpdateFileTransfers(this.context, messages);
  }

  normalizeEmail(email) {
    return normalizeEmail(email);
  }

  resolveIsSender(msg, normalizedMyEmail = null) {
    return resolveIsSender(msg, this.context);
  }

  inferIsSenderFromMessageContent(content) {
    return inferIsSenderFromMessageContent(content);
  }

  parseFileSize(sizeStr) {
    return parseFileSize(sizeStr);
  }

  markMessagesAsSent(messages) {
    return markMessagesAsSent(this.context, messages);
  }

  handleCarryTextMessage(data) {
    return handleCarryTextMessage(this.context, data);
  }

  processCarryTextMessage(data, from, id, content, timestamp) {
    return processCarryTextMessage(this.context, data, from, id, content, timestamp);
  }
}
