const { spawn } = require('child_process');
const path = require('path');

// Import the logger module
const logger = require('./service/logger');

// Get project root directory
const projectDir = path.resolve(__dirname);

logger.info('Starting Mailink application instances...');

// Start the first instance
logger.info('Starting first application instance...');
const instance1 = spawn('npm', ['start'], {
  cwd: projectDir,
  stdio: 'inherit',
  shell: true
});

// Start the second instance after 2 seconds
setTimeout(() => {
  logger.info('Starting second application instance...');
  const instance2 = spawn('npm', ['start'], {
    cwd: projectDir,
    stdio: 'inherit',
    shell: true
  });
  
  // Listen for errors from the second instance
  instance2.on('error', (error) => {
    logger.error('Second instance startup failed:', error);
  });
  
  // Listen for close events from the second instance
  instance2.on('close', (code) => {
    logger.info(`Second instance closed with exit code: ${code}`);
  });
}, 2000);

// Listen for errors from the first instance
instance1.on('error', (error) => {
  logger.error('First instance startup failed:', error);
});

// Listen for close events from the first instance
instance1.on('close', (code) => {
  logger.info(`First instance closed with exit code: ${code}`);
});

logger.info('Startup script completed. Two application instances will run in separate windows.');