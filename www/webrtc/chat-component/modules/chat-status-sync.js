import { markMessageAsCompleted } from '../../../utils/status.js';

export function triggerStatusSync(context) {
  const myEmail = context.myEmail;
  const targetEmail = context.targetEmail;

  if (!myEmail || !targetEmail) {
    context.logger.warn('[ChatManager] triggerStatusSync: email info incomplete');
    return;
  }

  if (!context.fileTransferManager || !context.fileTransferManager.sender) {
    context.logger.warn('[ChatManager] fileTransferManager unavailable, unable totriggerstatus sync');
    return;
  }

  try {
    setTimeout(() => {
      context.fileTransferManager.sender.requestMessageStatusSync(targetEmail);
    }, 500);
  } catch (error) {
    context.logger.error('[ChatManager] trigger status sync failed:', error);
  }
}

export async function handleStatusSyncRequest(context, data) {
  const messageIds = data.messageIds;
  const fromEmail = data.fromEmail;

  context.logger.info(`[Chat] received status sync request, include ${messageIds.length} itemmessage, from : ${fromEmail}`);

  if (!window.electronAPI || !window.electronAPI.getChatMessageByMsgid) {
    context.logger.warn('[Chat] getChatMessageByMsgid API unavailable, unable toprocesssyncrequest');
    return;
  }

  const myEmail = context.myEmail;
  const confirmedIds = [];

  for (const msgId of messageIds) {
    try {
      const message = await window.electronAPI.getChatMessageByMsgid({
        msgid: msgId,
        dbUser: myEmail
      });

      if (message && message.status === 100) {
        confirmedIds.push(msgId);
        context.logger.info(`[Chat] message confirmed received: ${msgId}`);
      }
    } catch (error) {
      context.logger.warn(`[Chat] failed to query message status: ${msgId}`, error);
    }
  }

  context.logger.info(`[Chat] status sync response: ${confirmedIds.length}/${messageIds.length} itemmessageConfirmed`);

  if (context.connection && context.connection.sendData) {
    const syncResponse = {
      type: 'status-sync-response',
      confirmedIds: confirmedIds,
      toEmail: fromEmail,
      timestamp: Date.now()
    };

    const sent = context.connection.sendData(syncResponse);
    if (sent) {
      context.logger.info(`[Chat] status sync response sent: ${confirmedIds.length} itemmessage`);
    } else {
      context.logger.warn('[Chat] failed to send status sync response');
    }
  }
}

export async function handleStatusSyncResponse(context, data) {
  const confirmedIds = data.confirmedIds;

  context.logger.info(`[Chat] received status sync response, ${confirmedIds.length} itemmessageConfirmed`);

  if (!confirmedIds || confirmedIds.length === 0) {
    context.logger.info('[Chat] no confirmed messages need updating');
    return;
  }

  const myEmail = context.myEmail;
  let updatedCount = 0;

  for (const msgId of confirmedIds) {
    try {
      const result = await markMessageAsCompleted(msgId, {
        fromer: myEmail,
        dbUser: myEmail,
        retry: true,
        maxRetries: 2
      });

      if (result.success) {
        if (context.uiRenderer.markMessageAsConfirmed) {
          await context.uiRenderer.markMessageAsConfirmed(msgId);
        }
        updatedCount++;
        context.logger.info(`[Chat] message status updated to confirmed: ${msgId}`);
      } else {
        context.logger.warn(`[Chat] failed to update message status: ${msgId}, ${result.error}`);
      }
    } catch (error) {
      context.logger.error(`[Chat] failed to update message status: ${msgId}`, error);
    }
  }

  context.logger.info(`[Chat] status sync completed: ${updatedCount}/${confirmedIds.length} itemmessageUpdated`);
}
