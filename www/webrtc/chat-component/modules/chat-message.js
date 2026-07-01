import { decodeHtmlEntities, dedupeImageMessageHtml } from './chat-utils.js';
import { avatarCache } from '../../../utils/avatar-cache.js';
import { svgToPngDataUrl, isSvgString } from '../../../utils/image-utils.js';
import { getUnsentMessagesForEmail, updateMessageStatus } from '../../../utils/message-utils.js';

export function _isCurrentChatActive(context, fromEmail) {
  if (!fromEmail) return false;
  const targetEmail = context.targetEmail;
  if (!targetEmail) return false;
  return fromEmail.toLowerCase() === targetEmail.toLowerCase();
}

export function _isUserActiveInChat(context) {
  return context.isUserActive ? context.isUserActive() : false;
}

export async function _markMessagesAsRead(context, myEmail, targetEmail) {
  try {
    if (window.electronAPI && window.electronAPI.markAllMessagesRead) {
      await window.electronAPI.markAllMessagesRead({
        myEmail: myEmail,
        targetEmail: targetEmail
      });
      context.logger.info(`✅ Marked messages as read for ${targetEmail}`);
    }
  } catch (err) {
    console.error('Failed to mark messages as read:', err);
  }
}

export function _notifyUnreadIncrement(context, _processedUnreadMsgIds, fromEmail, msgId = null) {
  if (msgId) {
    const normalizedMsgId = String(msgId);
    if (_processedUnreadMsgIds.has(normalizedMsgId)) {
      context.logger.debug(`⏭️ _notifyUnreadIncrement: message ${normalizedMsgId} Processed, skip`);
      return;
    }
    _processedUnreadMsgIds.add(normalizedMsgId);

    setTimeout(() => {
      _processedUnreadMsgIds.delete(normalizedMsgId);
    }, 5000);
  }

  context.element.dispatchEvent(new CustomEvent('increment-unread-count', {
    detail: {
      email: fromEmail,
      msgId: msgId ? String(msgId) : null
    },
    bubbles: true,
    composed: true
  }));
}

// Note: svgToPngDataUrl is imported from '../../../utils/image-utils.js'

export async function _triggerTrayFlash(context, fromEmail = null) {
  if (window.electronAPI && window.electronAPI.startTrayFlash) {
    try {
      let avatarData = null;
      
      // If sender email is provided, try to fetch avatar
      if (fromEmail) {
        const normalizedEmail = String(fromEmail).trim().toLowerCase();
        
        // 1. First try cache
        if (avatarCache.has(normalizedEmail)) {
          avatarData = avatarCache.get(normalizedEmail);
        } else if (window.electronAPI && window.electronAPI.getContacts) {
          // 2. Get contact avatar from database
          try {
            const myEmail = context.myEmail;
            const contacts = await window.electronAPI.getContacts(myEmail);
            const contact = contacts.find(c => 
              String(c.username).trim().toLowerCase() === normalizedEmail
            );
            if (contact && contact.avatar) {
              avatarData = contact.avatar;
              // Cache avatar
              avatarCache.set(normalizedEmail, avatarData);
            }
          } catch (e) {
            context.logger.warn('failed to get contact avatar:', e);
          }
        }
        
        // 3. If avatar data is SVG, convert to PNG (tray doesn't support SVG)
        if (avatarData && avatarData.startsWith('<svg')) {
          context.logger.info('🎨 contact avatar is SVG format, convert as PNG...');
          const pngDataUrl = await svgToPngDataUrl(avatarData);
          if (pngDataUrl) {
            avatarData = pngDataUrl;
            context.logger.info('✅ SVG avatarconvertsucceeded');
          } else {
            context.logger.warn('⚠️ SVG avatar convert failed, will use default icon');
            avatarData = null;
          }
        }
      }
      
      await window.electronAPI.startTrayFlash(avatarData);
      context.logger.info(`🔔 triggered tray icon flash${avatarData ? ' (usecontact avatar)' : ''}`);
    } catch (err) {
      context.logger.error('trigger tray flash failed:', err);
    }
  }
}

export function _playNotificationSound(context) {
  try {
    const port = context.httpServerPort || 8080;
    const audio = new Audio(`http://127.0.0.1:${port}/assets/new.mp3`);
    audio.play().catch(err => {
      context.logger.debug('play notification audio failed:', err);
    });
  } catch (err) {
    context.logger.debug('create audio peer object failed:', err);
  }
}

export async function handleChatMessage(context, data) {
  const unescapedContent = decodeHtmlEntities(data.content);

  if (data.id && context.fileTransferManager) {
    const alreadyDisplayed = context.fileTransferManager.isMessageDisplayed(data.id);
    if (alreadyDisplayed) {
      context.logger.info(`⏭️ handleChatMessage: messageDisplayed, skip duplicate display: ${data.id}`);
      return;
    }
  }
  await processChatMessage(context, data, unescapedContent);
}

export async function processChatMessage(context, data, unescapedContent) {
  const fromEmail = data.from || context.targetEmail || 'unknown';
  const isCurrentChatActive = _isCurrentChatActive(context, fromEmail);

  await _triggerTrayFlash(context, fromEmail);
  _playNotificationSound(context);

  if (window.electronAPI && window.electronAPI.saveChatMessage) {
    const myEmail = context.myEmail;
    window.electronAPI.saveChatMessage({
      fromer: fromEmail,
      toer: myEmail || '',
      content: unescapedContent,
      type: 2,
      status: 100,
      msgid: data.id || ''
    }).then(async (result) => {
      if (result && (result.skipped || result.updated)) {
        context.logger.info('🔁 Message already exists, skipping UI display: ' + (data.id || 'unknown'));
      } else {
        context.logger.info('✅ Received message saved to DB');
        context.uiRenderer.displayMessage('peer', unescapedContent, null, null, null, 100);
        context.logger.info('New message received');

        context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
          detail: {
            email: fromEmail,
            message: unescapedContent
          },
          bubbles: true,
          composed: true
        }));

        _notifyUnreadIncrement(context, new Set(), fromEmail, data.id);
      }
    }).catch(async err => {
      console.error('Failed to save received message:', err);
      context.uiRenderer.displayMessage('peer', unescapedContent, null, null, null, 100);
      context.logger.info('New message received');

      context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
        detail: {
          email: fromEmail,
          message: unescapedContent
        },
        bubbles: true,
        composed: true
      }));

      _notifyUnreadIncrement(context, new Set(), fromEmail, data.id);
    });
  } else {
    context.uiRenderer.displayMessage('peer', unescapedContent, null, null, null, 100);
    context.logger.info('New message received');

    context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
      detail: {
        email: fromEmail,
        message: unescapedContent
      },
      bubbles: true,
      composed: true
    }));

    _notifyUnreadIncrement(context, new Set(), fromEmail, data.id);
  }
}

export async function sendMessage(context, plainTextMsg) {
  if (!plainTextMsg) return;

  if (!context.targetEmail) {
    alert(window.i18n?.t ? window.i18n.t('chat.pleaseConnectRecipient') : 'Please connect to the recipient first');
    return;
  }

  const htmlMsg = context.utils.textToHtml(plainTextMsg);
  const sanitizedHtmlMsg = context.utils.sanitizeHtml(htmlMsg);

  const isConnected = context.connection && context.connection.isConnected();
  let msgId = null;
  let generatedMsgId = null;
  let dbInfoStr = '';

  try {
    if (window.electronAPI && window.electronAPI.saveChatMessage) {
      if (context.utils.generateMessageId) {
        generatedMsgId = context.utils.generateMessageId();
      }

      const result = await window.electronAPI.saveChatMessage({
        fromer: context.myEmail || '',
        toer: context.targetEmail || '',
        content: sanitizedHtmlMsg,
        type: 1,
        status: isConnected ? 100 : 50,
        msgid: generatedMsgId || ''
      });

      if (result.dbName && result.tableName) {
        dbInfoStr = ` [saved to: ${result.dbName} table: ${result.tableName}]`;
      }
      if (generatedMsgId) {
        msgId = generatedMsgId;
      } else if (result.id) {
        msgId = result.id;
      }
    }
  } catch (error) {
    context.logger.error('savemessagefailed:' + error);
  }

  if (!msgId) {
    msgId = 'temp-' + Date.now();
  }

  if (isConnected) {
    // Connected: send directly via DataChannel and mark as completed
    const payload = {
      type: 'chat',
      id: msgId,
      content: sanitizedHtmlMsg
    };
    context.connection.sendData(payload);

    context.uiRenderer.displayMessage('Me', sanitizedHtmlMsg, msgId, null, null, 100);
    context.logger.info('Sentmessage' + dbInfoStr);
  } else {
    // Not connected: send via email
    // Note: after text message is sent via email, status is updated to 100,
    // no need to retransmit via DataChannel after subsequent WebRTC connection succeeds
    context.uiRenderer.displayMessage('Me', sanitizedHtmlMsg, msgId, null, null, 50);
    context.logger.info('messageSending... (via email)' + dbInfoStr);
    
    // Immediately query and send unsent messages (status < 100)
    // After email is sent successfully, status is auto-updated to 100 and UI refreshed
    await sendUnsentMessagesViaEmail(context);
  }

  context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
    detail: {
      email: context.targetEmail,
      message: plainTextMsg
    },
    bubbles: true,
    composed: true
  }));
}

/**
 * Send all unsent messages via email (including text and images, status < 100)
 */
async function sendUnsentMessagesViaEmail(context) {
  try {
    if (!window.electronAPI || !window.electronAPI.getUnsentMessages) {
      context.logger.warn('getUnsentMessages API unavailable');
      return;
    }
    
    if (!window.electronAPI.sendemail) {
      context.logger.warn('sendemail API unavailable');
      return;
    }

    const myEmail = context.myEmail;
    if (!myEmail) {
      context.logger.warn('unable to get current email address');
      return;
    }

    // Query all messages with status < 100 from database
    const params = { fromer: myEmail, toer: context.targetEmail };
    const messages = await window.electronAPI.getUnsentMessages(params);
    
    if (!messages || messages.length === 0) {
      context.logger.debug('no need to send unsent message via email');
      return;
    }

    context.logger.info(`📧 found ${messages.length} unsent messages, start sending via email`);

    // Get current email config
    const config = window.electronAPI.getCurrentConfig 
      ? await window.electronAPI.getCurrentConfig()
      : null;

    if (!config) {
      context.logger.error('unable to get email config');
      return;
    }

    for (const msg of messages) {
      // Only process unsent or sending messages (status < 100)
      if (msg.status >= 100) continue;

      try {
        const messageId = msg.msgid || msg.id;
        
        // Determine message type
        let isImageMessage = false;
        let imageFilePath = null;
        let subject = '';
        let attachments = [];
        let textContent = '';

        // Judge based on message type
        if (!msg.type || msg.type === 1) {
          // Text message
          // Extract plain text content (remove HTML tags)
          let plainContent = msg.content.replace(/<[^>]*>/g, '');
          
          // Build email subject: mailink_text: + first 32 chars of content
          const subjectSuffix = plainContent.length > 32 
            ? plainContent.substring(0, 32) 
            : plainContent;
          subject = `mailink_text:${subjectSuffix}`;
          textContent = msg.content;  // Email body contains full HTML content

        } else if (msg.type === 3 || (msg.type >= 3 && msg.type <= 5)) {
          // Image message (type=3 image, type=4/5 may be other media)
          isImageMessage = true;
          
          // Extract file name from message content
          let fileName = extractFileNameFromContent(msg.content);
          
          // Build email subject: mailink_picture:[full file name]
          subject = `mailink_picture:${fileName}`;

          // Try to get saved image file path
          if (window.electronAPI.getSentFilePath) {
            try {
              const result = await window.electronAPI.getSentFilePath({
                fileName: fileName,
                isSender: true,
                userId: myEmail
              });
              
              if (result && result.success && result.filePath) {
                imageFilePath = result.filePath;
                attachments = [{ path: result.filePath }];
                context.logger.info(`🖼️ found image file path: ${imageFilePath}`);
              }
            } catch (fileError) {
              context.logger.warn(`⚠️ unable to get image file path: ${fileError.message}`);
            }
          }

          // If file path not found, use image data as email body
          if (!imageFilePath) {
            textContent = msg.content;  // HTML containing image data
            context.logger.info(`📎 will send image as email body`);
          }

        } else {
          // Other message types not handled for now
          context.logger.debug(`skip non-text/image message (type=${msg.type}): ${messageId}`);
          continue;
        }

        context.logger.info(`📧 sendemail: ${subject}`);

        // Send email via SMTP
        await window.electronAPI.sendemail(config, {
          to: context.targetEmail,
          subject: subject,
          text: textContent,
          attachments: attachments
        });

        context.logger.info(`✅ emailSentsucceeded: ${messageId}`);

        // Update database: mark message as completed (status=100)
        if (window.electronAPI.updateMessageStatus) {
          const updatePayload = messageId 
            ? { msgid: messageId, status: 100, fromer: myEmail, dbUser: myEmail }
            : { id: messageId, status: 100, fromer: myEmail, dbUser: myEmail };
          
          await window.electronAPI.updateMessageStatus(updatePayload);
          context.logger.info(`✅ message statusUpdated as  100: ${messageId}`);
        }

        // Update UI status display
        // Mark text message as "sent" after successful email delivery (not "received by peer")
        // Image messages still use markMessageAsConfirmed (image was sent via email attachment)
        if (isImageMessage) {
          if (context.uiRenderer.markMessageAsConfirmed) {
            await context.uiRenderer.markMessageAsConfirmed(messageId);
          }
          // Mark image as sent via email to prevent resendPendingImages from resending after WebRTC reconnects
          if (context.fileTransferManager && context.fileTransferManager.sender && 
              context.fileTransferManager.sender.persistence) {
            context.fileTransferManager.sender.persistence.markImageAsEmailSent(messageId);
          }
        } else {
          if (context.uiRenderer.markMessageAsSentViaEmail) {
            await context.uiRenderer.markMessageAsSentViaEmail(messageId);
          } else if (context.uiRenderer.markMessageAsConfirmed) {
            await context.uiRenderer.markMessageAsConfirmed(messageId);
          }
        }

      } catch (sendError) {
        context.logger.error(`❌ email sendingfailed (${msg.msgid || msg.id}):`, sendError.message);
        // continueprocessNextmessage
      }
    }

    context.logger.info('📧 allUnsentmessageProcess completed');

  } catch (error) {
    context.logger.error('❌ sendUnsentMessagesViaEmail executefailed:', error);
  }
}

/**
 * Extract file name from message content
 * Supports extraction from HTML img tags, file:// URLs, or plain file name strings
 */
function extractFileNameFromContent(content) {
  if (!content) return 'unknown_image.jpg';

  try {
    // Try to extract filename from src attribute of HTML img tag
    const imgMatch = content.match(/src=['"]([^'"]+)['"]/i);
    if (imgMatch && imgMatch[1]) {
      const srcPath = imgMatch[1];
      
      // If it is a file:// protocol path
      if (srcPath.startsWith('file://')) {
        return srcPath.split('/').pop().split('?')[0];
      }
      
      // If it is a normal file path
      if (srcPath.includes('/') || srcPath.includes('\\')) {
        return srcPath.split('/').pop().split('\\').pop().split('?')[0];
      }
    }

    // Try to infer extension from data:image
    if (content.includes('data:image')) {
      const mimeMatch = content.match(/data:image\/(\w+);/i);
      if (mimeMatch && mimeMatch[1]) {
        const ext = mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1];
        return `image.${ext}`;
      }
    }

    // Try to find file name pattern (e.g. xxx-1234567890.jpg)
    const filePattern = content.match(/[\w-]+\.(png|jpg|jpeg|gif|bmp|webp)/i);
    if (filePattern) {
      return filePattern[0];
    }

  } catch (e) {
    context.logger?.warn?.('extractFileNameFromContent parsefailed:', e.message);
  }

  return 'unknown_image.jpg';
}

export async function handleCarryTextMessage(context, data) {
  const { from, id, content, timestamp } = data;

  if (id && context.fileTransferManager) {
    const alreadyDisplayed = await context.fileTransferManager.isMessageDisplayed(id);
    if (alreadyDisplayed) {
      context.logger.info(`⏭️ handleCarryTextMessage: messageDisplayed, skip duplicate display: ${id}`);
      return;
    }
  }

  await processCarryTextMessage(context, data, from, id, content, timestamp);
}

export async function processCarryTextMessage(context, data, from, id, content, timestamp) {
  await _triggerTrayFlash(context, from);
  _playNotificationSound(context);

  // Check if message already exists (deduplication check)
  if (id && window.electronAPI && window.electronAPI.getChatMessageByMsgid) {
    try {
      const existingMsg = await window.electronAPI.getChatMessageByMsgid({
        msgid: id,
        dbUser: context.myEmail
      });
      if (existingMsg) {
        context.logger.info(`⏭️ signaling emailcarrymessageExists, skipsaveanddisplay: ${id}`);
        return;
      }
    } catch (error) {
      context.logger.warn(`checking messagewhetherexistserror when: ${error.message}, continueprocessmessage`);
    }
  }

  if (window.electronAPI && window.electronAPI.saveChatMessage) {
    try {
      await window.electronAPI.saveChatMessage({
        fromer: from,
        toer: context.myEmail || '',
        content: content,
        type: 2,
        status: 100,
        msgid: id || ''
      });
      context.logger.info('✅ signaling emailcarrymessagesave to database');
    } catch (error) {
      context.logger.error('savesignaling emailcarrymessagefailed: ' + error.message);
    }
  }

  const unescapedContent = decodeHtmlEntities(content);
  context.uiRenderer.displayMessage(
    'peer',
    unescapedContent,
    id,
    timestamp,
    from,
    100
  );

  context.element.dispatchEvent(new CustomEvent('update-contact-last-message', {
    detail: { email: from, message: unescapedContent },
    bubbles: true,
    composed: true
  }));

  _notifyUnreadIncrement(context, new Set(), from, id);

  context.logger.info('✅ signaling emailcarrymessageDisplayed');
}
