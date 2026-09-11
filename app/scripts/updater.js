let updaterState = 'idle'; // idle | checking | available | downloading | downloaded | not-available | error
let latestRemoteVersion = null;

function el_(id) { return document.getElementById(id); }

function isElectronUpdaterAvailable() {
    return typeof window !== 'undefined'
        && window.electronAPI
        && typeof window.electronAPI.checkForUpdates === 'function';
}

async function initAppVersionLabel() {
    if (!isElectronUpdaterAvailable()) return;
    try {
        const version = await window.electronAPI.getAppVersion();
        const versionEl = el_('appVersionValue');
        if (versionEl) versionEl.textContent = version;
    } catch (e) {
        
    }
}

function updaterText(key, fallbackRu, fallbackEn) {
    if (typeof lang !== 'undefined' && lang && lang[key]) return lang[key];
    return (typeof lang !== 'undefined' && lang === en) ? fallbackEn : fallbackRu;
}

function applyButtonText(state) {
    const btn = el_('checkUpdateBtn');
    if (!btn) return;

    btn.disabled = false;

    switch (state) {
        case 'checking':
            btn.textContent = updaterText('updaterChecking', 'Проверка...', 'Checking...');
            btn.disabled = true;
            break;
        case 'available':
        case 'downloaded':
            btn.textContent = updaterText('updaterUpdateNow', 'Обновить сейчас', 'Update now');
            break;
        case 'downloading':
            btn.textContent = updaterText('updaterDownloading', 'Загрузка...', 'Downloading...');
            btn.disabled = true;
            break;
        case 'not-available':
            btn.textContent = updaterText('updaterUpToDate', 'Обновлений нет', 'No updates');
            break;
        case 'error':
            btn.textContent = updaterText('updaterError', 'Ошибка проверки', 'Check failed');
            break;
        default:
            btn.textContent = updaterText('checkUpdateBtn', 'Проверить наличие обновлений', 'Check for updates');
    }
}

function setSettingsButtonState(state) {
    applyButtonText(state);

    if (state === 'not-available' || state === 'error') {
        setTimeout(() => {
            if (updaterState === state) {
                applyButtonText('idle');
            }
        }, 3000);
    }
}

function showUpdateBanner(version) {
    const banner = el_('updateBanner');
    const text = el_('updateBannerText');
    const btn = el_('updateBannerBtn');
    if (!banner) return;

    if (text) {
        const label = updaterText('updaterBannerText', 'Доступно обновление', 'Update available');
        text.textContent = version ? `${label} ${version}` : label;
    }
    if (btn) {
        btn.disabled = false;
        btn.textContent = updaterText('updaterUpdateNow', 'Обновить', 'Update');
    }
    banner.classList.add('visible');
}

function hideUpdateBanner() {
    const banner = el_('updateBanner');
    if (banner) banner.classList.remove('visible');
}

function setBannerButtonBusy() {
    const btn = el_('updateBannerBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = updaterText('updaterDownloading', 'Загрузка...', 'Downloading...');
    }
}

function onUpdaterStatusChanged(payload) {
    if (!payload || !payload.state) return;
    updaterState = payload.state;

    switch (payload.state) {
        case 'checking':
            setSettingsButtonState('checking');
            break;

        case 'available':
            latestRemoteVersion = payload.version || null;
            setSettingsButtonState('available');
            showUpdateBanner(latestRemoteVersion);
            break;

        case 'not-available':
            setSettingsButtonState('not-available');
            hideUpdateBanner();
            break;

        case 'downloading':
            setSettingsButtonState('downloading');
            setBannerButtonBusy();
            break;

        case 'downloaded':
            latestRemoteVersion = payload.version || latestRemoteVersion;
            setSettingsButtonState('downloaded');
            finishInstall();
            break;

        case 'error':
            setSettingsButtonState('error');
            if (typeof showNotification === 'function') {
                showNotification(updaterText('updaterError', 'Ошибка проверки обновлений', 'Update check failed'), true);
            }
            break;
    }
}

async function checkForUpdatesManually() {
    if (!isElectronUpdaterAvailable()) return;
    setSettingsButtonState('checking');
    try {
        await window.electronAPI.checkForUpdates();
    } catch (e) {
        setSettingsButtonState('error');
    }
}

function forceSaveBeforeUpdate() {
    try {
        if (typeof forcedSave === 'function') {
            forcedSave();
        } else if (typeof saveToStorage === 'function') {
            saveToStorage();
        }
    } catch (e) {
        console.warn('Не удалось выполнить принудительное автосохранение перед обновлением:', e);
    }
}

async function finishInstall() {
    forceSaveBeforeUpdate();
    try {
        await window.electronAPI.quitAndInstallUpdate();
    } catch (e) {
        if (typeof showNotification === 'function') {
            showNotification(updaterText('updaterError', 'Не удалось перезапустить для обновления', 'Failed to restart for update'), true);
        }
    }
}

async function updateNow() {
    if (!isElectronUpdaterAvailable()) return;

    if (updaterState === 'downloaded') {
        await finishInstall();
        return;
    }

    if (updaterState !== 'available') {
        await checkForUpdatesManually();
        if (updaterState !== 'available') return;
    }

    forceSaveBeforeUpdate();

    setSettingsButtonState('downloading');
    setBannerButtonBusy();

    try {
        const result = await window.electronAPI.downloadAndInstallUpdate();
        if (result && result.success === false) {
            throw new Error(result.error || 'download failed');
        }
    } catch (e) {
        setSettingsButtonState('error');
        if (typeof showNotification === 'function') {
            showNotification(updaterText('updaterError', 'Не удалось скачать обновление', 'Failed to download update'), true);
        }
    }
}

function refreshUpdaterTexts() {
    applyButtonText(updaterState);
    const banner = el_('updateBanner');
    if (banner && banner.classList.contains('visible')) {
        showUpdateBanner(latestRemoteVersion);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (!isElectronUpdaterAvailable()) {
        const row = el_('checkUpdateBtn');
        if (row) row.style.display = 'none';
        return;
    }

    initAppVersionLabel();

    const settingsBtn = el_('checkUpdateBtn');
    if (settingsBtn) settingsBtn.addEventListener('click', () => {
        if (updaterState === 'available' || updaterState === 'downloaded') {
            updateNow();
        } else {
            checkForUpdatesManually();
        }
    });

    const bannerBtn = el_('updateBannerBtn');
    if (bannerBtn) bannerBtn.addEventListener('click', updateNow);

    window.electronAPI.onUpdaterStatus(onUpdaterStatusChanged);
});