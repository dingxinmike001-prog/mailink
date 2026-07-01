/**
 * File transfer UI file operation module
 * Handles open folder and save-as operations
 */

export class FileOpsHandler {
  constructor(context) {
    this.context = context;
  }

  get logger() { return this.context.logger; }
  get electronAPI() { return window.electronAPI; }

  async handleOpenFolder(id, filePath) {
    try {
      this.logger.info(`[FileTransferUI] handleOpenFolder called: id=${id}, filePath=${filePath}`);

      if (!this.electronAPI || !this.electronAPI.showItemInFolder) {
        this.logger.warn('[FileTransferUI] showItemInFolder API unavailable');
        return;
      }

      const result = await this.electronAPI.showItemInFolder(filePath);
      this.logger.info(`[FileTransferUI] showItemInFolder result:`, result);
    } catch (error) {
      this.logger.error(`[FileTransferUI] open folder failed:`, error);
    }
  }

  async handleSaveAs(id, sourcePath) {
    try {
      this.logger.info(`[FileTransferUI] handleSaveAs called: id=${id}, sourcePath=${sourcePath}`);

      if (!this.electronAPI || !this.electronAPI.showSaveDialog) {
        this.logger.warn('[FileTransferUI] showSaveDialog API unavailable');
        return;
      }

      const fileName = sourcePath ? sourcePath.split(/[/\\]/).pop() : 'unknown';
      this.logger.info(`[FileTransferUI] default filename: ${fileName}`);

      const result = await this.electronAPI.showSaveDialog({
        defaultPath: fileName,
        filters: [
          { name: 'All files', extensions: ['*'] }
        ]
      });

      this.logger.info(`[FileTransferUI] showSaveDialog result:`, result);

      if (result && !result.canceled && result.filePath) {
        if (this.electronAPI && this.electronAPI.copyFile) {
          this.logger.info(`[FileTransferUI] calling copyFile: ${sourcePath} -> ${result.filePath}`);
          const copyResult = await this.electronAPI.copyFile(sourcePath, result.filePath);
          if (copyResult && copyResult.success) {
            this.logger.info(`[FileTransferUI] Save file as succeeded: ${result.filePath}`);
          } else {
            this.logger.error(`[FileTransferUI] Save file as failed:`, copyResult?.error);
          }
        }
      }
    } catch (error) {
      this.logger.error(`[FileTransferUI] Save as operation failed:`, error);
    }
  }
}