const { app, BrowserWindow, Menu, shell, globalShortcut, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

let mainWindow;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function sendToRenderer(channel, ...args) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, ...args);
    }
}

autoUpdater.on('checking-for-update', () => {
    sendToRenderer('updater:status', { state: 'checking' });
});

autoUpdater.on('update-available', (info) => {
    sendToRenderer('updater:status', { state: 'available', version: info.version });
});

autoUpdater.on('update-not-available', (info) => {
    sendToRenderer('updater:status', { state: 'not-available', version: info.version });
});

autoUpdater.on('error', (err) => {
    sendToRenderer('updater:status', { state: 'error', message: err == null ? 'unknown' : (err.message || String(err)) });
});

autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('updater:status', { state: 'downloading', percent: progress.percent });
});

autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('updater:status', { state: 'downloaded', version: info.version });
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 900,
        minWidth: 900,
        minHeight: 600,

        fullscreen: false,

        title: 'WTDSight',
        icon: path.join(__dirname, 'app', 'images', 'logo.svg'),

        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'app', 'index.html'));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
    Menu.setApplicationMenu(null);
}

app.whenReady().then(() => {
    createWindow();

    globalShortcut.register('F11', () => {
        if (mainWindow) {
            mainWindow.setFullScreen(!mainWindow.isFullScreen());
        }
    });

    mainWindow.webContents.once('did-finish-load', () => {
        autoUpdater.checkForUpdates().catch(() => { });
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('get-documents-path', () => {
    return app.getPath('documents');
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

function getDiskAutosavePath() {
    return path.join(app.getPath('userData'), 'storage', 'current_sight.json');
}

ipcMain.handle('autosave:write-to-disk', async (event, data) => {
    try {
        const filePath = getDiskAutosavePath();
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, data, 'utf8');
        return { success: true, filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('autosave:read-from-disk', async () => {
    try {
        const filePath = getDiskAutosavePath();
        const data = await fs.promises.readFile(filePath, 'utf8');
        return { success: true, data };
    } catch (err) {
        return { success: false, error: err.code === 'ENOENT' ? 'not-found' : err.message };
    }
});

ipcMain.handle('updater:check', async () => {
    try {
        const result = await autoUpdater.checkForUpdates();
        const currentVersion = app.getVersion();
        const remoteVersion = result && result.updateInfo ? result.updateInfo.version : currentVersion;
        return {
            updateAvailable: remoteVersion !== currentVersion,
            currentVersion,
            remoteVersion
        };
    } catch (err) {
        return { error: err.message || String(err) };
    }
});

ipcMain.handle('updater:download-and-install', async () => {
    try {
        await autoUpdater.downloadUpdate();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('updater:quit-and-install', () => {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { success: true };
});

ipcMain.handle('get-default-save-path', (event, customPath) => {
    return customPath || app.getPath('documents');
});

ipcMain.handle('show-save-dialog', async (event, options) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        title: options.title || 'Сохранить файл',
        defaultPath: options.defaultPath || path.join(app.getPath('documents'), options.fileName || 'sight.blk'),
        filters: options.filters || [{ name: 'Все файлы', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) {
        return { canceled: true };
    }
    if (options.data) {
        let dataToWrite = options.data;
        if (typeof dataToWrite === 'string' && dataToWrite.startsWith('data:')) {
            const base64Data = dataToWrite.split(',')[1];
            dataToWrite = Buffer.from(base64Data, 'base64');
        } else if (typeof dataToWrite === 'string') {
            dataToWrite = Buffer.from(dataToWrite, 'utf8');
        }
        fs.writeFileSync(result.filePath, dataToWrite);
        return { filePath: result.filePath, canceled: false };
    }
    return { filePath: result.filePath, canceled: false };
});

ipcMain.handle('save-file-to-path', async (event, { filePath, data }) => {
    try {
        let dataToWrite = data;
        if (typeof dataToWrite === 'string' && dataToWrite.startsWith('data:')) {
            const base64Data = dataToWrite.split(',')[1];
            dataToWrite = Buffer.from(base64Data, 'base64');
        } else if (typeof dataToWrite === 'string') {
            dataToWrite = Buffer.from(dataToWrite, 'utf8');
        }
        fs.writeFileSync(filePath, dataToWrite);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('show-open-dialog', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: options.title || 'Выберите папку',
        properties: ['openDirectory'],
        defaultPath: options.defaultPath || app.getPath('documents')
    });
    if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
    }
    return { filePath: result.filePaths[0], canceled: false };
});

ipcMain.handle('save-file-to-folder', async (event, { folderPath, fileName, data }) => {
    const fullPath = path.join(folderPath, fileName);
    try {
        let dataToWrite = data;
        if (typeof dataToWrite === 'string' && dataToWrite.startsWith('data:')) {
            const base64Data = dataToWrite.split(',')[1];
            dataToWrite = Buffer.from(base64Data, 'base64');
        } else if (typeof dataToWrite === 'string') {
            dataToWrite = Buffer.from(dataToWrite, 'utf8');
        }
        fs.writeFileSync(fullPath, dataToWrite);
        return { success: true, fullPath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});