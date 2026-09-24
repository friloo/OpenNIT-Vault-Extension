'use strict';

/*
 * OpenNIT Vault – Content-Script
 * Robuste Erkennung von Passwort-, Benutzer-/E-Mail- und TOTP-Feldern
 * inkl. Shadow-DOM, dynamischen Formularen, mehrstufigen Logins und
 * segmentierten OTP-Eingaben. Autofill via nativem Value-Setter + Events
 * (framework-kompatibel: React/Vue/Angular).
 */
if (!window.__vaultInjected) {
window.__vaultInjected = true;

const DROPDOWN_ID = '__vault_dropdown__';
let appLabel = 'Vault';
let currentField = null;
let showGen = 0;
let typedField = null;          // Feld, in das der Nutzer zuletzt selbst getippt hat
let fillingInProgress = false;  // unterdrückt die Tipp-Erkennung beim Autofill
let pendingFillInFlight = false; // der Auftrag wird beim Abholen verbraucht – nur einmal gleichzeitig

// ── Heuristik-Muster ────────────────────────────────────────────────────────
const RE_USER     = /(user(name|id)?|login|logon|sign[-_ ]?in|account|konto|benutzer|kennung|anmeld|e[-_ ]?mail|email|mail|uid|userid|handle|identifier|ident\b|loginid)/i;
const RE_USER_NEG = /(search|suche|query|coupon|promo|voucher|gift|zip|postal|plz|phone|tel|mobile|firstname|lastname|first[-_ ]?name|last[-_ ]?name|vorname|nachname|street|strasse|address|adresse|city|stadt|country|land|company|firma|captcha|amount|menge|quantity|qty)/i;
const RE_PASS     = /(pass(word|wort)?|pwd|passwd|kennwort|passphrase)/i;
const RE_PASS_NEG = /(hint|frage|question|reminder|recovery|forgot|vergessen)/i;
const RE_OTP      = /(otp|totp|2fa|mfa|one[-_ ]?time|einmal|verification|verify|verifizier|authenticat|auth[-_ ]?code|security[-_ ]?code|sms[-_ ]?code|passcode|one_?time_?code|2[-_ ]?step|two[-_ ]?factor|bestätigungscode|einmalkennwort|einmalpasswort)/i;
const RE_CODEONLY = /(\b|_)(code|pin|token)(\b|_)/i;

// ── kleine Helfer ───────────────────────────────────────────────────────────
function lc(s) { return String(s || '').toLowerCase(); }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function vaultHue(s) { s = String(s || '?'); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
function vaultClipCopy(text) {
    // Ohne frische Nutzerinteraktion verweigert der Browser den direkten Zugriff;
    // dann schreibt der Hintergrund über das Offscreen-Dokument.
    navigator.clipboard.writeText(text).catch(() => {
        try { chrome.runtime.sendMessage({ type: 'CLIP_WRITE', text: text }); } catch (e) { /* ignore */ }
    });
    try { chrome.runtime.sendMessage({ type: 'SCHEDULE_CLIP_CLEAR', text: text }); } catch (e) { /* ignore */ }
}
function attr(el, n) { try { return el.getAttribute(n) || ''; } catch { return ''; } }
function ac(el) { return lc(attr(el, 'autocomplete')); }

function isVisible(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    if (lc(el.type) === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (parseFloat(s.opacity || '1') === 0) return false;
    return true;
}

function labelText(el) {
    const parts = [];
    try {
        if (el.id) {
            const sel = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id;
            const l = document.querySelector('label[for="' + sel + '"]');
            if (l) parts.push(l.textContent);
        }
    } catch {}
    const wrap = el.closest ? el.closest('label') : null;
    if (wrap) parts.push(wrap.textContent);
    const lb = attr(el, 'aria-labelledby');
    if (lb) lb.split(/\s+/).forEach(id => { const n = document.getElementById(id); if (n) parts.push(n.textContent); });
    return parts.join(' ').slice(0, 200);
}

function sig(el) {
    return lc([
        el.name, el.id, attr(el, 'autocomplete'), el.placeholder,
        attr(el, 'aria-label'), el.title, attr(el, 'data-testid'),
        attr(el, 'ng-model'), el.className, labelText(el),
    ].join(' '));
}

function isTextLike(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    return ['text', 'email', 'tel', 'search', 'url', 'number', ''].includes(lc(el.type || 'text'));
}

// ── Feld-Klassifikation ─────────────────────────────────────────────────────
function isPasswordField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    if (lc(el.type) === 'password') return true;
    const a = ac(el);
    if (a.includes('current-password') || a.includes('new-password')) return true;
    // sichtbar geschaltetes Passwortfeld (type=text)
    if (isTextLike(el)) {
        const s = sig(el);
        if (RE_PASS.test(s) && !RE_PASS_NEG.test(s) && !RE_USER.test(lc(el.name + ' ' + el.id))) return true;
    }
    return false;
}

function isOtpField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const t = lc(el.type);
    if (['password', 'checkbox', 'radio', 'submit', 'button', 'file', 'hidden', 'range', 'color', 'date'].includes(t)) return false;
    if (ac(el).includes('one-time-code')) return true;
    const s = sig(el);
    const ml = parseInt(attr(el, 'maxlength') || '0', 10);
    const pat = lc(attr(el, 'pattern'));
    const numeric = lc(el.inputMode || '') === 'numeric' || pat.includes('0-9') || pat.includes('\\d') || t === 'number' || t === 'tel';
    if (RE_OTP.test(s)) return true;
    if (RE_CODEONLY.test(s) && (numeric || (ml > 0 && ml <= 8))) return true;
    // segmentierte OTP-Eingabe (mehrere 1-Zeichen-Felder)
    if (ml === 1 && numeric) return segmentGroup(el).length >= 4;
    return false;
}

function isUsernameField(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    const t = lc(el.type || 'text');
    if (['password', 'submit', 'button', 'hidden', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'date', 'datetime-local', 'month', 'week', 'time'].includes(t)) return false;
    if (isOtpField(el)) return false;
    const a = ac(el);
    if (a.includes('username') || a === 'email') return true;
    if (t === 'email') return true;
    const s = sig(el);
    return RE_USER.test(s) && !RE_USER_NEG.test(s);
}

// Felder, die eine eigene Vorschlagsliste unter sich aufklappen (ARIA-Combobox,
// <input list>). Dort verdeckt unser Dropdown die Treffer der Seite.
function hasOwnSuggestionList(el) {
    if (!el) return false;
    if (attr(el, 'list')) return true;                                  // datalist
    const isCombo = lc(attr(el, 'role')) === 'combobox'
        || !!(el.closest && el.closest('[role="combobox"]'));
    if (!isCombo) return false;
    const auto = lc(attr(el, 'aria-autocomplete'));
    if (auto === 'list' || auto === 'both') return true;
    // Verweist die Combobox auf ein eigenes Listenelement bzw. meldet ihren
    // Auf-/Zuklapp-Zustand, hat sie eine eigene Trefferliste.
    return !!(attr(el, 'aria-controls') || attr(el, 'aria-owns') || attr(el, 'aria-expanded'));
}

// Vom Seitenautor ausdrücklich als Login-Feld ausgezeichnet – wiegt schwerer als
// die Combobox-Erkennung, damit echte Anmeldeformulare weiter Vorschläge bekommen.
function isDeclaredLoginField(el) {
    const a = ac(el);
    return a.includes('username') || a.includes('password') || a.includes('one-time-code');
}

function isLoginField(el) { return isPasswordField(el) || isUsernameField(el) || isOtpField(el); }
function fieldKind(el) {
    if (isPasswordField(el)) return 'password';
    if (isOtpField(el)) return 'otp';
    if (isUsernameField(el)) return 'username';
    return null;
}

// ── Shadow-DOM-fähige Feldsammlung ──────────────────────────────────────────
function collectInputs(container) {
    const out = [];
    const visit = (root) => {
        let nodes;
        try { nodes = root.querySelectorAll('input, textarea'); } catch { nodes = []; }
        nodes.forEach(n => out.push(n));
        let all;
        try { all = root.querySelectorAll('*'); } catch { all = []; }
        all.forEach(n => { if (n.shadowRoot) visit(n.shadowRoot); });
    };
    visit(container || document);
    return out;
}

function scopeOf(field) {
    const form = field.closest ? field.closest('form') : null;
    if (form) return form;
    const root = field.getRootNode ? field.getRootNode() : null;
    if (root && root.host && root.host.closest) {
        const f = root.host.closest('form');
        if (f) return f;
    }
    return document.body;
}

function segmentGroup(el) {
    const parent = el.parentElement;
    if (!parent) return [el];
    const sibs = [...parent.querySelectorAll('input')].filter(i => parseInt(attr(i, 'maxlength') || '0', 10) === 1);
    return sibs.length >= 4 ? sibs : [el];
}

function findUsernameField(ref) {
    const inputs = collectInputs(scopeOf(ref)).filter(isVisible);
    const idx = inputs.indexOf(ref);
    for (let i = idx - 1; i >= 0; i--) if (isUsernameField(inputs[i])) return inputs[i];
    for (let i = idx + 1; i < inputs.length; i++) if (isUsernameField(inputs[i])) return inputs[i];
    // positionaler Fallback: Textfeld direkt vor dem Passwort
    for (let i = idx - 1; i >= 0; i--) if (isTextLike(inputs[i]) && !isOtpField(inputs[i])) return inputs[i];
    return null;
}

function findPasswordField(ref) {
    const inputs = collectInputs(scopeOf(ref));
    const vis = inputs.filter(isVisible);
    return vis.find(isPasswordField) || inputs.find(isPasswordField) || null;
}

function findOtpFields(ref) {
    return collectInputs(scopeOf(ref)).filter(el => isVisible(el) && isOtpField(el));
}

// ── Events ──────────────────────────────────────────────────────────────────
function init() {
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('scroll', repositionDrop, true);
    window.addEventListener('resize', repositionDrop, true);
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg.type === 'VAULT_FILL') {
            fillFromPopup(msg);
            sendResponse({ ok: true });
            return true;
        }
    });
    chrome.runtime.sendMessage({ type: 'CHECK_STATUS' }, resp => { if (resp && resp.app_name) appLabel = resp.app_name; });
}

// Vom Popup angestoßenes Ausfüllen (ohne fokussiertes Feld): bestes
// Passwort-/Benutzerfeld der Seite suchen und befüllen.
function fillFromPopup(msg) {
    const inputs = collectInputs(document).filter(isVisible);
    const passField = inputs.find(isPasswordField) || null;
    let userField = passField ? findUsernameField(passField) : null;
    if (!userField) userField = inputs.find(isUsernameField) || null;

    if (userField && msg.username) setFieldValue(userField, msg.username);
    if (passField && msg.password) setFieldValue(passField, msg.password);
    else if (msg.password) chrome.runtime.sendMessage({ type: 'SET_PENDING_FILL', id: msg.id, pw: msg.password, user: msg.username || '' });

    if (msg.has_totp && msg.id != null) {
        armTotp(msg.id);
        deliverTotp(msg.id, findOtpFields(passField || userField || document.body));
    }
}

function onFocusIn(e) {
    // Beim Betreten des 2FA-Feldes einen frischen Code bereitlegen.
    if (isOtpField(e.target) && isVisible(e.target)) serveArmedTotp([e.target], false);
    maybeShow(e.target);
}
function onPointerDown(e) {
    const drop = document.getElementById(DROPDOWN_ID);
    if (drop && drop.contains(e.target)) return;
    maybeShow(e.target);
}

// Sobald der Nutzer selbst tippt, gehört der Platz unter dem Feld der Seite –
// dort erscheint typischerweise deren eigene Suche. Das Feld bleibt bis zum
// Leeren gesperrt, damit ein erneuter Klick das Dropdown nicht zurückholt.
function onInput(e) {
    const el = e.target;
    if (fillingInProgress || !el || !el.value) {
        if (el && !el.value && typedField === el) typedField = null;
        return;
    }
    typedField = el;
    if (el === currentField) hideDrop();
}
function isTypingSuppressed(el) { return el === typedField && !!el.value; }

function maybeShow(el) {
    if (!isLoginField(el) || !isVisible(el)) return;
    // Eigene Vorschlagsliste der Seite hat Vorrang.
    if (hasOwnSuggestionList(el) && !isDeclaredLoginField(el)) return;
    if (isTypingSuppressed(el)) return;
    currentField = el;
    showSuggestions(el);
}
function onFocusOut(e) {
    const blurred = e.target;
    setTimeout(() => {
        const active = document.activeElement;
        const drop = document.getElementById(DROPDOWN_ID);
        if (active === blurred || active === currentField || (drop && drop.contains(active))) return;
        hideDrop();
        currentField = null;
    }, 200);
}
function onDocClick(e) {
    const drop = document.getElementById(DROPDOWN_ID);
    if (drop && drop.contains(e.target)) return;
    if (e.target === currentField) return;
    hideDrop();
}
function onKeyDown(e) {
    const drop = document.getElementById(DROPDOWN_ID);
    if (!drop) return;
    const items = [...drop.querySelectorAll('.vi')];
    if (!items.length) return;
    let idx = items.findIndex(i => i.classList.contains('selected'));
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(items, idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(items, idx - 1); }
    else if (e.key === 'Enter' && idx >= 0) { e.preventDefault(); items[idx].click(); }
    else if (e.key === 'Escape') { hideDrop(); currentField = null; }
}
function setSelected(items, idx) {
    items.forEach(i => i.classList.remove('selected'));
    const next = items[Math.max(0, Math.min(idx, items.length - 1))];
    if (next) { next.classList.add('selected'); next.scrollIntoView({ block: 'nearest' }); }
}

// ── Vorschläge ──────────────────────────────────────────────────────────────
function showSuggestions(field) {
    const gen = ++showGen;
    const mode = fieldKind(field) === 'otp' ? 'otp' : 'login';
    chrome.runtime.sendMessage({ type: 'GET_MATCHING_ENTRIES', url: location.href }, resp => {
        if (gen !== showGen) return;
        let entries = (resp && resp.entries || []).filter(e => VaultUrl.matches(e.url, location.href));
        if (mode === 'otp') entries = entries.filter(e => e.has_totp);
        if (!entries.length) { hideDrop(); return; }
        if (document.contains(field) && isVisible(field)) renderDrop(field, entries, mode);
    });
}

function repositionDrop() {
    const drop = document.getElementById(DROPDOWN_ID);
    if (!drop || !currentField) return;
    const r = currentField.getBoundingClientRect();
    if (r.width === 0) { hideDrop(); return; }
    drop.style.top = (r.bottom + 2) + 'px';
    drop.style.left = r.left + 'px';
    drop.style.width = Math.max(r.width, 300) + 'px';
}

function renderDrop(field, entries, mode) {
    hideDrop();
    const rect = field.getBoundingClientRect();
    if (rect.width === 0) return;

    const drop = document.createElement('div');
    drop.id = DROPDOWN_ID;
    Object.assign(drop.style, {
        position: 'fixed', top: (rect.bottom + 4) + 'px', left: rect.left + 'px',
        width: Math.max(rect.width, 300) + 'px', background: '#fff', border: '1px solid #e3e6ef',
        borderRadius: '12px', boxShadow: '0 10px 32px rgba(31,35,48,.20)', zIndex: '2147483647',
        fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif', fontSize: '13px',
        overflow: 'hidden', maxHeight: '320px', overflowY: 'auto', color: '#1f2330',
    });

    // Hover-/Auswahl-Highlight (scoped auf unser Dropdown – page-safe)
    const styleEl = document.createElement('style');
    styleEl.textContent = '#' + DROPDOWN_ID + ' .vi:hover,#' + DROPDOWN_ID + ' .vi.selected{background:#f5f6fb !important;}';
    drop.appendChild(styleEl);

    const hd = document.createElement('div');
    Object.assign(hd.style, {
        padding: '9px 13px', background: 'linear-gradient(135deg,#4f46e5 0%,#5b6ee8 45%,#3c8dbc 100%)',
        color: '#fff', fontWeight: '700', fontSize: '10.5px',
        display: 'flex', alignItems: 'center', gap: '7px', letterSpacing: '.05em', textTransform: 'uppercase',
    });
    hd.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> '
        + esc(appLabel) + (mode === 'otp' ? ' &middot; 2FA' : ' &middot; Vault');
    drop.appendChild(hd);

    entries.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'vi';
        item.dataset.id = entry.id;
        Object.assign(item.style, {
            padding: '9px 13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px',
            borderBottom: '1px solid #f1f3f5', background: '#fff', transition: 'background .1s',
        });

        const _hue = vaultHue(entry.title || '?');
        const favSpan = document.createElement('span');
        Object.assign(favSpan.style, {
            width: '22px', height: '22px', borderRadius: '6px', display: 'inline-flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '11px', fontWeight: '700', flexShrink: '0', overflow: 'hidden',
            background: 'hsl(' + _hue + ',52%,90%)', color: 'hsl(' + _hue + ',55%,38%)',
        });
        favSpan.textContent = (entry.title || '?').charAt(0).toUpperCase();
        // Serverseitig gecachtes Favicon nachladen (kein externer Call)
        if (entry.has_favicon) {
            chrome.runtime.sendMessage({ type: 'GET_FAVICON', id: entry.id }, r => {
                if (r && r.dataUrl) {
                    favSpan.style.background = '#eef0f7';
                    favSpan.innerHTML = '<img src="' + r.dataUrl + '" alt="" style="width:16px;height:16px;object-fit:contain;">';
                }
            });
        }

        const team = entry.team_name
            ? '<span style="font-size:9px;background:#ede9fe;color:#6d28d9;border-radius:5px;padding:1.5px 6px;white-space:nowrap;flex-shrink:0;font-weight:700;">' + esc(entry.team_name) + '</span>'
            : '';
        const sub = mode === 'otp'
            ? '<span style="color:#4f46e5;font-size:11px;font-weight:600;">2FA-Code einfügen</span>'
            : '<div style="color:#79839a;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (esc(entry.username) || '<em style="color:#aab2c3">Kein Benutzername</em>') + '</div>';

        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        info.innerHTML = '<div style="font-weight:600;color:#1f2330;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px;">'
            + esc(entry.title) + '</div>' + sub;

        item.appendChild(favSpan);
        item.appendChild(info);
        if (team) {
            const t = document.createElement('span');
            t.innerHTML = team;
            item.appendChild(t.firstChild);
        }

        item.addEventListener('mouseenter', () => {
            [...drop.querySelectorAll('.vi')].forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
        });

        // optionaler 2FA-Chip im Login-Modus
        if (mode === 'login' && entry.has_totp) {
            const chip = document.createElement('button');
            Object.assign(chip.style, {
                background: '#e0f2fe', border: '1px solid #bae0fd', borderRadius: '6px', padding: '2px 7px',
                fontSize: '9px', fontWeight: '700', color: '#0369a1', cursor: 'pointer', flexShrink: '0',
                letterSpacing: '.03em', fontFamily: 'inherit',
            });
            chip.textContent = '2FA';
            chip.title = '2FA-Code kopieren';
            chip.addEventListener('mousedown', ev => {
                ev.preventDefault(); ev.stopPropagation();
                chrome.runtime.sendMessage({ type: 'GET_TOTP', id: entry.id }, r => {
                    if (r && r.code) { vaultClipCopy(r.code); showTotpNotification(r.code, r.remaining); }
                });
            });
            item.appendChild(chip);
        }

        item.addEventListener('mousedown', ev => {
            if (ev.target.tagName === 'BUTTON') return;
            ev.preventDefault(); ev.stopPropagation();
            if (mode === 'otp') fillOtp(field, entry);
            else fillEntry(entry, field);
            hideDrop();
        });
        drop.appendChild(item);
    });

    const ft = document.createElement('div');
    Object.assign(ft.style, { padding: '5px 12px', color: '#79839a', fontSize: '10px', textAlign: 'center', background: '#f6f7fb', borderTop: '1px solid #edeff4' });
    ft.innerHTML = '&uarr;&darr; Navigieren &middot; Enter Ausw&auml;hlen &middot; Esc Schlie&szlig;en';
    drop.appendChild(ft);

    document.documentElement.appendChild(drop);
}

function hideDrop() {
    const d = document.getElementById(DROPDOWN_ID);
    if (d) d.remove();
}

// ── Befüllen ────────────────────────────────────────────────────────────────
async function fillEntry(entry, focused) {
    let pw = '';
    try { const r = await chrome.runtime.sendMessage({ type: 'GET_PASSWORD', id: entry.id }); pw = (r && r.password) || ''; } catch {}

    const kind = fieldKind(focused) || 'username';
    let userField = null, passField = null;
    if (kind === 'password') { passField = focused; userField = findUsernameField(focused); }
    else { userField = focused; passField = findPasswordField(focused); }

    if (userField && entry.username) setFieldValue(userField, entry.username);
    if (passField) setFieldValue(passField, pw);
    else chrome.runtime.sendMessage({ type: 'SET_PENDING_FILL', id: entry.id, pw: pw, user: entry.username || '' });

    if (entry.has_totp) {
        // Der 2FA-Schritt folgt oft erst nach dem Absenden – ggf. auf der nächsten
        // Seite. Deshalb den Eintrag vormerken, damit dort ein frischer Code
        // bereitgestellt werden kann.
        armTotp(entry.id);
        deliverTotp(entry.id, findOtpFields(passField || userField || focused));
    }
}

// ── 2FA-Code für den nächsten Schritt bereitlegen ───────────────────────────
// Nach dem Ausfüllen eines Eintrags mit 2FA bleibt der Eintrag kurz vorgemerkt.
// Taucht danach ein 2FA-Feld auf – auf derselben oder einer Folgeseite –, landet
// ein frischer Code in der Zwischenablage, sodass Strg+V genügt.
const TOTP_ARM_TTL   = 5 * 60 * 1000; // Vormerkung nach dem Ausfüllen
const TOTP_RECOPY_MS = 5000;          // Mindestabstand zwischen zwei Kopiervorgängen
let lastTotpCopy = 0;
let totpRequestPending = false;  // Fokus und Seiten-Scan können gleichzeitig auslösen
const totpServedFields = new WeakSet();

function armTotp(entryId) {
    try { chrome.storage.local.set({ __armedTotp: { id: entryId, ts: Date.now() } }); } catch (e) { /* ignore */ }
}

function deliverTotp(entryId, fields, done) {
    chrome.runtime.sendMessage({ type: 'GET_TOTP', id: entryId }, t => {
        if (t && t.code) {
            if (fields && fields.length) distributeOtp(fields, t.code);
            lastTotpCopy = Date.now();
            vaultClipCopy(t.code);
            showTotpNotification(t.code, t.remaining);
        }
        if (done) done();
    });
}

/**
 * Automatischer Weg: nur kopieren und anzeigen. Ins Feld geschrieben wird ein Code
 * ausschließlich, wenn der Nutzer den Eintrag selbst ausgewählt hat.
 *
 * @param {Element[]} fields  erkannte 2FA-Felder
 * @param {boolean} oncePerField  true beim automatischen Auftauchen (je Feld einmal),
 *                                false beim Fokussieren – dort darf nach Ablauf des
 *                                Codes erneut ein frischer kopiert werden.
 */
function serveArmedTotp(fields, oncePerField) {
    const relevant = oncePerField ? fields.filter(f => !totpServedFields.has(f)) : fields;
    if (!relevant.length || totpRequestPending) return;
    if (Date.now() - lastTotpCopy < TOTP_RECOPY_MS) return;
    totpRequestPending = true;
    chrome.storage.local.get(['__armedTotp', 'totpAutoCopy'], res => {
        const armed = res.__armedTotp;
        if (res.totpAutoCopy === false || !armed || Date.now() - armed.ts > TOTP_ARM_TTL) {
            totpRequestPending = false;
            return;
        }
        relevant.forEach(f => totpServedFields.add(f));
        deliverTotp(armed.id, null, () => { totpRequestPending = false; });
    });
}

function fillOtp(field, entry) {
    chrome.runtime.sendMessage({ type: 'GET_TOTP', id: entry.id }, t => {
        if (!t || !t.code) return;
        const group = segmentGroup(field);
        if (group.length >= 4) distributeOtp(group, t.code);
        else setFieldValue(field, t.code);
        vaultClipCopy(t.code);
        showTotpNotification(t.code, t.remaining);
    });
}

function distributeOtp(fields, code) {
    const digits = String(code).replace(/\s+/g, '').split('');
    if (fields.length >= digits.length && fields.length > 1) {
        fields.forEach((f, i) => setFieldValue(f, digits[i] || ''));
        const last = fields[Math.min(digits.length, fields.length) - 1];
        if (last) last.focus({ preventScroll: true });
    } else {
        setFieldValue(fields[0], String(code).replace(/\s+/g, ''));
    }
}

function setFieldValue(field, value) {
    fillingInProgress = true;
    try {
        field.focus({ preventScroll: true });
        const proto = (typeof HTMLTextAreaElement !== 'undefined' && field instanceof HTMLTextAreaElement)
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(field, value); else field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
        field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        field.dispatchEvent(new Event('blur', { bubbles: true }));
    } catch {}
    fillingInProgress = false;
}

// ── Mehrstufiger Login: Passwort/2FA nach dem Erscheinen bedienen ────────────
// Der Scan ist entkoppelt vom Mutations-Takt: eine Seite kann pro Sekunde
// hunderte Mutationen erzeugen, die Feldsuche läuft davon unabhängig gedrosselt.
const SCAN_DEBOUNCE_MS = 250;
let scanTimer = null;

function scanForPendingWork() {
    const inputs = collectInputs(document).filter(isVisible);

    const otps = inputs.filter(isOtpField);
    if (otps.length) serveArmedTotp(otps, true);

    const pw = inputs.filter(isPasswordField);
    if (!pw.length || pendingFillInFlight) return;
    pendingFillInFlight = true;
    chrome.runtime.sendMessage({ type: 'TAKE_PENDING_FILL' }, resp => {
        pendingFillInFlight = false;
        const p = resp && resp.fill;
        if (!p) return;
        pw.forEach(f => setFieldValue(f, p.pw));
        if (p.user) {
            const uf = findUsernameField(pw[0]);
            if (uf && !uf.value) setFieldValue(uf, p.user);
        }
    });
}

const _obs = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scanForPendingWork(); }, SCAN_DEBOUNCE_MS);
});
try { _obs.observe(document.documentElement, { childList: true, subtree: true }); } catch {}
// Bei einem Seitenwechsel steht das 2FA-Feld oft schon im ersten Rendering.
scanForPendingWork();

// ── TOTP-Benachrichtigung (unten rechts) ────────────────────────────────────
const TOTP_PERIOD = 30; // Sekunden pro Code (RFC 6238, Serverseite nutzt denselben Wert)

function showTotpNotification(code, remaining) {
    const ID = '__vault_totp_notif__';
    const old = document.getElementById(ID);
    if (old) old.remove();

    const formatted = String(code).length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code;
    const notif = document.createElement('div');
    notif.id = ID;
    Object.assign(notif.style, {
        position: 'fixed', bottom: '18px', right: '18px', background: '#212529', color: '#fff',
        padding: '10px 14px', borderRadius: '8px', fontSize: '12px',
        fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', zIndex: '2147483647',
        boxShadow: '0 4px 16px rgba(0,0,0,.35)', display: 'flex', flexDirection: 'column', gap: '6px',
        minWidth: '180px', cursor: 'pointer',
    });
    notif.innerHTML =
        '<div style="display:flex;align-items:center;gap:7px;"><span style="font-size:14px;">🔑</span>'
        + '<span style="color:#adb5bd;font-size:10px;flex:1;">2FA-Code kopiert</span></div>'
        + '<div style="font-family:monospace;font-size:18px;font-weight:700;letter-spacing:.12em;">' + esc(formatted) + '</div>'
        + '<div style="display:flex;align-items:center;gap:7px;"><div style="flex:1;height:3px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden;">'
        + '<div id="__vault_totp_bar" style="height:100%;background:#28a745;width:' + Math.min(100, remaining / TOTP_PERIOD * 100) + '%;transition:width 1s linear;"></div></div>'
        + '<span id="__vault_totp_t" style="font-size:10px;color:#adb5bd;min-width:22px;text-align:right;">' + remaining + 's</span></div>';
    document.documentElement.appendChild(notif);

    // Gegen einen festen Ablaufzeitpunkt rechnen, damit die Anzeige auch nach
    // gedrosselten oder ausgefallenen Timer-Ticks stimmt.
    const deadline = Date.now() + (Number(remaining) > 0 ? Number(remaining) : TOTP_PERIOD) * 1000;
    const iv = setInterval(() => {
        const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        const t = document.getElementById('__vault_totp_t');
        const bar = document.getElementById('__vault_totp_bar');
        if (secs === 0 || !t) { clearInterval(iv); notif.style.transition = 'opacity .4s'; notif.style.opacity = '0'; setTimeout(() => notif.remove(), 400); return; }
        t.textContent = secs + 's';
        if (bar) { bar.style.width = Math.min(100, secs / TOTP_PERIOD * 100) + '%'; if (secs <= 10) bar.style.background = '#dc3545'; }
    }, 1000);
    notif.addEventListener('click', () => { clearInterval(iv); notif.remove(); });
}

init();
}