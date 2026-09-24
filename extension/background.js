'use strict';

importScripts('urlmatch.js');

// ── Cache ──────────────────────────────────────────────────────────────────
let cachedEntries = null;
let cacheTime     = 0;
const CACHE_TTL   = 5 * 60 * 1000; // 5 Minuten
const faviconCache = new Map();
let pendingClip = null;
let healthCache = null, healthTime = 0;   // Passwort-Gesundheit, verfällt mit dem Eintrags-Cache
let refreshInFlight = null;   // Single-Flight: verhindert parallele Refresh-Aufrufe (Rotation-Race)

async function getServerUrl() {
    const c = await new Promise(r => chrome.storage.local.get(['serverUrl'], r));
    return c.serverUrl || null;
}

// ── Zugangstoken beschaffen (SSO) ──────────────────────────────────────────
// Kurzlebiger Access-Token aus der Session; ist er abgelaufen, wird er über den
// rotierenden Refresh-Token erneuert.
async function getAccessToken() {
    const cfg = await new Promise(r => chrome.storage.local.get(
        ['serverUrl', 'apiRefreshToken', 'apiRefreshExpiresAt'], r));
    if (!cfg.serverUrl) return null;
    if (!cfg.apiRefreshToken) return null;               // nicht angemeldet
    const sess = await chrome.storage.session.get(['accessToken', 'accessExpiresAt']);
    if (sess.accessToken && sess.accessExpiresAt && Date.now() < sess.accessExpiresAt - 30000) {
        return sess.accessToken;
    }
    // Nur EINEN Refresh gleichzeitig ausführen; parallele Aufrufer warten mit.
    if (!refreshInFlight) {
        refreshInFlight = refreshAccessToken(cfg).finally(() => { refreshInFlight = null; });
    }
    return await refreshInFlight;
}

async function refreshAccessToken(cfg) {
    try {
        const body = new URLSearchParams();
        body.append('grant_type', 'refresh_token');
        body.append('refresh_token', cfg.apiRefreshToken);
        const res = await fetch(`${cfg.serverUrl}/api/vault/extension/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        if (!res.ok) {
            // ungültig / abgelaufen / Reuse-Detection → SSO-Tokens verwerfen (Re-Login nötig)
            await chrome.storage.local.remove(['apiRefreshToken', 'apiRefreshExpiresAt']);
            await chrome.storage.session.remove(['accessToken', 'accessExpiresAt']);
            return null;
        }
        const data = await res.json();
        // Rotation: den NEUEN Refresh-Token speichern.
        await chrome.storage.local.set({
            apiRefreshToken: data.refresh_token,
            apiRefreshExpiresAt: Date.now() + (data.refresh_expires_in || 0) * 1000,
        });
        await chrome.storage.session.set({
            accessToken: data.access_token,
            accessExpiresAt: Date.now() + (data.expires_in || 0) * 1000,
        });
        return data.access_token;
    } catch (e) { return null; }
}

// Zentraler API-Aufruf: hängt Server-URL + gültigen Bearer an. null = nicht verfügbar.
async function apiFetch(path, opts = {}) {
    const serverUrl = await getServerUrl();
    const token = await getAccessToken();
    if (!serverUrl || !token) return null;
    const headers = Object.assign({}, opts.headers, { 'Authorization': 'Bearer ' + token });
    return fetch(serverUrl + path, Object.assign({}, opts, { headers }));
}

// ── Lock-Gate (serverseitig erzwungen; Client spiegelt nur) ─────────────────
async function lockSettings() {
    return new Promise(resolve => chrome.storage.local.get(['lockDuration', 'lockEnabled'], resolve));
}
function lockRequired(s) { return !!s.lockEnabled; }
function durationSecs(dur) {
    switch (String(dur)) {
        case '5':  return 300;
        case '60': return 3600;
        case 'session': return 43200;
        case 'off': return 900;
        default:   return 900;
    }
}
async function isUnlocked() {
    const s = await lockSettings();
    if (!lockRequired(s)) return true;
    const sess = await chrome.storage.session.get(['unlock']);
    const u = sess.unlock;
    if (!u) return false;
    if (u.sticky) return true;
    return !!u.until && Date.now() < u.until;
}
async function setUnlockedLocal(dur) {
    const unlock = (String(dur) === 'session') ? { sticky: true } : { until: Date.now() + durationSecs(dur) * 1000 };
    await chrome.storage.session.set({ unlock });
}
async function clearUnlocked() {
    await chrome.storage.session.remove('unlock');
    await chrome.storage.local.remove('__armedTotp');
    clearPendingFills();
    cachedEntries = null; cacheTime = 0; faviconCache.clear();
    try { await apiFetch('/api/vault/extension/lock', { method: 'POST' }); } catch (e) { /* ignore */ }
}
async function onServerLocked() {
    await chrome.storage.session.remove('unlock');
    await chrome.storage.local.remove('__armedTotp');
    clearPendingFills();
    cachedEntries = null; cacheTime = 0;
}
async function doUnlock(pin) {
    const s = await lockSettings();
    const dur = s.lockDuration || '15';
    try {
        const body = new URLSearchParams();
        body.append('pin', pin);
        body.append('duration_secs', String(durationSecs(dur)));
        const res = await apiFetch('/api/vault/extension/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        if (!res) return { ok: false, error: 'Nicht konfiguriert.' };
        const data = await res.json().catch(() => ({}));
        if (data.ok) { await setUnlockedLocal(dur); return { ok: true }; }
        return { ok: false, error: data.error || 'PIN falsch.', lockSecs: data.lock_secs || 0 };
    } catch (e) { return { ok: false, error: 'Verbindungsfehler.' }; }
}

// ── Daten ───────────────────────────────────────────────────────────────────
async function fetchEntries(force = false) {
    if (!(await isUnlocked())) return { entries: null, locked: true };
    const now = Date.now();
    if (!force && cachedEntries && (now - cacheTime) < CACHE_TTL) {
        return { entries: cachedEntries, locked: false };
    }
    try {
        const res = await apiFetch('/api/vault/extension/entries');
        if (!res) return { entries: null, locked: false };
        if (res.status === 423) { await onServerLocked(); return { entries: null, locked: true }; }
        if (!res.ok) { cachedEntries = null; return { entries: null, locked: false }; }
        const data = await res.json();
        if (data.ok) {
            cachedEntries = data.entries; cacheTime = Date.now();
            return { entries: cachedEntries, locked: false };
        }
    } catch (e) { /* ignore */ }
    return { entries: null, locked: false };
}

/**
 * Legt einen persönlichen Eintrag im Tresor an.
 *
 * Läuft bewusst über `apiFetch`, damit derselbe Zugang wie für alle übrigen
 * Aufrufe gilt, inklusive automatischer Erneuerung des Access-Tokens.
 *
 * @param {{title?:string,username?:string,password?:string,url?:string,notes?:string,totp?:string}} fields
 * @return {Promise<{ok:boolean,id?:number,locked?:boolean,error?:string}>}
 */
async function createEntry(fields) {
    if (!(await isUnlocked())) return { ok: false, locked: true, error: 'Tresor gesperrt.' };
    const body = new URLSearchParams();
    ['title', 'username', 'password', 'url', 'notes'].forEach(k => body.append(k, fields?.[k] ?? ''));
    if (fields?.totp) body.append('totp', fields.totp);
    if (fields?.team_id) body.append('team_id', String(fields.team_id));
    if (fields?.folder_id) body.append('folder_id', String(fields.folder_id));
    return writeEntry('/api/vault/extension/entries', body.toString());
}

/**
 * Ändert einen bestehenden Eintrag. Ein leeres Passwortfeld lässt das gespeicherte
 * Passwort unangetastet; Ordner und Ablaufdatum bleiben serverseitig erhalten.
 * Das 2FA-Secret wird neu gesetzt (`totp`), entfernt (`totp_clear`) oder behalten.
 *
 * @param {number|string} entryId
 * @param {{title?:string,username?:string,password?:string,url?:string,notes?:string,totp?:string,totp_clear?:boolean}} fields
 * @return {Promise<{ok:boolean,locked?:boolean,error?:string}>}
 */
async function updateEntry(entryId, fields) {
    if (!(await isUnlocked())) return { ok: false, locked: true, error: 'Tresor gesperrt.' };
    const body = new URLSearchParams();
    ['title', 'username', 'password', 'url', 'notes'].forEach(k => body.append(k, fields?.[k] ?? ''));
    // 2FA-Secret: nur senden, wenn es sich ändern soll (neu setzen oder entfernen);
    // ohne beides lässt der Server das gespeicherte Secret unangetastet.
    if (fields?.totp) body.append('totp', fields.totp);
    else if (fields?.totp_clear) body.append('totp_clear', '1');
    // Ordner nur senden, wenn er sich ändern soll ('' = kein Ordner).
    if (fields?.folder_id !== undefined && fields?.folder_id !== null) body.append('folder_id', String(fields.folder_id));
    return writeEntry(`/api/vault/extension/entries/${entryId}`, body.toString());
}

// Nur das Passwort eines Eintrags ersetzen; die übrigen Felder kommen aus der Liste.
async function updatePassword(entryId, password) {
    const r = await fetchEntries();
    if (r.locked) return { ok: false, locked: true, error: 'Tresor gesperrt.' };
    const e = (r.entries || []).find(x => String(x.id) === String(entryId));
    if (!e) return { ok: false, error: 'Eintrag nicht gefunden.' };
    return updateEntry(entryId, { title: e.title, username: e.username || '', password, url: e.url || '', notes: e.notes || '' });
}

/**
 * Löscht einen Eintrag (persönlich oder Team, sofern Schreibrecht besteht).
 *
 * @param {number|string} entryId
 * @return {Promise<{ok:boolean,locked?:boolean,error?:string}>}
 */
async function deleteEntry(entryId) {
    if (!(await isUnlocked())) return { ok: false, locked: true, error: 'Tresor gesperrt.' };
    return writeEntry(`/api/vault/extension/entries/${entryId}/delete`, '');
}

// Gemeinsame Auswertung der schreibenden Endpunkte.
async function writeEntry(path, body) {
    try {
        const res = await apiFetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body,
        });
        if (!res) return { ok: false, error: 'Nicht konfiguriert.' };
        if (res.status === 423) { await onServerLocked(); return { ok: false, locked: true, error: 'Tresor gesperrt.' }; }
        const data = await res.json().catch(() => ({}));
        if (data.ok) {
            cachedEntries = null; cacheTime = 0; healthCache = null;
            return { ok: true, id: data.id };
        }
        return { ok: false, error: data.error || 'Fehler beim Speichern.' };
    } catch (e) { return { ok: false, error: 'Verbindungsfehler.' }; }
}

// ── Generischer Aufruf der neueren Endpunkte ────────────────────────────────
// Liefert die JSON-Antwort des Servers oder {ok:false, locked|error}.
async function apiCall(path, opts = {}) {
    if (!(await isUnlocked())) return { ok: false, locked: true, error: 'Tresor gesperrt.' };
    try {
        const res = await apiFetch(path, opts);
        if (!res) return { ok: false, error: 'Nicht konfiguriert.' };
        if (res.status === 423) { await onServerLocked(); return { ok: false, locked: true, error: 'Tresor gesperrt.' }; }
        const data = await res.json().catch(() => ({}));
        if (data && data.ok) return data;
        return { ok: false, error: (data && data.error) || ('HTTP ' + res.status) };
    } catch (e) { return { ok: false, error: 'Verbindungsfehler.' }; }
}
function formBody(obj) {
    const b = new URLSearchParams();
    Object.entries(obj || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') b.append(k, String(v)); });
    return b.toString();
}
function postOpts(body) {
    return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body };
}

// ── Serverstand ─────────────────────────────────────────────────────────────
// Der Server nennt in /status den Stand seiner Schnittstelle; Funktionen, die
// er noch nicht kennt, bleiben in Popup und Seite verborgen.
let serverApiVersion = null;
async function apiVersion() {
    if (serverApiVersion !== null) return serverApiVersion;
    const sess = await chrome.storage.session.get(['apiVersion']);
    if (typeof sess.apiVersion === 'number') return (serverApiVersion = sess.apiVersion);
    await checkStatus();
    return serverApiVersion ?? 0;
}

// ── Ziele, Zusatzfelder, Gesundheit, Passkeys ───────────────────────────────
let targetsCache = null, targetsTime = 0;
async function getTargets() {
    if (targetsCache && Date.now() - targetsTime < 60 * 1000) return targetsCache;
    if ((await apiVersion()) < 2) return { ok: false, error: 'Server zu alt.' };
    const r = await apiCall('/api/vault/extension/targets');
    if (r.ok) { targetsCache = r; targetsTime = Date.now(); }
    return r;
}
async function getHealth() {
    if (healthCache && Date.now() - healthTime < CACHE_TTL) return healthCache;
    if ((await apiVersion()) < 2) return { ok: false, error: 'Server zu alt.' };
    const r = await apiCall('/api/vault/extension/entries/health');
    if (r.ok) { healthCache = r; healthTime = Date.now(); }
    return r;
}
async function passkeyCreate(m) {
    if ((await apiVersion()) < 2) return { ok: false, error: 'Server zu alt.' };
    const r = await apiCall('/api/vault/extension/passkeys', postOpts(formBody({
        rp_id: m.rpId, rp_name: m.rpName, user_handle: m.userHandle, user_name: m.userName, user_display: m.userDisplay,
        entry_id: m.entryId, title: m.title, team_id: m.teamId, folder_id: m.folderId,
    })));
    if (r.ok) { cachedEntries = null; cacheTime = 0; }
    return r;
}

// ── Beim Anmelden erfasste Zugangsdaten („Passwort speichern?") ─────────────
// Das Passwort bleibt bis zur Entscheidung nur hier im Speicher, je Tab, mit
// kurzer Verfallszeit; die Seite bekommt nur Anzeigedaten zurück.
const CAPTURE_TTL = 90 * 1000;
const pendingCaptures = new Map(); // tabId -> { host, origin, url, user, pw, ts }

async function neverSaveHosts() {
    const c = await new Promise(r => chrome.storage.local.get(['neverSaveHosts'], r));
    return Array.isArray(c.neverSaveHosts) ? c.neverSaveHosts : [];
}
function setPendingCapture(tabId, data) {
    if (tabId == null || !data || !data.pw) return;
    pendingCaptures.set(tabId, Object.assign({ ts: Date.now() }, data));
}
// Bewertet den Auftrag eines Tabs: nichts zu tun, speichern oder aktualisieren.
async function evaluateCapture(tabId) {
    const c = pendingCaptures.get(tabId);
    if (!c) return null;
    const drop = () => { pendingCaptures.delete(tabId); return null; };
    if (Date.now() - c.ts > CAPTURE_TTL) return drop();
    if ((await neverSaveHosts()).includes(c.host)) return drop();
    if (!(await isUnlocked())) return drop();
    const r = await fetchEntries();
    if (!r.entries) return drop();

    const matches  = r.entries.filter(e => VaultUrl.matches(e.url, c.url));
    const sameUser = matches.filter(e => String(e.username || '').toLowerCase() === String(c.user || '').toLowerCase());
    if (sameUser.length) {
        // Unverändertes Passwort → kein Hinweis. Prüfbar nur mit Server ≥ 2.
        if ((await apiVersion()) < 2) return drop();
        for (const e of sameUser) {
            const chk = await apiCall(`/api/vault/extension/entries/${e.id}/password/check`, postOpts(formBody({ password: c.pw })));
            if (chk.ok && chk.match) return drop();
        }
        const target = sameUser.find(e => e.can_write !== false);
        if (!target) return drop();
        return { kind: 'update', host: c.host, user: c.user, entry: { id: target.id, title: target.title } };
    }
    const targets = (await apiVersion()) >= 2 ? await getTargets() : null;
    return { kind: 'save', host: c.host, user: c.user, targets: targets && targets.ok ? targets : null };
}
async function decideCapture(tabId, d) {
    const c = pendingCaptures.get(tabId);
    pendingCaptures.delete(tabId);
    if (!d || d.action === 'dismiss') return { ok: true };
    if (d.action === 'never') {
        const hosts = await neverSaveHosts();
        if (c && !hosts.includes(c.host)) hosts.push(c.host);
        await new Promise(r => chrome.storage.local.set({ neverSaveHosts: hosts }, r));
        return { ok: true };
    }
    if (!c) return { ok: false, error: 'Abgelaufen – bitte erneut anmelden.' };
    if (d.action === 'save') {
        return createEntry({ title: c.host, username: c.user, password: c.pw, url: c.origin, notes: '', team_id: d.team_id || '', folder_id: d.folder_id || '' });
    }
    if (d.action === 'update') return updatePassword(d.entryId, c.pw);
    return { ok: false, error: 'Unbekannte Aktion.' };
}
chrome.tabs.onRemoved.addListener(tabId => pendingCaptures.delete(tabId));

// ── Tastenkürzel: Anmeldung ausfüllen ───────────────────────────────────────
// Genau ein passender Eintrag → sofort ausfüllen; sonst (oder gesperrt) das Popup.
async function openPopupSafe() {
    try { await chrome.action.openPopup(); } catch (e) { /* ältere Chrome-Versionen */ }
}
async function fillFromShortcut() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url || !/^https?:/i.test(tab.url)) return;
    if (!(await isUnlocked())) { await openPopupSafe(); return; }
    const r = await fetchEntries();
    const matches = (r.entries || []).filter(e => VaultUrl.matches(e.url, tab.url));
    if (matches.length !== 1) { await openPopupSafe(); return; }
    const e = matches[0];
    const pw = await fetchPassword(e.id);
    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'VAULT_FILL', id: e.id, username: e.username || '', password: pw || '', has_totp: !!e.has_totp });
    } catch (err) { await openPopupSafe(); }
}
if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(cmd => { if (cmd === 'fill-login') fillFromShortcut(); });
}

async function fetchPassword(entryId) {
    if (!(await isUnlocked())) return null;
    try {
        const res = await apiFetch(`/api/vault/extension/entries/${entryId}/password`);
        if (!res) return null;
        if (res.status === 423) { await onServerLocked(); return null; }
        if (!res.ok) return null;
        const data = await res.json();
        return data.ok ? data.password : null;
    } catch (e) { return null; }
}

async function fetchTotp(entryId) {
    if (!(await isUnlocked())) return null;
    try {
        const res = await apiFetch(`/api/vault/extension/entries/${entryId}/totp`);
        if (!res) return null;
        if (res.status === 423) { await onServerLocked(); return null; }
        if (!res.ok) return null;
        const data = await res.json();
        return data.ok ? { code: data.code, remaining: data.remaining } : null;
    } catch (e) { return null; }
}

async function fetchFavicon(entryId) {
    if (faviconCache.has(entryId)) return faviconCache.get(entryId);
    try {
        const res = await apiFetch(`/api/vault/extension/entries/${entryId}/favicon?fetch=1`);
        if (!res || !res.ok) { faviconCache.set(entryId, null); return null; }
        const blob = await res.blob();
        const dataUrl = await new Promise(resolve => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => resolve(null);
            fr.readAsDataURL(blob);
        });
        faviconCache.set(entryId, dataUrl);
        return dataUrl;
    } catch (e) { return null; }
}


// ── Ausstehendes Ausfüllen (mehrstufiger Login) ─────────────────────────────
// Bei Logins, die Benutzername und Passwort auf zwei Schritte verteilen, muss das
// Passwort den Seitenwechsel überdauern. Es bleibt dafür ausschließlich im
// Speicher des Service Workers – niemals in `chrome.storage`, das auf die
// Festplatte geschrieben wird. Je Tab ein Auftrag, mit harter Verfallszeit.
const PENDING_FILL_TTL = 30 * 1000;
const pendingFills = new Map(); // tabId -> { id, pw, user, ts }

function setPendingFill(tabId, data) {
    if (tabId == null) return;
    pendingFills.set(tabId, Object.assign({ ts: Date.now() }, data));
}
function takePendingFill(tabId) {
    if (tabId == null) return null;
    const p = pendingFills.get(tabId);
    if (!p) return null;
    pendingFills.delete(tabId);
    return (Date.now() - p.ts > PENDING_FILL_TTL) ? null : p;
}
function clearPendingFills() { pendingFills.clear(); }
chrome.tabs.onRemoved.addListener(tabId => pendingFills.delete(tabId));

// ── Zwischenablage automatisch leeren (Offscreen) ───────────────────────────
async function scheduleClipClear(text) {
    const cfg = await new Promise(r => chrome.storage.local.get(['clipClear'], r));
    if (cfg.clipClear === false) return;
    pendingClip = text || '';
    chrome.alarms.create('clipClear', { delayInMinutes: 0.5 });
}
// Schreibt über das Offscreen-Dokument. Dieser Weg funktioniert auch dann, wenn
// die Seite selbst keinen Zugriff bekommt – etwa ohne frische Nutzerinteraktion.
async function writeClipboard(text) {
    try {
        if (!chrome.offscreen) return;
        const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
        if (!has) {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html', reasons: ['CLIPBOARD'],
                justification: 'Zugangsdaten in die Zwischenablage legen und nach kurzer Zeit wieder entfernen.',
            });
        }
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'CLIP_WRITE', text: text || '' });
    } catch (e) { /* ignore */ }
}
async function clearClipboard() { await writeClipboard(''); }

// ── Status prüfen (Bearer) ──────────────────────────────────────────────────
async function checkStatus() {
    const res = await apiFetch('/api/vault/extension/status');
    if (!res) return { ok: false, reason: 'not_configured' };
    try {
        const data = await res.json();
        if (data && typeof data.pin_enabled !== 'undefined') {
            await new Promise(r => chrome.storage.local.set({ lockEnabled: !!data.pin_enabled }, r));
        }
        if (data && data.ok) {
            serverApiVersion = Number(data.api_version || 0);
            await chrome.storage.session.set({ apiVersion: serverApiVersion });
        }
        return data;
    } catch { return { ok: false, reason: 'network_error' }; }
}

// ── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target === 'offscreen') return;
    if (msg.type === 'GET_ENTRIES') {
        fetchEntries(msg.force).then(r => sendResponse({ entries: r.entries, locked: r.locked }));
        return true;
    }
    if (msg.type === 'GET_MATCHING_ENTRIES') {
        fetchEntries().then(r => {
            const matched = (r.entries || []).filter(e => VaultUrl.matches(e.url, msg.url));
            sendResponse({ entries: matched, locked: r.locked });
        });
        return true;
    }
    if (msg.type === 'CREATE_ENTRY') { createEntry(msg.entry || {}).then(sendResponse); return true; }
    if (msg.type === 'UPDATE_ENTRY') { updateEntry(msg.id, msg.entry || {}).then(sendResponse); return true; }
    if (msg.type === 'DELETE_ENTRY') { deleteEntry(msg.id).then(sendResponse); return true; }
    if (msg.type === 'GET_PASSWORD') { fetchPassword(msg.id).then(password => sendResponse({ password })); return true; }
    if (msg.type === 'GET_TOTP') { fetchTotp(msg.id).then(result => sendResponse(result)); return true; }
    if (msg.type === 'GET_FAVICON') { fetchFavicon(msg.id).then(dataUrl => sendResponse({ dataUrl })); return true; }
    if (msg.type === 'GET_LOCK') {
        Promise.all([lockSettings(), isUnlocked()]).then(([s, unlocked]) => sendResponse({ required: lockRequired(s), unlocked }));
        return true;
    }
    if (msg.type === 'DO_UNLOCK') { doUnlock(msg.pin || '').then(sendResponse); return true; }
    if (msg.type === 'LOCK_NOW') { clearUnlocked().then(() => sendResponse({ ok: true })); return true; }
    if (msg.type === 'SET_PENDING_FILL') {
        setPendingFill(sender.tab?.id, { id: msg.id, pw: msg.pw || '', user: msg.user || '' });
        sendResponse({ ok: true });
        return true;
    }
    if (msg.type === 'TAKE_PENDING_FILL') { sendResponse({ fill: takePendingFill(sender.tab?.id) }); return true; }
    if (msg.type === 'CLIP_WRITE') { writeClipboard(msg.text || '').then(() => sendResponse({ ok: true })); return true; }
    if (msg.type === 'SCHEDULE_CLIP_CLEAR') { scheduleClipClear(msg.text || ''); sendResponse({ ok: true }); return true; }
    if (msg.type === 'CHECK_STATUS') { checkStatus().then(sendResponse); return true; }
    if (msg.type === 'GET_API_VERSION') { apiVersion().then(v => sendResponse({ apiVersion: v })); return true; }
    if (msg.type === 'GET_TARGETS') { getTargets().then(sendResponse); return true; }
    if (msg.type === 'GET_FIELDS') { apiCall(`/api/vault/extension/entries/${msg.id}/fields`).then(sendResponse); return true; }
    if (msg.type === 'GET_HEALTH') { getHealth().then(sendResponse); return true; }
    if (msg.type === 'GET_ENTRY_PASSKEYS') { apiCall(`/api/vault/extension/entries/${msg.id}/passkeys`).then(sendResponse); return true; }
    if (msg.type === 'PASSKEYS_FOR_RP') { apiCall('/api/vault/extension/passkeys?rp_id=' + encodeURIComponent(msg.rpId || '')).then(sendResponse); return true; }
    if (msg.type === 'PASSKEY_CREATE') { passkeyCreate(msg).then(sendResponse); return true; }
    if (msg.type === 'PASSKEY_ASSERT') {
        apiCall(`/api/vault/extension/passkeys/${msg.id}/assert`, postOpts(formBody({ client_data_hash: msg.clientDataHash }))).then(sendResponse);
        return true;
    }
    if (msg.type === 'PASSKEY_DELETE') {
        apiCall(`/api/vault/extension/passkeys/${msg.id}/delete`, postOpts('')).then(r => { if (r.ok) { cachedEntries = null; cacheTime = 0; } sendResponse(r); });
        return true;
    }
    if (msg.type === 'SET_PENDING_CAPTURE') { setPendingCapture(sender.tab?.id, msg.data); sendResponse({ ok: true }); return true; }
    if (msg.type === 'TAKE_PENDING_CAPTURE') { evaluateCapture(sender.tab?.id).then(r => sendResponse({ capture: r })); return true; }
    if (msg.type === 'CAPTURE_DECISION') { decideCapture(sender.tab?.id, msg.decision).then(sendResponse); return true; }
    if (msg.type === 'CLEAR_CACHE') { cachedEntries = null; cacheTime = 0; faviconCache.clear(); sendResponse({ ok: true }); return true; }
});

// Der manuell eingetragene API-Token wird nicht mehr unterstützt; ein aus einer
// früheren Version übernommener Wert wird beim Update aus dem Speicher entfernt.
// Der manuelle API-Token entfaellt, und ein ausstehender Fuellauftrag liegt nicht
// mehr im Speicher auf der Platte – Reste frueherer Versionen hier entfernen.
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.remove(['apiToken', '__pendingFill']);
});

// Cache alle 5 Minuten leeren; Zwischenablage-Clear nach Timeout.
chrome.alarms.create('clearCache', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'clearCache') { cachedEntries = null; cacheTime = 0; faviconCache.clear(); return; }
    if (alarm.name === 'clipClear') { await clearClipboard(); pendingClip = null; }
});