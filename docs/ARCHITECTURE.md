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
| `passkey-page.js` | Läuft **im Kontext der Webseite** (`world: MAIN`, `document_start`): überschreibt `navigator.credentials.create/get` für Public-Key-Credentials und reicht Anfragen per `postMessage` an die Brücke. Sieht nie Schlüsselmaterial, nur Signaturen und öffentliche Daten. |
| `passkey-bridge.js` | Isolierte Welt, `document_start`: prüft die Relying Party gegen die Seitenadresse, holt Passkeys vom Worker, zeigt Auswahl-/Speichern-Dialog (Shadow DOM) und beantwortet das Seitenskript. Für die Autofill-Variante (`mediation: conditional`) stellt es die Passkeys der Vorschlagsliste in `content.js` bereit. |

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
| `GET_API_VERSION` / `GET_TARGETS` / `GET_HEALTH` | popup/content → bg | Serverstand; Ziele (Ordner/Teams); Passwort-Gesundheit (5 Min gecacht) |
| `GET_FIELDS` / `GET_ENTRY_PASSKEYS` | popup → bg | Zusatzfelder bzw. Passkeys eines Eintrags **on demand** |
| `PASSKEYS_FOR_RP` / `PASSKEY_CREATE` / `PASSKEY_ASSERT` / `PASSKEY_DELETE` | bridge/popup → bg | Passkeys je Relying Party; anlegen; Anmeldung signieren lassen (nur `clientDataHash` geht zum Server); löschen |
| `SET_PENDING_CAPTURE` / `TAKE_PENDING_CAPTURE` / `CAPTURE_DECISION` | content → bg | Beim Anmelden erfasste Zugangsdaten hinterlegen (nur im Speicher, je Tab, 90 s), bewerten lassen (speichern/aktualisieren/nichts), Entscheidung ausführen |

## Server-API (in OpenNIT)

Alle Endpunkte unter `/api/vault/extension/` mit `Authorization: Bearer <token>`:

- `GET  /status` – zusätzlich `api_version` (Stand der Schnittstelle; neue Funktionen ab 2)
- `GET  /entries` – Liste (Titel, Benutzer, URL, Notizen, `has_totp`, `favicon_domain`, `has_favicon`, `can_write`,
  `folder_id`/`folder_name`, `expires_at`, `updated_at`, `field_count`, `passkey_count`)
- `GET  /entries/health` – je Eintrag `weak` / `reused` (serverseitig bewertet, keine Passwörter in der Antwort)
- `GET  /targets` – persönliche Ordner sowie Teams mit Schreibrecht und deren Ordner
- `GET  /entries/{id}/fields` – Zusatzfelder (geheime Felder im Audit-Log)
- `POST /entries/{id}/password/check` – stimmt ein Passwort mit dem gespeicherten überein? (nur `match`, kein Klartext)
- `GET  /passkeys?rp_id=` · `POST /passkeys` · `POST /passkeys/{id}/assert` · `POST /passkeys/{id}/delete` · `GET /entries/{id}/passkeys`
  – Passkeys: Der Server erzeugt das Schlüsselpaar und signiert (`authData || clientDataHash`, ES256, Zähler 0,
  Attestierung `none`); der private Schlüssel bleibt verschlüsselt im Eintragskontext (VMK/TVK)
- `GET  /entries/{id}/password` – Passwort (protokolliert im Audit-Log)
- `GET  /entries/{id}/totp` – aktueller TOTP-Code + Restsekunden
- `GET  /entries/{id}/favicon?fetch=1` – gecachtes Favicon (bei Bedarf serverseitig geholt)
- `POST /entries` – neuen Eintrag anlegen (optional `totp`: Base32 oder `otpauth://`-Link; `team_id`/`folder_id` als Ziel;
  `url` mehrzeilig, eine Adresse je Zeile)
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

## Passkeys

```
Webseite ──navigator.credentials.get()──▶ passkey-page.js (MAIN)
                                              │ postMessage {rpId, allowCredentials, clientDataHash}
                                              ▼
                                        passkey-bridge.js (isoliert) ── prüft rpId gegen location.hostname
                                              │ PASSKEYS_FOR_RP / PASSKEY_ASSERT
                                              ▼
                                        background.js ──Bearer──▶ Server: signiert authData‖clientDataHash
                                              ▼
                                        Seite erhält PublicKeyCredential (authenticatorData, signature, userHandle)
```

Die Relying Party wird **in der isolierten Welt** gegen die echte Seitenadresse geprüft (gleiche Domain oder
übergeordnete), nicht aus der Nachricht der Seite übernommen. Findet sich kein Passkey im Tresor, läuft der
native Browser-Dialog; jeder Dialog bietet „Browser verwenden" an. Registrierung (`create`) legt den Passkey an
einem bestehenden oder neuen Eintrag ab; `excludeCredentials` mit einem Tresor-Passkey ergibt `InvalidStateError`.

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
