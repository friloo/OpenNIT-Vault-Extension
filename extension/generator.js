'use strict';

/*
 * OpenNIT Vault – Passwortgenerator (gemeinsam für Popup und Seite)
 *
 * Gleichverteilte Zufallszeichen aus Sätzen ohne optisch verwechselbare
 * Zeichen (l/I/1, O/0); je Satz ist mindestens ein Zeichen enthalten.
 */
var VaultGen = (function () {
    const SETS = [
        'abcdefghijkmnopqrstuvwxyz',
        'ABCDEFGHJKLMNPQRSTUVWXYZ',
        '23456789',
    ];
    const SYMBOLS = '!@#$%^&*()-_=+[]{}';

    // Gleichverteilte Zufallszahl aus [0, max) – verwirft die Werte des obersten,
    // unvollständigen Blocks, damit kein Rest-Modulo einzelne Zeichen bevorzugt.
    function randomBelow(max) {
        const limit = Math.floor(0x100000000 / max) * max;
        const buf = new Uint32Array(1);
        do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
        return buf[0] % max;
    }

    /**
     * @param {number}  len     Länge (mindestens 8)
     * @param {boolean} symbols Sonderzeichen einschließen
     * @return {string}
     */
    function generate(len, symbols) {
        len = Math.max(8, Math.min(128, parseInt(len, 10) || 20));
        const sets = symbols ? SETS.concat(SYMBOLS) : SETS.slice();
        const all  = sets.join('');
        // Je Satz ein Zeichen garantieren, den Rest frei ziehen …
        const out = sets.map(s => s[randomBelow(s.length)]);
        while (out.length < len) out.push(all[randomBelow(all.length)]);
        // … und danach mischen, damit die garantierten Zeichen nicht vorne stehen.
        for (let i = out.length - 1; i > 0; i--) {
            const j = randomBelow(i + 1);
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out.join('');
    }

    return { randomBelow, generate, DEFAULT_LENGTH: 20 };
})();
// In allen Kontexten (Seite, Popup, Worker) als globales Objekt erreichbar.
if (typeof self !== 'undefined') self.VaultGen = VaultGen;
