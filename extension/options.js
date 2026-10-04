'use strict';

function $(id) { return document.getElementById(id); }

document.addEventListener('DOMContentLoaded', () => {
    const a = $('shortcutLink');
    if (a) a.addEventListener('click', e => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); });
    if (navigator.platform && /mac/i.test(navigator.platform) && $('shortcutKey')) $('shortcutKey').textContent = '⌘ + Umschalt + L';
});

// Gespeicherte Werte laden (überschreibt das vorausgefüllte Feld nur wenn bereits gespeichert)
chrome.storage.local.get(['serverUrl'], cfg => {
    if (cfg.serverUrl) $('serverUrl').value = cfg.serverUrl;
});

// Sicherheits-Einstellungen laden
chrome.storage.local.get(['lockDuration', 'clipClear', 'totpAutoCopy'], cfg => {
    $('lockDuration').value     = (cfg.lockDuration && cfg.lockDuration !== 'off') ? cfg.lockDuration : '15';
    $('clipClear').checked      = cfg.clipClear !== false;    // Standard: an
    $('totpAutoCopy').checked   = cfg.totpAutoCopy !== false; // Standard: an
});

$('btnSaveSec').addEventListener('click', () => {
    chrome.storage.local.set({
        lockDuration: $('lockDuration').value,
        clipClear:    $('clipClear').checked,
        totpAutoCopy: $('totpAutoCopy').checked,
    }, () => {
        chrome.runtime.sendMessage({ type: 'LOCK_NOW' });
        $('savedSecMsg').innerHTML = '<span class="save-ok">&#10003; Gespeichert</span>';
        setTimeout(() => { $('savedSecMsg').textContent = ''; }, 2000);
    });
});

// HTTPS erzwingen (außer localhost) – sonst gingen Zugangsdaten und Passwörter
// im Klartext über die Leitung.
function isSecureServerUrl(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'https:') return true;
        if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return true;
        return false;
    } catch { return false; }
}

$('btnSave').addEventListener('click', () => {
    const url = $('serverUrl').value.trim().replace(/\/$/, '');
    if (!url) { showStatus('Server-URL darf nicht leer sein.', false); return; }
    if (!isSecureServerUrl(url)) {
        showStatus('Bitte eine <strong>https://</strong>-Adresse verwenden (nur localhost darf http:// sein). Sonst würden Zugangsdaten und Passwörter unverschlüsselt übertragen.', false);
        return;
    }

    chrome.storage.local.set({ serverUrl: url }, () => {
        chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
        $('savedMsg').innerHTML = '<span class="save-ok">&#10003; Gespeichert</span>';
        setTimeout(() => { $('savedMsg').textContent = ''; }, 2000);
    });
});

// ── SSO-Anmeldung (OAuth 2.0 + PKCE via chrome.identity) ────────────────────
function b64url(bytes) {
    let s = btoa(String.fromCharCode.apply(null, new Uint8Array(bytes)));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randB64(len) { const a = new Uint8Array(len); crypto.getRandomValues(a); return b64url(a); }
async function pkceChallenge(verifier) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64url(d);
}
function ssoMsg(msg, ok) {
    const el = $('ssoMsg');
    if (ok === null) { el.innerHTML = msg ? ('<span style="color:#6c757d;font-size:.82rem;">' + esc(msg) + '</span>') : ''; return; }
    el.innerHTML = ok ? ('<span class="save-ok">&#10003; ' + esc(msg) + '</span>')
                      : ('<span style="color:#dc3545;font-size:.82rem;">' + esc(msg) + '</span>');
    if (ok) setTimeout(() => { el.innerHTML = ''; }, 3000);
}
function ssoSet(area, obj) { return new Promise(r => chrome.storage[area].set(obj, r)); }
function ssoRemove(area, keys) { return new Promise(r => chrome.storage[area].remove(keys, r)); }

async function loginWithSso() {
    const url = $('serverUrl').value.trim().replace(/\/$/, '');
    if (!url) { ssoMsg('Bitte zuerst die Server-URL eingeben.', false); return; }
    if (!isSecureServerUrl(url)) { ssoMsg('Bitte eine https://-Adresse verwenden.', false); return; }
    if (!chrome.identity || !chrome.identity.launchWebAuthFlow) { ssoMsg('Anmeldung wird von diesem Browser nicht unterstützt.', false); return; }

    const verifier    = randB64(48);
    const challenge   = await pkceChallenge(verifier);
    const state       = randB64(16);
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl = url + '/vault/extension/authorize?' + new URLSearchParams({
        client_id: 'opennit-vault-extension', redirect_uri: redirectUri, response_type: 'code',
        code_challenge: challenge, code_challenge_method: 'S256', state: state, scope: 'vault',
    }).toString();

    $('btnSso').disabled = true;
    ssoMsg('Anmeldung läuft…', null);
    console.log('[OpenNIT Vault] Auth-URL:', authUrl, '| redirect_uri:', redirectUri);
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirect) => {
        $('btnSso').disabled = false;
        const le = chrome.runtime.lastError ? (chrome.runtime.lastError.message || 'unbekannt') : null;
        console.log('[OpenNIT Vault] launchWebAuthFlow zurück:', { lastError: le, redirect: redirect || null });
        if (le || !redirect) {
            ssoMsg('Anmeldung abgebrochen' + (le ? ' – ' + le : ' (keine Rückmeldung)') + '.', false);
            return;
        }
        let params;
        try { params = new URL(redirect).searchParams; } catch { ssoMsg('Ungültige Antwort.', false); return; }
        if (params.get('error')) { ssoMsg('Abgelehnt (' + params.get('error') + ').', false); return; }
        if (params.get('state') !== state) { ssoMsg('Sicherheitsprüfung fehlgeschlagen (state).', false); return; }
        const code = params.get('code');
        if (!code) { ssoMsg('Kein Autorisierungscode erhalten.', false); return; }
        try {
            const body = new URLSearchParams({ grant_type: 'authorization_code', code: code, code_verifier: verifier, redirect_uri: redirectUri });
            const res = await fetch(url + '/api/vault/extension/oauth/token', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.access_token) { ssoMsg('Token konnte nicht ausgestellt werden.', false); return; }
            await ssoSet('local', { serverUrl: url, apiRefreshToken: data.refresh_token, apiRefreshExpiresAt: Date.now() + (data.refresh_expires_in || 0) * 1000 });
            await ssoSet('session', { accessToken: data.access_token, accessExpiresAt: Date.now() + (data.expires_in || 0) * 1000 });
            chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
            ssoMsg('Angemeldet.', true);
            reflectAuthState();
            loadConnStatus();
        } catch (e) { ssoMsg('Verbindungsfehler: ' + e.message, false); }
    });
}

async function logoutSso() {
    const url = $('serverUrl').value.trim().replace(/\/$/, '');
    const cfg = await new Promise(r => chrome.storage.local.get(['apiRefreshToken'], r));
    if (url && cfg.apiRefreshToken) {
        try {
            const b = new URLSearchParams({ token: cfg.apiRefreshToken });
            await fetch(url + '/api/vault/extension/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
        } catch (e) { /* ignore */ }
    }
    await ssoRemove('local', ['apiRefreshToken', 'apiRefreshExpiresAt']);
    await ssoRemove('session', ['accessToken', 'accessExpiresAt', 'unlock']);
    chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    reflectAuthState();
    ssoMsg('Abgemeldet.', true);
    $('headerStatus').style.display = 'none';
}

function reflectAuthState() {
    chrome.storage.local.get(['apiRefreshToken'], cfg => {
        const sso = !!cfg.apiRefreshToken;
        $('btnLogout').style.display = sso ? '' : 'none';
        $('btnSso').lastChild.textContent = sso ? ' Neu anmelden' : ' Mit OpenNIT anmelden';
    });
}

// Verbindungsstatus über den Background (nutzt den SSO-Access-Token)
function loadConnStatus() {
    chrome.runtime.sendMessage({ type: 'CHECK_STATUS' }, data => {
        if (data && data.ok) {
            if (data.app_name) { $('optTitle').textContent = 'OpenNIT Vault'; }
            if (data.user) { $('headerUser').textContent = data.app_name ? (data.user + ' · ' + data.app_name) : data.user; $('headerStatus').style.display = ''; }
            showServerCompat(Number(data.api_version || 0));
            initDeviceKeys(Number(data.api_version || 0) >= 3, !!data.pin_enabled);
        }
    });
}

// ── Entsperren mit dem Gerät (WebAuthn) ─────────────────────────────────────
function b64url(buf) {
    let s = '';
    new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
function send(msg) { return new Promise(r => chrome.runtime.sendMessage(msg, x => r(chrome.runtime.lastError ? null : x))); }
function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
    const br = /Edg\//.test(ua) ? 'Edge' : /Vivaldi/.test(ua) ? 'Vivaldi' : /Brave/.test(ua) ? 'Brave' : 'Chrome';
    return os + ' · ' + br;
}
function initDeviceKeys(available, pinEnabled) {
    const grp = $('deviceKeyGroup');
    if (!grp) return;
    if (!available || !window.PublicKeyCredential) { grp.style.display = 'none'; return; }
    grp.style.display = '';
    const msg = $('deviceKeyMsg');
    if (!pinEnabled) {
        msg.style.color = '#b45309';
        msg.textContent = 'Es ist kein Tresor-PIN aktiv – ohne PIN gibt es keine Sperre, die ein Gerät aufheben könnte.';
    }
    loadDeviceKeys();
    $('btnDeviceRegister').addEventListener('click', registerDeviceKey);
}
async function loadDeviceKeys() {
    const host = $('deviceKeyList');
    const r = await send({ type: 'DEVICE_KEYS' });
    if (!r || !r.ok) { host.textContent = r && r.error ? r.error : ''; return; }
    host.innerHTML = '';
    (r.keys || []).forEach(k => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;';
        const used = k.last_used_at ? 'zuletzt ' + String(k.last_used_at).slice(0, 16) : 'noch nicht verwendet';
        row.innerHTML = '<span style="flex:1;">🔐 ' + esc(k.label) + ' <span style="opacity:.7;">(' + esc(used) + ')</span></span>'
            + '<button class="btn btn-default btn-xs" type="button" title="Entfernen">Entfernen</button>';
        row.querySelector('button').addEventListener('click', async () => {
            if (!confirm('Gerät „' + k.label + '" entfernen?')) return;
            const d = await send({ type: 'DEVICE_KEY_DELETE', id: k.id });
            if (d && d.ok) loadDeviceKeys(); else $('deviceKeyMsg').textContent = (d && d.error) || 'Entfernen fehlgeschlagen.';
        });
        host.appendChild(row);
    });
    if (!host.children.length) host.innerHTML = '<span style="opacity:.7;">Noch kein Gerät registriert.</span>';
}
async function registerDeviceKey() {
    const msg = $('deviceKeyMsg');
    const btn = $('btnDeviceRegister');
    btn.disabled = true;
    msg.style.color = '';
    msg.textContent = '…';
    const begin = await send({ type: 'DEVICE_KEY_BEGIN' });
    if (!begin || !begin.ok) {
        msg.style.color = '#b45309';
        msg.textContent = begin && begin.locked ? 'Tresor gesperrt – bitte zuerst im Popup mit dem PIN entsperren.' : ((begin && begin.error) || 'Keine Verbindung zum Server.');
        btn.disabled = false;
        return;
    }
    let cred;
    try {
        cred = await navigator.credentials.create({ publicKey: {
            rp: { name: begin.rp_name || 'OpenNIT Vault' },
            user: { id: fromB64url(begin.user.id), name: begin.user.name, displayName: begin.user.display || begin.user.name },
            challenge: fromB64url(begin.challenge),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' },
            excludeCredentials: (begin.exclude || []).map(id => ({ type: 'public-key', id: fromB64url(id) })),
            attestation: 'none', timeout: 60000,
        } });
    } catch (e) {
        msg.style.color = '#b45309';
        msg.textContent = e && e.name === 'InvalidStateError' ? 'Dieses Gerät ist bereits registriert.'
            : e && e.name === 'NotAllowedError' ? 'Abgebrochen oder nicht bestätigt.' : ('Fehler: ' + (e && e.message || e));
        btn.disabled = false;
        return;
    }
    const r = await send({ type: 'DEVICE_KEY_COMPLETE', data: {
        origin: location.origin,
        client_data_json: b64url(cred.response.clientDataJSON),
        attestation_object: b64url(cred.response.attestationObject),
        label: deviceLabel(),
    } });
    btn.disabled = false;
    if (r && r.ok) { msg.style.color = '#198754'; msg.textContent = 'Gerät registriert.'; loadDeviceKeys(); }
    else { msg.style.color = '#b45309'; msg.textContent = (r && r.error) || 'Registrierung fehlgeschlagen.'; }
}

// Der Server nennt den Stand seiner Schnittstelle. Fehlt er oder ist er zu
// alt, sagt die Seite, welche Funktionen deshalb verborgen bleiben.
const REQUIRED_API = 2;
function showServerCompat(v) {
    const el = $('serverCompat');
    if (!el) return;
    el.style.display = '';
    if (v >= REQUIRED_API) {
        el.style.color = '#198754';
        el.textContent = '✓ Server-Schnittstelle Stand ' + v + ' – alle Funktionen verfügbar.';
    } else {
        el.style.color = '#b45309';
        el.textContent = '⚠ Server-Schnittstelle zu alt (Stand ' + v + ', benötigt ' + REQUIRED_API + '). Ohne Server-Update fehlen: '
            + 'Team-/Ordnerwahl beim Anlegen, Zusatzfelder, Passwort-Gesundheit, „Passwort aktualisieren?", Passkeys. '
            + 'Ein eingetragenes 2FA-Secret wird von älteren Servern verworfen.';
    }
}

$('btnSso').addEventListener('click', loginWithSso);
$('btnLogout').addEventListener('click', logoutSso);
reflectAuthState();
loadConnStatus();

function showStatus(msg, ok) {
    const el = $('statusMsg');
    el.innerHTML = `<div class="alert ${ok ? 'alert-success' : 'alert-danger'}">${msg}</div>`;
    setTimeout(() => { el.innerHTML = ''; }, 5000);
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }