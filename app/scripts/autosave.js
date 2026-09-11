function saveToStorage()
{
    localStorage.setItem("wtdmsight-save", formSaveData());
}

let diskAutosaveInFlight = false;

function isDiskAutosaveAvailable()
{
    return typeof window !== 'undefined'
        && window.electronAPI
        && typeof window.electronAPI.autosaveWriteToDisk === 'function';
}

function saveToDisk(data)
{
    if (!isDiskAutosaveAvailable() || diskAutosaveInFlight) return;

    diskAutosaveInFlight = true;
    window.electronAPI.autosaveWriteToDisk(data)
        .catch(() => {})
        .finally(() => { diskAutosaveInFlight = false; });
}

function forcedSave()
{
    const data = formSaveData();
    localStorage.setItem("wtdmsight-save", data);
    saveToDisk(data);

    //alert(lang === ru ? "Принудительно сохранено!" : "Force-saved!");
    saveNotify();
}

async function restoreFromStorage()
{
    const localSave = localStorage.getItem("wtdmsight-save");

    if (localSave != null)
    {
        load(localSave);
        return;
    }

    if (!isDiskAutosaveAvailable() || typeof window.electronAPI.autosaveReadFromDisk !== 'function') return;

    try
    {
        const result = await window.electronAPI.autosaveReadFromDisk();
        if (result && result.success && result.data)
        {
            load(result.data);
        }
    }
    catch (e)
    {

    }
}

function autosaveRoutine()
{
    if (objects.size > 0)
    {
        const data = formSaveData();
        localStorage.setItem("wtdmsight-save", data);
        saveToDisk(data);
        saveNotify();
        //console.log("Autosaved");
    }
    else
    {
        //console.log("Nothing to autosave");
    }
}

restoreFromStorage();
setInterval(autosaveRoutine, 1 * 60 * 1000);

const saveIcon = el("saveIcon");
let saveNotification = null;
let saveIconOpacity = 0;

function saveNotify()
{
    saveIconOpacity = 100;   

    if (saveNotification != null) clearInterval(saveNotification);
    saveNotification = setInterval(saveNotificationVanishing, 15);
}

function saveNotificationVanishing()
{
    saveIcon.style.opacity = saveIconOpacity + "%";

    if (saveIconOpacity === 0)
    {
        clearInterval(saveNotification);
        saveNotification = null;
    }
    else
    {
        saveIconOpacity -= 1;
    }
}