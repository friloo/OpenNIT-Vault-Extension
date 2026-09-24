# Berechtigungen – Begründung

Diese Übersicht erklärt jede angeforderte Berechtigung (auch für die Chrome-Web-Store-Prüfung).

## `host_permissions: ["<all_urls>"]`

**Warum:** Ein Passwort-Manager muss Login-Felder auf **beliebigen** Websites erkennen und auf Wunsch
ausfüllen können. Deshalb ist Zugriff auf alle URLs erforderlich.

**Was NICHT passiert:** Es werden keine Seiteninhalte gelesen, gespeichert oder übertragen – ausschließlich
Formularfelder (Benutzer/Passwort/OTP) werden erkannt und beim Ausfüllen beschrieben. Diese verlassen den
Browser nicht. Es findet kein Tracking und keine Analyse statt.

## `content_scripts` (matches `<all_urls>`)

**Warum:** Das In-Seite-Dropdown mit Vorschlägen und die Felderkennung laufen als Content-Script
(`content.js`, `run_at: document_idle`). Notwendig für Autofill und die 2FA-Erkennung (inkl. Shadow-DOM
und mehrstufiger Logins). Dasselbe Skript zeigt nach dem Absenden einer Anmeldung den Hinweis
„Passwort speichern / aktualisieren?".

**Passkeys:** Zwei weitere Skripte laufen ab `document_start`, damit sie vor dem ersten WebAuthn-Aufruf
der Seite bereitstehen: `passkey-page.js` im Kontext der Seite (`world: MAIN`) überschreibt
`navigator.credentials.create/get` und sieht ausschließlich öffentliche Daten und Signaturen;
`passkey-bridge.js` (isolierte Welt) prüft die Relying Party gegen die Seitenadresse, spricht mit dem
Hintergrund-Worker und zeigt die Auswahl. Beides braucht keine zusätzliche Berechtigung.

## `commands` (Tastenkürzel)

Ein Kürzel „Anmeldung ausfüllen" (Standard Strg + Umschalt + L). Keine Berechtigung im Sinne des Stores;
der Nutzer kann es unter `chrome://extensions/shortcuts` ändern oder entfernen.

## `storage`

**Warum:** Lokale Speicherung von Server-URL, Zugriffstoken (per SSO) und Einstellungen; Entsperr-Status in
`storage.session`.

## `alarms`

**Warum:** Zeitgesteuertes Leeren der Zwischenablage (~30 s) sowie periodisches Verwerfen des
Einträge-Caches (5 Min).

## `offscreen`

**Warum:** In Manifest V3 hat der Service Worker keinen DOM-Zugriff. Zum programmatischen Leeren der
Zwischenablage wird ein kurzlebiges Offscreen-Dokument (Reason `CLIPBOARD`) genutzt – sowohl zum
Bereitlegen eines 2FA-Codes als auch zum anschließenden Leeren.

## `identity`

**Warum:** Für die **SSO-Anmeldung** (`chrome.identity.launchWebAuthFlow`, OAuth 2.0 + PKCE). Öffnet die
OpenNIT-Login-Seite und empfängt die Weiterleitung an `https://<extension-id>.chromiumapp.org/`. Es wird
**kein** Zugriff auf Google-Konten o. Ä. genommen – nur der Web-Auth-Flow zur konfigurierten OpenNIT-Instanz.

## Bewusst NICHT angefordert

- **`scripting` / `activeTab`** – nicht nötig: Das Content-Script wird über `content_scripts` geladen,
  das Ausfüllen aus dem Popup läuft über eine Nachricht an das bereits laufende Script. Der Zugriff auf
  den aktiven Tab ist bereits durch `host_permissions` abgedeckt.

- **`tabs`** – entfällt: Die aktive Tab-Adresse ist bereits über `host_permissions` verfügbar. Dadurch
  erscheint **keine** „Browserverlauf lesen"-Warnung.
- Keine `cookies`, `history`, `webRequest`, `downloads`, `notifications` o. Ä.

## Single-Purpose-Erklärung (für den Store)

> OpenNIT Vault dient einem einzigen Zweck: dem Verwalten und automatischen Ausfüllen von Zugangsdaten
> und 2FA-Codes aus einer selbst gehosteten OpenNIT-Instanz. Alle Berechtigungen dienen ausschließlich
> diesem Zweck.
