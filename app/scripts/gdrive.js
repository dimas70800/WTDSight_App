(function () {
    const GOOGLE_CLIENT_ID = "975120951407-d3nm12lm5k641etknirs4ta67tk6o3j0.apps.googleusercontent.com";

    const SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const FOLDER_NAME = 'WTDSight';
    const FILE_NAME = 'autosave';
    const SYNC_COOLDOWN_MS = 3000;

    let tokenClient = null;
    let pendingAction = null;
    let cachedFolderId = null;
    let lastManualSyncTime = 0;
    let isSyncing = false;

    function isElectron() {
        return typeof window !== 'undefined' && !!window.electronAPI && typeof window.electronAPI.gdriveAuth === 'function';
    }

    function getClientId() {
        return (GOOGLE_CLIENT_ID || '').trim();
    }

    function isGDriveLoggedIn() {
        return localStorage.getItem('wtdsight_gdrive_logged_in') === 'true';
    }

    function isNetworkError(err) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
        if (!err) return false;
        const msg = (err.message || err.error_description || err.error || String(err)).toLowerCase();
        return msg.includes('failed to fetch') ||
            msg.includes('networkerror') ||
            msg.includes('network_error') ||
            msg.includes('network') ||
            msg.includes('offline') ||
            msg.includes('google identity services');
    }

    function showGDriveError(err) {
        if (typeof showNotification !== 'function') return;
        if (isNetworkError(err)) {
            showNotification(typeof lang !== 'undefined' ? lang.gdriveNoInternet : 'Нет подключения к интернету', true);
            return;
        }
        const msg = (err && (err.message || err.error_description || err.error)) || '';
        const base = typeof lang !== 'undefined' ? lang.gdriveError : 'Ошибка Google Диска';
        showNotification(msg ? base + ': ' + msg : base, true);
    }

    function getStoredToken() {
        const token = sessionStorage.getItem('wtdsight_gdrive_token');
        const expiresAt = parseInt(sessionStorage.getItem('wtdsight_gdrive_token_expires') || '0', 10);
        if (token && Date.now() < expiresAt) {
            return token;
        }
        return null;
    }

    function setStoredToken(token, expiresInSec = 3600) {
        sessionStorage.setItem('wtdsight_gdrive_token', token);
        sessionStorage.setItem('wtdsight_gdrive_token_expires', String(Date.now() + expiresInSec * 1000));
    }

    function clearStoredToken() {
        sessionStorage.removeItem('wtdsight_gdrive_token');
        sessionStorage.removeItem('wtdsight_gdrive_token_expires');
    }

    function formatDateTime(date) {
        if (!date || isNaN(date.getTime())) return '—';
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function updateGDriveUI() {
        const loggedIn = isGDriveLoggedIn();
        const loggedInUI = el('gdriveLoggedInUI');
        const loggedOutUI = el('gdriveLoggedOutUI');
        const statusRow = el('gdriveStatusRow');
        const lastSaveTimeEl = el('gdriveLastSaveTime');
        const accountInfoEl = el('gdriveAccountInfo');
        const prefixEl = el('gdriveLastSavePrefix');

        if (prefixEl && typeof lang !== 'undefined' && lang.gdriveLastSavePrefix) {
            prefixEl.textContent = lang.gdriveLastSavePrefix;
        }

        if (loggedIn) {
            if (loggedInUI) loggedInUI.style.display = 'flex';
            if (loggedOutUI) loggedOutUI.style.display = 'none';
            if (statusRow) statusRow.style.display = 'flex';

            const lastSave = localStorage.getItem('wtdsight_gdrive_last_save_time') || '—';
            if (lastSaveTimeEl) lastSaveTimeEl.textContent = lastSave;

            const accInfo = localStorage.getItem('wtdsight_gdrive_account_info') || '';
            if (accountInfoEl) accountInfoEl.textContent = accInfo;
        } else {
            if (loggedInUI) loggedInUI.style.display = 'none';
            if (loggedOutUI) loggedOutUI.style.display = 'flex';
            if (statusRow) statusRow.style.display = 'none';
            if (lastSaveTimeEl) lastSaveTimeEl.textContent = '—';
            if (accountInfoEl) accountInfoEl.textContent = '';
        }
    }

    function loadGISScript() {
        return new Promise((resolve, reject) => {
            if (window.google?.accounts?.oauth2) return resolve();
            const existing = document.getElementById('gsi-client-script');
            if (existing) {
                existing.addEventListener('load', resolve);
                existing.addEventListener('error', reject);
                return;
            }
            const s = document.createElement('script');
            s.id = 'gsi-client-script';
            s.src = 'https://accounts.google.com/gsi/client';
            s.async = true;
            s.defer = true;
            s.onload = resolve;
            s.onerror = () => reject(new Error('Не удалось загрузить Google Identity Services'));
            document.head.appendChild(s);
        });
    }

    async function authorizeInElectron() {
        try {
            const res = await window.electronAPI.gdriveAuth();
            if (!res || !res.success || !res.access_token) {
                if (res && res.error && res.error !== 'timeout') {
                    showGDriveError(new Error(res.error));
                }
                pendingAction = null;
                return null;
            }

            setStoredToken(res.access_token, parseInt(res.expires_in, 10) || 3600);
            localStorage.setItem('wtdsight_gdrive_logged_in', 'true');

            fetchUserInfo(res.access_token);
            fetchExistingFileInfo(res.access_token);

            updateGDriveUI();

            if (typeof showNotification === 'function' && !pendingAction) {
                showNotification(typeof lang !== 'undefined' ? lang.gdriveLoginSuccess : 'Успешный вход в Google Диск!');
            }

            if (pendingAction) {
                const action = pendingAction;
                pendingAction = null;
                action(res.access_token);
            }

            return res.access_token;
        } catch (err) {
            showGDriveError(err);
            pendingAction = null;
            return null;
        }
    }

    async function initTokenClient() {
        const clientId = getClientId();
        if (!clientId) return null;

        try {
            await loadGISScript();
        } catch (err) {
            showGDriveError(err);
            return null;
        }

        if (!tokenClient) {
            tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: SCOPE,
                callback: async (resp) => {
                    if (resp.error) {
                        console.error('Google OAuth error:', resp);
                        showGDriveError(resp);
                        pendingAction = null;
                        return;
                    }

                    setStoredToken(resp.access_token, parseInt(resp.expires_in, 10) || 3600);
                    localStorage.setItem('wtdsight_gdrive_logged_in', 'true');

                    fetchUserInfo(resp.access_token);
                    fetchExistingFileInfo(resp.access_token);

                    updateGDriveUI();

                    if (typeof showNotification === 'function' && !pendingAction) {
                        showNotification(typeof lang !== 'undefined' ? lang.gdriveLoginSuccess : 'Успешный вход в Google Диск!');
                    }

                    if (pendingAction) {
                        const action = pendingAction;
                        pendingAction = null;
                        action(resp.access_token);
                    }
                }
            });
        }
        return tokenClient;
    }

    async function fetchUserInfo(token) {
        try {
            const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)', {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                const userStr = data.user?.emailAddress || data.user?.displayName || '';
                if (userStr) {
                    localStorage.setItem('wtdsight_gdrive_account_info', userStr);
                    updateGDriveUI();
                }
            }
        } catch (e) { }
    }

    async function fetchExistingFileInfo(token) {
        try {
            const folderId = await getOrCreateFolder(token);
            const file = await getAutosaveFile(token, folderId);
            if (file && file.modifiedTime) {
                const formatted = formatDateTime(new Date(file.modifiedTime));
                localStorage.setItem('wtdsight_gdrive_last_save_time', formatted);
                updateGDriveUI();
            }
        } catch (e) { }
    }

    async function requestToken(promptMode = '') {
        if (isElectron()) {
            return authorizeInElectron();
        }
        const client = await initTokenClient();
        if (!client) return;
        client.requestAccessToken({ prompt: promptMode });
    }

    async function getValidToken(interactive = true) {
        const token = getStoredToken();
        if (token) return token;

        if (isElectron()) {
            try {
                const res = await window.electronAPI.gdriveGetToken();
                if (res && res.success && res.access_token) {
                    setStoredToken(res.access_token, res.expires_in || 3600);
                    localStorage.setItem('wtdsight_gdrive_logged_in', 'true');
                    return res.access_token;
                }
            } catch (e) { }

            if (!interactive) {
                return null;
            }

            return new Promise(async (resolve) => {
                pendingAction = (t) => resolve(t);
                const t = await authorizeInElectron();
                if (!t) resolve(null);
            });
        }

        if (!interactive) {
            return null;
        }

        return new Promise(async (resolve) => {
            pendingAction = (t) => resolve(t);
            const client = await initTokenClient();
            if (client) {
                client.requestAccessToken();
            } else {
                resolve(null);
            }
        });
    }

    async function getOrCreateFolder(token) {
        if (cachedFolderId) return cachedFolderId;
        const q = encodeURIComponent(`name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.files && data.files.length > 0) {
            cachedFolderId = data.files[0].id;
            return cachedFolderId;
        }
        const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: FOLDER_NAME,
                mimeType: 'application/vnd.google-apps.folder'
            })
        });
        if (!createRes.ok) {
            const err = await createRes.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${createRes.status}`);
        }
        const createData = await createRes.json();
        cachedFolderId = createData.id;
        return cachedFolderId;
    }

    async function getAutosaveFile(token, folderId) {
        const q = encodeURIComponent(`name = '${FILE_NAME}' and '${folderId}' in parents and trashed = false`);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${res.status}`);
        }
        const data = await res.json();
        return (data.files && data.files.length > 0) ? data.files[0] : null;
    }

    async function uploadAutosave(manual = false) {
        if (isSyncing) return;

        if (manual) {
            const now = Date.now();
            if (now - lastManualSyncTime < SYNC_COOLDOWN_MS) {
                return;
            }
            lastManualSyncTime = now;
        }

        if (manual && typeof objects !== 'undefined' && objects.size === 0) {
            if (typeof showNotification === 'function') {
                showNotification(typeof lang !== 'undefined' ? lang.gdriveEmptyCanvasWarning : 'Холст пуст — сохранение на Google Диске не перезаписано', true);
            }
            return;
        }

        let saveData = null;
        if (typeof formSaveData === 'function') {
            saveData = formSaveData();
        } else {
            saveData = localStorage.getItem('wtdmsight-save');
        }

        if (!saveData) return;

        isSyncing = true;
        try {
            const token = await getValidToken(manual);
            if (!token) {
                isSyncing = false;
                return;
            }

            const folderId = await getOrCreateFolder(token);
            const existingFile = await getAutosaveFile(token, folderId);

            const metadata = {
                name: FILE_NAME,
                mimeType: 'application/json'
            };
            if (!existingFile) {
                metadata.parents = [folderId];
            }

            const boundary = '-------314159265358979323846';
            const delimiter = "\r\n--" + boundary + "\r\n";
            const close_delim = "\r\n--" + boundary + "--";

            const multipartRequestBody =
                delimiter +
                'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                saveData +
                close_delim;

            let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime';
            let method = 'POST';

            if (existingFile) {
                url = `https://www.googleapis.com/upload/drive/v3/files/${existingFile.id}?uploadType=multipart&fields=id,name,modifiedTime`;
                method = 'PATCH';
            }

            const res = await fetch(url, {
                method: method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: multipartRequestBody
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error?.message || `HTTP ${res.status}`);
            }

            const data = await res.json();
            const now = new Date(data.modifiedTime || Date.now());
            const formattedTime = formatDateTime(now);
            localStorage.setItem('wtdsight_gdrive_last_save_time', formattedTime);
            updateGDriveUI();

            if (manual && typeof showNotification === 'function') {
                showNotification(typeof lang !== 'undefined' ? lang.gdriveSyncSuccess : 'Синхронизировано с Google Диском!');
            }
        } catch (e) {
            console.error('GDrive upload error:', e);
            if (manual) {
                showGDriveError(e);
            }
        } finally {
            isSyncing = false;
        }
    }

    async function loadAutosave() {
        try {
            const token = await getValidToken(true);
            if (!token) return;

            const folderId = await getOrCreateFolder(token);
            const file = await getAutosaveFile(token, folderId);

            if (!file) {
                if (typeof showNotification === 'function') {
                    showNotification(typeof lang !== 'undefined' ? lang.gdriveNoSaveFound : 'Файл автосохранения не найден на Google Диске', true);
                }
                return;
            }

            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error?.message || `HTTP ${res.status}`);
            }

            const jsonStr = await res.text();
            if (typeof load === 'function') {
                load(jsonStr, true);
            }
            if (typeof drawCanvas === 'function') {
                drawCanvas();
            }

            if (file.modifiedTime) {
                const formattedTime = formatDateTime(new Date(file.modifiedTime));
                localStorage.setItem('wtdsight_gdrive_last_save_time', formattedTime);
                updateGDriveUI();
            }

            if (typeof showNotification === 'function') {
                showNotification(typeof lang !== 'undefined' ? lang.gdriveLoadSuccess : 'Загружено из Google Диска!');
            }
        } catch (e) {
            console.error('GDrive load error:', e);
            showGDriveError(e);
        }
    }

    function logout() {
        const token = getStoredToken();
        if (token && window.google?.accounts?.oauth2?.revoke) {
            try {
                google.accounts.oauth2.revoke(token, () => { });
            } catch (e) { }
        }
        if (isElectron() && window.electronAPI.gdriveLogout) {
            window.electronAPI.gdriveLogout().catch(() => { });
        }
        clearStoredToken();
        localStorage.setItem('wtdsight_gdrive_logged_in', 'false');
        localStorage.removeItem('wtdsight_gdrive_account_info');
        cachedFolderId = null;
        updateGDriveUI();

        if (typeof showNotification === 'function') {
            showNotification(typeof lang !== 'undefined' ? lang.gdriveLogoutSuccess : 'Вы вышли из Google Диска');
        }
    }

    function initHandlers() {
        const loginBtn = el('gdriveLoginBtn');
        const syncBtn = el('gdriveSyncBtn');
        const loadBtn = el('gdriveLoadBtn');
        const logoutBtn = el('gdriveLogoutBtn');

        if (loginBtn) {
            loginBtn.onclick = () => {
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                    showNotification(typeof lang !== 'undefined' ? lang.gdriveNoInternet : 'Нет подключения к интернету', true);
                    return;
                }
                requestToken('consent');
            };
        }
        if (syncBtn) {
            syncBtn.onclick = () => uploadAutosave(true);
        }
        if (loadBtn) {
            loadBtn.onclick = () => loadAutosave();
        }
        if (logoutBtn) {
            logoutBtn.onclick = () => logout();
        }

        if (isElectron() && isGDriveLoggedIn()) {
            window.electronAPI.gdriveGetToken().then((res) => {
                if (res && res.success && res.access_token) {
                    setStoredToken(res.access_token, res.expires_in || 3600);
                    fetchUserInfo(res.access_token);
                    fetchExistingFileInfo(res.access_token);
                    updateGDriveUI();
                } else if (res && res.needLogin) {
                    clearStoredToken();
                    localStorage.setItem('wtdsight_gdrive_logged_in', 'false');
                    updateGDriveUI();
                }
            }).catch(() => { });
        } else {
            updateGDriveUI();
        }
    }

    window.syncGDriveAutosave = function () {
        if (!isGDriveLoggedIn()) return;
        uploadAutosave(false);
    };

    window.updateGDriveUI = updateGDriveUI;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initHandlers);
    } else {
        initHandlers();
    }
})();
