const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getDocumentsPath: () => ipcRenderer.invoke('get-documents-path'),
    getDefaultSavePath: (customPath) => ipcRenderer.invoke('get-default-save-path', customPath),
    showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
    saveFileToPath: (filePath, data) => ipcRenderer.invoke('save-file-to-path', { filePath, data }),
    saveFileToFolder: (folderPath, fileName, data) => ipcRenderer.invoke('save-file-to-folder', { folderPath, fileName, data }),
    showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),

    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    checkForUpdates: () => ipcRenderer.invoke('updater:check'),
    downloadAndInstallUpdate: () => ipcRenderer.invoke('updater:download-and-install'),
    quitAndInstallUpdate: () => ipcRenderer.invoke('updater:quit-and-install'),
    onUpdaterStatus: (callback) => {
        const handler = (event, payload) => callback(payload);
        ipcRenderer.on('updater:status', handler);
        return () => ipcRenderer.removeListener('updater:status', handler);
    },

    autosaveWriteToDisk: (data) => ipcRenderer.invoke('autosave:write-to-disk', data),
    autosaveReadFromDisk: () => ipcRenderer.invoke('autosave:read-from-disk')
});

window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('electron-app');
});