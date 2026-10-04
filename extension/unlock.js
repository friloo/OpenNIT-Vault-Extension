'use strict';

/*
 * Geräte-Entsperrung: Diese Seite läuft in einem eigenen kleinen Fenster, weil
 * WebAuthn ein normales Erweiterungsfenster braucht. Sie holt die Challenge
 * vom Worker, lässt das Gerät signieren und reicht die Antwort weiter; der
 * Server prüft und setzt das Entsperr-Fenster.
 */
function $(id) { return document.getElementById(id); }
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

async function unlock() {
    const btn = $('btnGo'), msg = $('msg');
    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = '';
    const begin = await send({ type: 'UNLOCK_DEVICE_BEGIN' });
    if (!begin || !begin.ok) { msg.textContent = (begin && begin.error) || 'Keine Verbindung zum Server.'; btn.disabled = false; return; }
    if (begin.no_pin) { msg.className = 'msg ok'; msg.textContent = 'Kein PIN aktiv – der Tresor ist nicht gesperrt.'; setTimeout(() => window.close(), 1200); return; }
    let cred;
    try {
        cred = await navigator.credentials.get({ publicKey: {
            challenge: fromB64url(begin.challenge),
            allowCredentials: (begin.allow || []).map(id => ({ type: 'public-key', id: fromB64url(id) })),
            userVerification: 'required',
            timeout: 60000,
        } });
    } catch (e) {
        msg.textContent = e && e.name === 'NotAllowedError' ? 'Abgebrochen oder nicht bestätigt.' : ('Fehler: ' + (e && e.message || e));
        btn.disabled = false;
        return;
    }
    const r = await send({ type: 'UNLOCK_DEVICE', assertion: {
        credential_id: cred.id,
        client_data_json: b64url(cred.response.clientDataJSON),
        authenticator_data: b64url(cred.response.authenticatorData),
        signature: b64url(cred.response.signature),
    } });
    if (r && r.ok) {
        msg.className = 'msg ok';
        msg.textContent = 'Entsperrt.';
        setTimeout(() => window.close(), 700);
    } else {
        msg.textContent = (r && r.error) || 'Entsperrung fehlgeschlagen.';
        btn.disabled = false;
    }
}
$('btnGo').addEventListener('click', unlock);
unlock();
