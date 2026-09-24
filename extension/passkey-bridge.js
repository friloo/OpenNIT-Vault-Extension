'use strict';

/*
 * OpenNIT Vault – Passkey-Brücke (isolierte Welt, ab document_start)
 *
 * Nimmt die WebAuthn-Anfragen des Seitenskripts entgegen, prüft die Relying
 * Party gegen die tatsächliche Adresse der Seite, holt sich vom Hintergrund-
 * Worker die Passkeys des Tresors und zeigt die Auswahl bzw. den Speichern-
 * Dialog an. Der Server signiert; hier fließen nur Kennungen und Signaturen.
 */
(function () {
    if (window.__onvPasskeyBridge || window.top !== window) return;
    window.__onvPasskeyBridge = true;

    const REQ = '__onv_passkey_req__';
    const RES = '__onv_passkey_res__';
    const HOST_ID = '__onv_passkey_ui__';
    let appLabel = 'OpenNIT Vault';
    let apiVersion = null;
    const active = new Map(); // id -> { close() }

    function send(msg) {
        return new Promise(resolve => {
            try { chrome.runtime.sendMessage(msg, r => resolve(chrome.runtime.lastError ? null : r)); }
            catch { resolve(null); }
        });
    }
    function reply(id, result) { window.postMessage({ [RES]: true, id, result }, '*'); }
    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    function rpIdAllowed(rpId) {
        const host = location.hostname.toLowerCase();
        rpId = String(rpId || '').toLowerCase();
        return !!rpId && /^[a-z0-9.-]+$/.test(rpId) && (host === rpId || host.endsWith('.' + rpId));
    }

    async function serverReady() {
        if (apiVersion === null) {
            const st = await send({ type: 'CHECK_STATUS' });
            apiVersion = Number(st && st.api_version || 0);
            if (st && st.app_name) appLabel = st.app_name;
        }
        return apiVersion >= 2;
    }
    async function lockState() {
        const l = await send({ type: 'GET_LOCK' });
        return { required: !!(l && l.required), unlocked: !!(l && l.unlocked) };
    }

    // ── Oberfläche (Shadow DOM, seitenneutral) ─────────────────────────────
    const CSS = `
        :host { all: initial; }
        .ov { position: fixed; inset: 0; background: rgba(15,18,30,.45); z-index: 2147483647; display: flex; align-items: center; justify-content: center;
              font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; font-size: 13px; color: #1f2330; }
        .card { width: 360px; max-width: calc(100vw - 32px); background: #fff; border-radius: 14px; box-shadow: 0 18px 48px rgba(31,35,48,.35); overflow: hidden; }
        .hd { padding: 11px 15px; background: linear-gradient(135deg,#4f46e5 0%,#5b6ee8 45%,#3c8dbc 100%); color: #fff; font-weight: 700; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; display: flex; align-items: center; gap: 8px; }
        .bd { padding: 14px 15px 12px; }
        .t { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
        .s { color: #5b6478; font-size: 12px; margin-bottom: 10px; line-height: 1.45; }
        .it { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border: 1.5px solid #e3e6ef; border-radius: 10px; cursor: pointer; margin-bottom: 6px; background: #fff; }
        .it:hover, .it:focus { border-color: #4f46e5; background: #f5f6fb; outline: none; }
        .mono { width: 26px; height: 26px; border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; flex-shrink: 0; }
        .ti { flex: 1; min-width: 0; } .ti b { display: block; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ti span { display: block; color: #79839a; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .team { font-size: 9px; background: #ede9fe; color: #6d28d9; border-radius: 5px; padding: 1.5px 6px; font-weight: 700; flex-shrink: 0; }
        select, input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1.5px solid #e3e6ef; border-radius: 9px; font: inherit; font-size: 12.5px; background: #fff; color: #1f2330; margin-bottom: 8px; }
        label { display: block; font-size: 11px; color: #5b6478; margin: 4px 0 3px; }
        .row { display: flex; gap: 8px; margin-top: 10px; }
        button { flex: 1; padding: 9px 10px; border-radius: 9px; border: 1.5px solid #e3e6ef; background: #fff; font: inherit; font-size: 12px; font-weight: 600; color: #5b6478; cursor: pointer; }
        button:hover { background: #f5f6fb; }
        button.p { background: #4f46e5; border-color: #4f46e5; color: #fff; } button.p:hover { background: #4338ca; }
        .lk { display: flex; gap: 8px; align-items: center; background: #fff7ed; color: #9a3412; border-radius: 9px; padding: 9px 11px; font-size: 12px; margin-bottom: 8px; }
    `;

    function openDialog(build) {
        closeAll();
        const host = document.createElement('div');
        host.id = HOST_ID;
        const root = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = CSS;
        root.appendChild(style);
        const ov = document.createElement('div');
        ov.className = 'ov';
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = '<div class="hd"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
            + esc(appLabel) + ' &middot; Passkey</div><div class="bd"></div>';
        ov.appendChild(card);
        root.appendChild(ov);
        (document.body || document.documentElement).appendChild(host);
        const body = card.querySelector('.bd');
        const dlg = { host, body, close() { host.remove(); } };
        build(dlg);
        const first = body.querySelector('.it, select, button');
        if (first) setTimeout(() => first.focus(), 30);
        return dlg;
    }
    function closeAll() {
        const old = document.getElementById(HOST_ID);
        if (old) old.remove();
    }
    function monogram(title) {
        const s = String(title || '?');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
        return '<span class="mono" style="background:hsl(' + h + ',52%,90%);color:hsl(' + h + ',55%,38%);">' + esc(s.charAt(0).toUpperCase()) + '</span>';
    }
    function buttons(dlg, defs) {
        const row = document.createElement('div');
        row.className = 'row';
        defs.forEach(d => {
            const b = document.createElement('button');
            b.textContent = d.label;
            if (d.primary) b.className = 'p';
            b.addEventListener('click', d.onClick);
            row.appendChild(b);
        });
        dlg.body.appendChild(row);
    }

    // ── Sperre ─────────────────────────────────────────────────────────────
    function lockedDialog(id, what) {
        return new Promise(resolve => {
            const dlg = openDialog(d => {
                d.body.innerHTML = '<div class="t">Tresor gesperrt</div>'
                    + '<div class="s">' + esc(appLabel) + ' ist gesperrt. Entsperre den Tresor über das Symbol der Erweiterung und ' + what + ' danach erneut – oder nutze den Passkey des Browsers.</div>';
                buttons(d, [
                    { label: 'Abbrechen', onClick: () => { d.close(); resolve({ ok: false, name: 'NotAllowedError', error: 'Abgebrochen' }); } },
                    { label: 'Browser verwenden', primary: true, onClick: () => { d.close(); resolve({ fallback: true }); } },
                ]);
            });
            active.set(id, dlg);
        });
    }

    // ── Anmeldung (get) ────────────────────────────────────────────────────
    async function handleGet(id, p) {
        if (!rpIdAllowed(p.rpId) || !(await serverReady())) return { fallback: true };
        const lock = await lockState();
        const conditional = p.mediation === 'conditional';
        if (lock.required && !lock.unlocked) {
            return conditional ? { fallback: true } : lockedDialog(id, 'melde dich');
        }
        const r = await send({ type: 'PASSKEYS_FOR_RP', rpId: p.rpId });
        if (!r || !r.ok) return { fallback: true };
        let list = r.passkeys || [];
        if (p.allowCredentials && p.allowCredentials.length) {
            list = list.filter(k => p.allowCredentials.includes(k.credential_id));
        }
        if (!list.length) return { fallback: true };

        const choose = k => send({ type: 'PASSKEY_ASSERT', id: k.id, clientDataHash: p.clientDataHash })
            .then(a => (a && a.ok)
                ? { ok: true, credentialId: a.credential_id, authenticatorData: a.auth_data, signature: a.signature, userHandle: a.user_handle }
                : { ok: false, name: 'NotAllowedError', error: (a && a.error) || 'Signatur fehlgeschlagen' });

        if (conditional) {
            // Autofill-Variante: die Vorschläge erscheinen in der Vault-Liste am
            // Benutzerfeld (content.js); hier nur den Auftrag bereithalten.
            return new Promise(resolve => {
                const state = { rpId: p.rpId, passkeys: list, choose: k => { window.__onvConditionalPasskey = null; choose(k).then(resolve); } };
                window.__onvConditionalPasskey = state;
                active.set(id, { close() { if (window.__onvConditionalPasskey === state) window.__onvConditionalPasskey = null; } });
            });
        }

        return new Promise(resolve => {
            const dlg = openDialog(d => {
                d.body.innerHTML = '<div class="t">Mit Passkey anmelden</div><div class="s">' + esc(location.hostname) + ' fragt nach einem Passkey. Aus dem Tresor:</div>';
                list.forEach(k => {
                    const it = document.createElement('div');
                    it.className = 'it';
                    it.tabIndex = 0;
                    it.innerHTML = monogram(k.title) + '<span class="ti"><b>' + esc(k.title) + '</b><span>' + esc(k.user_display || k.user_name || '') + '</span></span>'
                        + (k.team_name ? '<span class="team">' + esc(k.team_name) + '</span>' : '');
                    const pick = () => { d.close(); choose(k).then(resolve); };
                    it.addEventListener('click', pick);
                    it.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
                    d.body.appendChild(it);
                });
                buttons(d, [
                    { label: 'Abbrechen', onClick: () => { d.close(); resolve({ ok: false, name: 'NotAllowedError', error: 'Abgebrochen' }); } },
                    { label: 'Browser verwenden', onClick: () => { d.close(); resolve({ fallback: true }); } },
                ]);
            });
            active.set(id, dlg);
        });
    }

    // ── Registrierung (create) ─────────────────────────────────────────────
    async function handleCreate(id, p) {
        if (!rpIdAllowed(p.rpId) || !(await serverReady())) return { fallback: true };
        const lock = await lockState();
        if (lock.required && !lock.unlocked) return lockedDialog(id, 'starte die Registrierung');

        const [own, matching, targets] = await Promise.all([
            send({ type: 'PASSKEYS_FOR_RP', rpId: p.rpId }),
            send({ type: 'GET_MATCHING_ENTRIES', url: 'https://' + p.rpId + '/' }),
            send({ type: 'GET_TARGETS' }),
        ]);
        if (own && own.ok && (p.excludeCredentials || []).some(c => (own.passkeys || []).some(k => k.credential_id === c))) {
            return { ok: false, name: 'InvalidStateError', error: 'Für diese Seite ist bereits ein Passkey aus dem Tresor registriert.' };
        }
        const entries = ((matching && matching.entries) || []).filter(e => e.can_write !== false);
        const suggested = p.userDisplay || p.userName || '';

        return new Promise(resolve => {
            const dlg = openDialog(d => {
                let html = '<div class="t">Passkey im Tresor speichern?</div>'
                    + '<div class="s">' + esc(p.rpName || p.rpId) + ' möchte einen Passkey' + (suggested ? ' für <b>' + esc(suggested) + '</b>' : '') + ' anlegen.</div>'
                    + '<label>Ablegen bei</label><select class="entry">';
                entries.forEach(e => {
                    html += '<option value="' + esc(e.id) + '">' + esc(e.title) + (e.username ? ' (' + esc(e.username) + ')' : '') + (e.team_name ? ' – ' + esc(e.team_name) : '') + '</option>';
                });
                html += '<option value="">Neuer Eintrag</option></select>';
                html += '<div class="new" style="display:' + (entries.length ? 'none' : 'block') + ';">'
                    + '<label>Titel</label><input class="title" value="' + esc(p.rpName || p.rpId) + '">'
                    + '<label>Ziel</label><select class="target"><option value="p:0">Persönlich</option>';
                if (targets && targets.ok) {
                    (targets.personal && targets.personal.folders || []).forEach(f => { html += '<option value="p:' + esc(f.id) + '">Persönlich / ' + esc(f.name) + '</option>'; });
                    (targets.teams || []).forEach(t => {
                        if (!t.can_write) return;
                        html += '<option value="t:' + esc(t.id) + ':0">Team ' + esc(t.name) + '</option>';
                        (t.folders || []).forEach(f => { html += '<option value="t:' + esc(t.id) + ':' + esc(f.id) + '">Team ' + esc(t.name) + ' / ' + esc(f.name) + '</option>'; });
                    });
                }
                html += '</select></div>';
                d.body.innerHTML = html;
                const sel = d.body.querySelector('.entry');
                const nw  = d.body.querySelector('.new');
                sel.addEventListener('change', () => { nw.style.display = sel.value ? 'none' : 'block'; });

                buttons(d, [
                    { label: 'Abbrechen', onClick: () => { d.close(); resolve({ ok: false, name: 'NotAllowedError', error: 'Abgebrochen' }); } },
                    { label: 'Im Browser', onClick: () => { d.close(); resolve({ fallback: true }); } },
                    { label: 'Speichern', primary: true, onClick: async () => {
                        const msg = {
                            type: 'PASSKEY_CREATE', rpId: p.rpId, rpName: p.rpName || '',
                            userHandle: p.userHandle, userName: p.userName || '', userDisplay: p.userDisplay || '',
                        };
                        if (sel.value) {
                            msg.entryId = sel.value;
                        } else {
                            msg.title = d.body.querySelector('.title').value.trim() || p.rpId;
                            const tv = String(d.body.querySelector('.target').value || 'p:0').split(':');
                            if (tv[0] === 't') { msg.teamId = tv[1]; msg.folderId = tv[2]; } else { msg.folderId = tv[1]; }
                        }
                        d.close();
                        const r = await send(msg);
                        resolve((r && r.ok)
                            ? { ok: true, credentialId: r.credential_id, attestationObject: r.attestation_object, authData: r.auth_data }
                            : { ok: false, name: 'NotAllowedError', error: (r && r.error) || 'Passkey konnte nicht angelegt werden' });
                    } },
                ]);
            });
            active.set(id, dlg);
        });
    }

    // ── Nachrichten des Seitenskripts ──────────────────────────────────────
    window.addEventListener('message', async e => {
        if (e.source !== window || !e.data || !e.data[REQ]) return;
        const { id, kind, payload } = e.data;
        if (kind === 'cancel') {
            const a = active.get(id);
            if (a) { a.close(); active.delete(id); }
            return;
        }
        let result;
        try {
            result = kind === 'get' ? await handleGet(id, payload || {})
                   : kind === 'create' ? await handleCreate(id, payload || {})
                   : { fallback: true };
        } catch {
            result = { fallback: true };
        }
        active.delete(id);
        reply(id, result);
    });
})();
