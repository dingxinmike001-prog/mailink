/**


 * Contact backup restore module


 * Executes via Worker thread to avoid blocking the main process


 */


const logger = require('../logger');





// Import unified Worker manager factory


const { createWorkerManager } = require('../../shared/worker/worker-factory');





// Create contact backup restore Worker manager instance


const contactBackupRestoreWorkerManager = createWorkerManager('contactBackupRestore');





/**


 * Restore contact backup


 * Executes the full restore flow via Worker thread


 * @param {Object} config - IMAP config {username, password, host, port, tls}


 * @param {Object} event - Electron IPC event object (optional, used to send notifications to the renderer)


 * @returns {Promise<Object>} Restore result


 */


async function restoreContactBackup(config, event = null) {


  const userLogger = logger.Logger.getInstance('default', { username: config.username });


  userLogger.info('[ContactBackupRestore] started contact backup restore flow (Worker mode)');





  try {


    // Execute restore flow using Worker thread


    // WorkerManager.sendTask returns the Worker's data field


    const data = await contactBackupRestoreWorkerManager.sendTask({


      taskType: 'restore-contacts',


      params: {


        config


      }


    }, 120000); // 120-second timeout





    userLogger.info('[ContactBackupRestore] restore completed', data);


    


    // If restore succeeds and new contacts were added, notify renderer to refresh contact list


    if (data && data.success && data.added > 0) {


      if (event && event.sender) {


        try {


          event.sender.send('contacts-restored', {


            username: config.username,


            added: data.added,


            skipped: data.skipped,


            message: data.message


          });


          userLogger.info('[ContactBackupRestore] notified renderer process to refresh contact list');


        } catch (notifyErr) {


          userLogger.warn(`[ContactBackupRestore] failed to notify renderer process: ${notifyErr.message}`);


        }


      }


    }


    


    return data;


  } catch (error) {


    userLogger.error(`[ContactBackupRestore] Workerexecution failed: ${error.message}`);


    return {


      success: false,


      message: `Workerexecution failed: ${error.message}`,


      emailFound: false,


      attachmentDownloaded: false,


      contactsMerged: false,


      added: 0,


      skipped: 0


    };


  }


}





module.exports = {


  restoreContactBackup


};


