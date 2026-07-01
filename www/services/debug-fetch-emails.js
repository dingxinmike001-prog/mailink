// Debug issues with fetchEmailsFromMainProcess function

// 1. Check whether window.electronAPI.fetchEmails exists
console.log('Does window.electronAPI.fetchEmails exist?', typeof window.electronAPI.fetchEmails);

// 2. Check window.electronAPI object
console.log('window.electronAPI object:', window.electronAPI);

// 3. Check selectedConfig object
console.log('selectedConfigObject:', selectedConfig);

// 4. Check isImapConnected variable
console.log('isImapConnectedvariable:', isImapConnected);

// 5. Check supportsIdle variable
console.log('supportsIdlevariable:', supportsIdle);

// 6. Check pollingInterval variable
console.log('pollingIntervalvariable:', pollingInterval);

// 7. Check pollingScheduler variable
console.log('pollingScheduler variable:', pollingScheduler);

// 8. Check polling scheduler worker status
if (pollingScheduler) {
    console.log('Polling scheduler Worker exists');
} else {
    console.log('Polling schedulerWorkerDoes not exist');
}

// 9. Check emailDistributor variable
console.log('emailDistributorvariable:', emailDistributor);

// 10. Check activeConnections variable
console.log('activeConnectionsvariable:', activeConnections);

// 11. Check mymail in sessionStorage
console.log('sessionStorageinmymail:', sessionStorage.getItem('mymail'));

// 12. Check activeConnections in sessionStorage
console.log('activeConnections in sessionStorage:', sessionStorage.getItem('activeConnections'));

// 13. Try manually calling fetchEmailsFromMainProcess function with timeout
console.log('Starting manual call to fetchEmailsFromMainProcess function...');
const startTime = Date.now();
const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
        reject(new Error('fetchEmailsFromMainProcessFunction call timed out'));
    }, 10000); // 10-second timeout
});

const fetchPromise = fetchEmailsFromMainProcess(2, false);

Promise.race([fetchPromise, timeoutPromise])
    .then(result => {
        console.log('fetchEmailsFromMainProcessFunction call succeeded，elapsed time:', Date.now() - startTime, 'ms，result:', result);
    })
    .catch(error => {
        console.error('fetchEmailsFromMainProcessFunction call failed，elapsed time:', Date.now() - startTime, 'ms，error:', error);
    });

// 14. Check polling timer status
console.log('pollTimerIdvariable:', pollTimerId);

// 15. Check whether multiple pending fetchEmails requests exist
console.log('Checking for multiple pending fetchEmails requests...');

// 16. Check IMAP connection status
console.log('CheckIMAPConnection status...');
testImapConnection()
    .then(result => {
        console.log('IMAPConnection test successful:', result);
    })
    .catch(error => {
        console.error('IMAP connection test failed:', error);
    });
