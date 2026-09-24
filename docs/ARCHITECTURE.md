# Architektur

## Überblick

Die Erweiterung ist ein **Manifest-V3-Client** ohne eigenen Server. Sie besteht aus vier Kontexten, die
über `chrome.runtime`-Nachrichten kommunizieren:

```
┌───────────────┐   Messages    ┌──────────────────────┐   HTTPS/Bearer   ┌──────────────────┐
│  popup.html   │ ───────────▶  │  background.js       │ ───────────────▶ │  OpenNIT-Server  │
│  popup.js     │ ◀───────────  │  (Service Worker)    │ ◀─────────────── │  /api/vault/...  │
└───────────────┘               │  - Cache (5 Min)     │                  └──────────────────┘
┌───────────────┐   Messages    │  - Lock-Gate         │
│  content.js   │ ───────────▶  │  - Favicon-Cache     │
│ (jede Seite)  │ ◀───────────  │  - Clipboard-Timer   │
└───────────────┘               └──────────┬───────────┘
                                           │ CLIP_WRITE
                                  ┌────────▼─────────┐
                                  │  offscreen.html  │  (Zwischenablage schreiben/leeren)
                                  └──────────────────┘
```

## Komponenten

| Datei | Rolle |
|-------|-------|
| `background.js` | Zentrale Logik: API-Aufrufe, 5-Minuten-Cache, **Lock-Gate**, Favicon-Cache (Data-URLs), Zwischenablage-Timer. Alle Secrets fließen hier durch. |
| `content.js` | Wird auf jeder Seite ausgeführt. Erkennt Benutzer-/Passwort-/OTP-Felder (inkl. Shadow-DOM, mehrstufige Logins, segmentierte OTP-Felder), zeigt das Vorschlags-Dropdown und füllt Felder framework-kompatibel (React/Vue/Angular). |
| `popup.html` / `popup.js` | Toolbar-Popup: Liste, Suche, Detailansicht, Anlegen + Generator, PIN-Schirm. |
| `options.html` / `options.js` | Einstellungen: Server-URL, SSO-Anmeldung, PIN-Sperrdauer, Zwischenablage. |
| `offscreen.html` / `offscreen.js` | Minimaldokument, das ausschließlich die Zwischenablage beschreibt bzw. leert (MV3-konform). |
| `urlmatch.js` | Gemeinsame Zuordnung Eintrag ↔ Seite (`VaultUrl`), geladen in allen drei Kontexten – damit Vorschlagsliste und Sicherheitswarnung dieselbe Regel anwenden. |

## Nachrichten (Auszug)

| Typ | Von → Nach | Zweck |
|-----|-----------|-------|
| `CHECK_STATUS` | popup/content → bg | Token prüfen, App-Name/User, `pin_enabled` |
| `GET_LOCK` / `DO_UNLOCK` / `LOCK_NOW` | popup → bg | PIN-Sperre abfragen/entsperren/sperren |
| `GET_ENTRIES` / `GET_MATCHING_ENTRIES` | popup/content → bg | Einträge (alle / passend zur URL) |
| `GET_PASSWORD` / `GET_TOTP` | popup/content → bg | Secret **on demand** |
| `CREATE_ENTRY` / `UPDATE_ENTRY` / `DELETE_ENTRY` | popup → bg | Eintrag anlegen / ändern / löschen |
| `SET_PENDING_FILL` / `TAKE_PENDING_FILL` | content → bg | Passwort für den zweiten Login-Schritt hinterlegen bzw. abholen (nur im Speicher, je Tab) |
| `GET_FAVICON` | popup/content → bg | Favicon als Data-URL (serverseitig gecacht) |
| `VAULT_FILL` | popup → content | Aktives Tab-Formular ausfüllen |
| `SCHEDULE_CLIP_CLEAR` | popup/content → bg | Zwischenablage-Leerung planen |
| `CLIP_WRITE` | content → bg | In die Zwischenablage schreiben, wenn die Seite selbst keinen Zugriff bekommt |

## Server-API (in OpenNIT)

Alle Endpunkte unter `/api/vault/extension/` mit `Authorization: Bearer <token>`:

- `GET  /entries` – Liste (Titel, Benutzer, URL, Notizen, `has_totp`, `favicon_domain`, `has_favicon`, `can_write`)
- `GET  /entries/{id}/password` – Passwort (protokolliert im Audit-Log)
- `GET  /entries/{id}/totp` – aktueller TOTP-Code + Restsekunden
- `GET  /entries/{id}/favicon?fetch=1` – gecachtes Favicon (bei Bedarf serverseitig geholt)
- `POST /entries` – neuen Eintrag anlegen (optional `totp`: Base32 oder `otpauth://`-Link)
- `POST /entries/{id}` – Eintrag ändern (leeres Passwortfeld = unverändert; `totp` setzt ein neues
  2FA-Secret, `totp_clear=1` entfernt es, ohne beides bleibt es erhalten; Ordner und Ablaufdatum bleiben)
- `POST /entries/{id}/delete` – Eintrag löschen
- `GET  /status` – Token gültig? + `pin_enabled` / `pin_lock_secs`
- `POST /unlock` – Tresor-PIN verifizieren + serverseitiges Entsperr-Fenster für den Token setzen
- `POST /lock` – Token sofort wieder sperren (Entsperr-Fenster zurücksetzen)
- `GET  /oauth/authorize` · `POST /oauth/authorize` – SSO-Anmeldung/Zustimmung (Session, PKCE)
- `POST /oauth/token` – Authorization-Code- bzw. Refresh-Grant (öffentlich, PKCE) → Access/Refresh
- `POST /oauth/revoke` – Refresh-Kette widerrufen (Logout)

Details zum SSO-Flow: [`SSO-PLAN.md`](SSO-PLAN.md). Die Erweiterung nutzt SSO über `chrome.identity`;
Access-Tokens werden im Hintergrund still per Refresh (mit Rotation) erneuert.

## Lock-Gate (serverseitig erzwungen)

Ist für den Nutzer ein **Tresor-PIN** aktiv, liefern die Server-Endpunkte für Einträge/Passwort/TOTP
erst nach frischer PIN-Entsperrung Daten (`unlocked_until` pro Token) und antworten sonst mit **HTTP 423**.
Der Client spiegelt den Zustand nur (PIN-Schirm) – die eigentliche Durchsetzung liegt im Server, damit ein
**gestohlener Token allein wertlos** ist. Der Client hält seinen Entsperr-Status zusätzlich in
`chrome.storage.session` (verfällt beim Schließen des Browsers). Die Einstellung „PIN-Sperre" legt nur die
Fensterdauer fest; „Bis der Browser geschlossen wird" nutzt ein langes Serverfenster + Client-Sitzungsende.

## Sicherheitsprinzipien

- **Kein Remote-Code** – alle Skripte im Paket (MV3-CSP-konform, keine Inline-Skripte).
- **Secrets on demand** – Passwörter/TOTP erst bei Nutzung, nie in der Liste.
- **Kein persistentes Secret** – nur URL, Sitzungstoken, Einstellungen in `chrome.storage`. Das Passwort
  für einen mehrstufigen Login liegt ausschließlich im Speicher des Service Workers (je Tab, 30 s),
  nie in `chrome.storage`, das auf die Festplatte geschrieben würde.
- **Server-seitige Krypto** – Ver-/Entschlüsselung im OpenNIT-Server, nicht im Browser.
