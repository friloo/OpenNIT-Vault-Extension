'use strict';

/*
 * OpenNIT Vault – Passkey-Seitenskript (läuft im Kontext der Webseite)
 *
 * Überschreibt navigator.credentials.create/get für Public-Key-Credentials.
 * Jede Anfrage geht über window.postMessage an das Brückenskript der
 * Erweiterung; von dort kommt entweder eine fertige Antwort (der Tresor hat
 * signiert bzw. einen Passkey angelegt) oder die Aufforderung, den nativen
 * Browser-Dialog zu verwenden. Schlüsselmaterial erreicht diese Seite nie –
 * nur Signaturen und öffentliche Daten.
 */
(function () {
    if (window.__onvPasskeyPatched || !navigator.credentials || !window.PublicKeyCredential) return;
    window.__onvPasskeyPatched = true;

    const REQ = '__onv_passkey_req__';
    const RES = '__onv_passkey_res__';
    const nativeCreate = navigator.credentials.create.bind(navigator.credentials);
    const nativeGet    = navigator.credentials.get.bind(navigator.credentials);
    const pending = new Map();
    let seq = 0;

    // ── Kodierung ──────────────────────────────────────────────────────────
    function toBytes(v) {
        if (v instanceof ArrayBuffer) return new Uint8Array(v);
        if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        if (typeof v === 'string') return new TextEncoder().encode(v);
        return new Uint8Array(0);
    }
    function b64url(bytes) {
        let s = '';
        toBytes(bytes).forEach(b => { s += String.fromCharCode(b); });
        return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function fromB64url(s) {
        s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        const bin = atob(s);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    function buf(bytes) { const b = toBytes(bytes); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(bytes))); }

    // Die Relying Party darf nur die eigene Domain oder eine übergeordnete sein.
    function rpIdAllowed(rpId) {
        const host = location.hostname.toLowerCase();
        rpId = String(rpId || '').toLowerCase();
        return !!rpId && (host === rpId || host.endsWith('.' + rpId));
    }

    function clientData(type, challenge) {
        return new TextEncoder().encode(JSON.stringify({
            type, challenge: b64url(challenge), origin: location.origin, crossOrigin: false,
        }));
    }

    // ── Brücke ─────────────────────────────────────────────────────────────
    function request(kind, payload, signal) {
        return new Promise((resolve, reject) => {
            const id = ++seq;
            pending.set(id, { resolve, reject });
            if (signal) {
                if (signal.aborted) { pending.delete(id); reject(abortError()); return; }
                signal.addEventListener('abort', () => {
                    if (!pending.has(id)) return;
                    pending.delete(id);
                    window.postMessage({ [REQ]: true, id, kind: 'cancel' }, '*');
                    reject(abortError());
                }, { once: true });
            }
            window.postMessage({ [REQ]: true, id, kind, payload }, '*');
        });
    }
    window.addEventListener('message', e => {
        if (e.source !== window || !e.data || !e.data[RES]) return;
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        p.resolve(e.data.result || {});
    });

    function abortError() { return new DOMException('The operation was aborted.', 'AbortError'); }
    function domError(res) {
        return new DOMException(res.error || 'The operation either timed out or was not allowed.', res.name || 'NotAllowedError');
    }

    // ── Antwortobjekte ─────────────────────────────────────────────────────
    // Eigene Objekte mit dem Prototyp der nativen Klassen: instanceof-Prüfungen
    // der Seite gehen durch, alle Felder sind eigene Eigenschaften.
    function credential(idBytes, response, responseProto, extensions, kind) {
        const resp = Object.create(responseProto);
        Object.entries(response).forEach(([k, v]) => Object.defineProperty(resp, k, { value: v, enumerable: true }));

        const cred = Object.create(PublicKeyCredential.prototype);
        const idStr = b64url(idBytes);
        Object.defineProperties(cred, {
            id:                      { value: idStr, enumerable: true },
            rawId:                   { value: buf(idBytes), enumerable: true },
            type:                    { value: 'public-key', enumerable: true },
            response:                { value: resp, enumerable: true },
            authenticatorAttachment: { value: 'platform', enumerable: true },
            getClientExtensionResults: { value: () => extensions },
            toJSON: { value: () => {
                const r = { clientDataJSON: b64url(resp.clientDataJSON) };
                if (kind === 'create') {
                    r.attestationObject = b64url(resp.attestationObject);
                    r.authenticatorData = b64url(resp.getAuthenticatorData());
                    r.transports = resp.getTransports();
                    r.publicKeyAlgorithm = resp.getPublicKeyAlgorithm();
                    const pk = resp.getPublicKey();
                    if (pk) r.publicKey = b64url(pk);
                } else {
                    r.authenticatorData = b64url(resp.authenticatorData);
                    r.signature = b64url(resp.signature);
                    r.userHandle = resp.userHandle ? b64url(resp.userHandle) : null;
                }
                return { id: idStr, rawId: idStr, type: 'public-key', authenticatorAttachment: 'platform',
                         clientExtensionResults: extensions, response: r };
            } },
        });
        return cred;
    }

    // Öffentlicher Schlüssel (SPKI, DER) aus den Authenticator-Daten des Servers:
    // hinter Kopf (37) + AAGUID (16) + Längenfeld (2) + Credential-ID folgt der
    // COSE-Schlüssel mit fester Struktur (P-256: x ab Byte 10, y ab Byte 45).
    const SPKI_PREFIX = fromB64url('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE');
    function publicKeyFromAuthData(authData) {
        const a = toBytes(authData);
        if (a.length < 55) return null;
        const credLen = (a[53] << 8) | a[54];
        const cose = a.subarray(55 + credLen);
        if (cose.length !== 77) return null;
        const out = new Uint8Array(SPKI_PREFIX.length + 64);
        out.set(SPKI_PREFIX, 0);
        out.set(cose.subarray(10, 42), SPKI_PREFIX.length);
        out.set(cose.subarray(45, 77), SPKI_PREFIX.length + 32);
        return buf(out);
    }

    // ── create ─────────────────────────────────────────────────────────────
    navigator.credentials.create = async function (options) {
        const pk = options && options.publicKey;
        if (!pk || !pk.rp || !pk.user) return nativeCreate(options);

        const algs = (pk.pubKeyCredParams || []).map(p => Number(p.alg));
        const rpId = pk.rp.id || location.hostname;
        if ((algs.length && !algs.includes(-7)) || pk.attestation === 'enterprise' || !rpIdAllowed(rpId)) {
            return nativeCreate(options);
        }

        const res = await request('create', {
            rpId, rpName: pk.rp.name || '',
            userHandle: b64url(pk.user.id), userName: pk.user.name || '', userDisplay: pk.user.displayName || '',
            excludeCredentials: (pk.excludeCredentials || []).map(c => b64url(c.id)),
        }, options.signal);
        if (res.fallback) return nativeCreate(options);
        if (!res.ok) throw domError(res);

        const authData = fromB64url(res.authData);
        const response = {
            clientDataJSON:    buf(clientData('webauthn.create', pk.challenge)),
            attestationObject: buf(fromB64url(res.attestationObject)),
            getTransports:          () => ['internal', 'hybrid'],
            getAuthenticatorData:   () => buf(authData),
            getPublicKey:           () => publicKeyFromAuthData(authData),
            getPublicKeyAlgorithm:  () => -7,
        };
        return credential(fromB64url(res.credentialId), response, AuthenticatorAttestationResponse.prototype,
            { credProps: { rk: true } }, 'create');
    };

    // ── get ────────────────────────────────────────────────────────────────
    navigator.credentials.get = async function (options) {
        const pk = options && options.publicKey;
        if (!pk) return nativeGet(options);

        const rpId = pk.rpId || location.hostname;
        if (!rpIdAllowed(rpId)) return nativeGet(options);

        const cdj  = clientData('webauthn.get', pk.challenge);
        const hash = await sha256(cdj);
        const res = await request('get', {
            rpId,
            allowCredentials: (pk.allowCredentials || []).map(c => b64url(c.id)),
            clientDataHash: b64url(hash),
            mediation: options.mediation || 'optional',
        }, options.signal);
        if (res.fallback) return nativeGet(options);
        if (!res.ok) throw domError(res);

        const response = {
            clientDataJSON:    buf(cdj),
            authenticatorData: buf(fromB64url(res.authenticatorData)),
            signature:         buf(fromB64url(res.signature)),
            userHandle:        res.userHandle ? buf(fromB64url(res.userHandle)) : null,
        };
        return credential(fromB64url(res.credentialId), response, AuthenticatorAssertionResponse.prototype, {}, 'get');
    };

    // Der Tresor ist ein plattformähnlicher Authenticator mit Nutzerprüfung
    // (Tresor-Entsperrung) und unterstützt die Autofill-Variante.
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(true);
})();
