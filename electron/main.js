const { app, BrowserWindow, Menu, shell, globalShortcut, ipcMain, dialog, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

app.commandLine.appendSwitch('force_high_performance_gpu');

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
        if (url.startsWith('file://') && url.includes('/privacy/')) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 860,
                    height: 700,
                    title: 'WTDSight',
                    autoHideMenuBar: true,
                    webPreferences: {
                        contextIsolation: true,
                        nodeIntegration: false
                    }
                }
            };
        }
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

ipcMain.handle('read-app-file', async (event, relPath) => {
    const fullPath = path.join(__dirname, '..', 'app', relPath);
    const buf = await fs.promises.readFile(fullPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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

const GDRIVE_CLIENT_ID = '975120951407-upjjidte63g1licj38i8nvgq2t0jfhg5.apps.googleusercontent.com';
const GDRIVE_CLIENT_SECRET = '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';
const G_SCOPE = 'https://www.googleapis.com/auth/drive.file';

let currentAccessToken = null;
let currentTokenExpiresAt = 0;

function base64Url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

function getGDriveAuthStoragePath() {
    return path.join(app.getPath('userData'), 'storage', 'gdrive_auth.json');
}

async function saveRefreshToken(refreshToken) {
    try {
        const filePath = getGDriveAuthStoragePath();
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        let dataToSave;
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
            const encrypted = safeStorage.encryptString(refreshToken);
            dataToSave = JSON.stringify({ encrypted: encrypted.toString('base64') });
        } else {
            dataToSave = JSON.stringify({ token: refreshToken });
        }
        await fs.promises.writeFile(filePath, dataToSave, 'utf8');
    } catch (e) {
        console.error('Failed to save refresh token:', e);
    }
}

async function loadRefreshToken() {
    try {
        const filePath = getGDriveAuthStoragePath();
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const json = JSON.parse(raw);
        if (json.encrypted && safeStorage && safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(Buffer.from(json.encrypted, 'base64'));
        }
        return json.token || null;
    } catch (e) {
        return null;
    }
}

async function clearRefreshToken() {
    try {
        const filePath = getGDriveAuthStoragePath();
        await fs.promises.unlink(filePath);
    } catch (e) { }
}

async function exchangeCodeForTokens(code, codeVerifier, redirectUri) {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams({
        client_id: GDRIVE_CLIENT_ID,
        code: code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
    });
    if (GDRIVE_CLIENT_SECRET) {
        params.append('client_secret', GDRIVE_CLIENT_SECRET);
    }

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
    }
    return data;
}

async function refreshAccessToken(refreshToken) {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams({
        client_id: GDRIVE_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });
    if (GDRIVE_CLIENT_SECRET) {
        params.append('client_secret', GDRIVE_CLIENT_SECRET);
    }

    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
    }
    return data;
}

ipcMain.handle('gdrive:get-token', async () => {
    if (currentAccessToken && Date.now() < currentTokenExpiresAt - 60000) {
        return {
            success: true,
            access_token: currentAccessToken,
            expires_in: Math.floor((currentTokenExpiresAt - Date.now()) / 1000)
        };
    }

    const refreshToken = await loadRefreshToken();
    if (!refreshToken) {
        return { success: false, needLogin: true };
    }

    try {
        const tokens = await refreshAccessToken(refreshToken);
        currentAccessToken = tokens.access_token;
        currentTokenExpiresAt = Date.now() + (parseInt(tokens.expires_in, 10) || 3600) * 1000;
        return {
            success: true,
            access_token: currentAccessToken,
            expires_in: parseInt(tokens.expires_in, 10) || 3600
        };
    } catch (err) {
        if (String(err).includes('invalid_grant')) {
            await clearRefreshToken();
            currentAccessToken = null;
            return { success: false, needLogin: true, error: 'invalid_grant' };
        }
        return { success: false, error: err.message };
    }
});

ipcMain.handle('gdrive:logout', async () => {
    currentAccessToken = null;
    currentTokenExpiresAt = 0;
    await clearRefreshToken();
    return { success: true };
});

ipcMain.handle('gdrive:auth', () => {
    return new Promise((resolve) => {
        let resolved = false;
        let server = null;
        let timeoutId = null;

        const cleanup = (result) => {
            if (resolved) return;
            resolved = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (server) {
                try { server.close(); } catch (e) { }
                server = null;
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
            }
            resolve(result);
        };

        timeoutId = setTimeout(() => {
            cleanup({ success: false, error: 'timeout' });
        }, 120000);

        const { verifier, challenge } = generatePKCE();

        server = http.createServer(async (req, res) => {
            const reqUrl = req.url || '';
            let parsed;
            try {
                parsed = new URL('http://127.0.0.1' + reqUrl);
            } catch (e) {
                parsed = { searchParams: new URLSearchParams(reqUrl.split('?')[1] || '') };
            }

            const code = parsed.searchParams.get('code');
            const err = parsed.searchParams.get('error') || parsed.searchParams.get('error_description');

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>WTDSight — Google Drive</title>
    <style>
        body { background: #202020; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .box { background: rgb(52, 52, 52); border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; padding: 32px 40px; text-align: center; max-width: 420px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h2 { margin: 0 0 12px; font-size: 20px; font-weight: 600; }
        p { margin: 0; color: #b5b5b5; font-size: 14px; line-height: 1.5; }
    </style>
</head>
<body>
    <div class="box">
        <h2>${err ? 'Ошибка входа' : 'Вход выполнен успешно!'}</h2>
        <p>${err ? err : 'Вы можете закрыть эту вкладку и вернуться в приложение WTDSight.'}</p>
    </div>
    <script>
        setTimeout(() => { try { window.close(); } catch(e){} }, 800);
    </script>
</body>
</html>`);

            if (err) {
                cleanup({ success: false, error: err });
                return;
            }

            if (code) {
                try {
                    const port = server.address().port;
                    const redirectUri = 'http://127.0.0.1:' + port;
                    const tokens = await exchangeCodeForTokens(code, verifier, redirectUri);
                    if (tokens.refresh_token) {
                        await saveRefreshToken(tokens.refresh_token);
                    }
                    currentAccessToken = tokens.access_token;
                    currentTokenExpiresAt = Date.now() + (parseInt(tokens.expires_in, 10) || 3600) * 1000;
                    cleanup({
                        success: true,
                        access_token: tokens.access_token,
                        expires_in: parseInt(tokens.expires_in, 10) || 3600
                    });
                } catch (exchangeErr) {
                    cleanup({ success: false, error: exchangeErr.message });
                }
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const redirectUri = 'http://127.0.0.1:' + port;
            const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
                client_id: GDRIVE_CLIENT_ID,
                redirect_uri: redirectUri,
                response_type: 'code',
                scope: G_SCOPE,
                code_challenge: challenge,
                code_challenge_method: 'S256',
                access_type: 'offline',
                prompt: 'consent'
            }).toString();

            shell.openExternal(authUrl);
        });

        server.once('error', (err) => {
            cleanup({ success: false, error: err.message });
        });
    });
});