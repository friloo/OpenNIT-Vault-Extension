# Installation & Einrichtung

## Voraussetzungen

- Eine erreichbare **OpenNIT-Instanz** mit aktiviertem Modul **Passwort-Tresor**.
- Ein Chromium-basierter Browser (Chrome, Edge, Brave, Vivaldi …).

## 1. Erweiterung laden

### A) Entpackt aus dem Quellcode (Entwicklung / self-hosted)

1. `chrome://extensions` öffnen.
2. Oben rechts **Entwicklermodus** einschalten.
3. **„Entpackte Erweiterung laden"** klicken und den Ordner **`extension/`** auswählen.
4. Die Erweiterung erscheint in der Liste; per Puzzle-Symbol an die Toolbar anheften.

### B) Aus dem Chrome Web Store (empfohlen)

[**OpenNIT Vault im Chrome Web Store**](https://chromewebstore.google.com/detail/opennit-vault/fpiehdghpckoggcbhlojajhjhihommob)
öffnen und **„Hinzufügen"** klicken. Updates kommen automatisch über den Store. Das OpenNIT-Backend
verweist unter **Administration → Vault-Erweiterung** auf denselben Eintrag.

## 2. Anmelden

**Empfohlen – SSO:** In den Erweiterungs-Einstellungen die **Server-URL** eintragen und auf
**„Mit OpenNIT anmelden"** klicken. Es öffnet sich die gewohnte OpenNIT-Anmeldung (lokal + 2FA /
Microsoft 365 / Keycloak). Nach erfolgreicher Anmeldung und Zustimmung ist die Erweiterung verbunden –
der Zugang wird automatisch erneuert. Über **„Abmelden"** wird die Sitzung serverseitig widerrufen.

> Voraussetzung: Der Betreiber muss ggf. die Redirect-URI der Erweiterung hinterlegen
> (Backend → Administration → **Vault-Erweiterung**). `*.chromiumapp.org` ist standardmäßig erlaubt.

## 3. Erweiterung konfigurieren

1. Auf das OpenNIT-Vault-Symbol klicken → Zahnrad **Einstellungen** (oder `chrome://extensions` →
   Details → Erweiterungsoptionen).
2. **Server-URL** eintragen (z. B. `https://vault.firma.de`, ohne `/` am Ende).
3. **„Mit OpenNIT anmelden"** klicken und die Anmeldung bestätigen.
4. Danach zeigt die Erweiterung „Verbunden als …" an.

## 4. Optional: PIN-Sperre

1. In OpenNIT unter **Tresor-PIN** einen PIN festlegen (falls noch nicht geschehen).
2. In den Erweiterungs-Einstellungen unter **Sicherheit** eine **Sperrdauer** wählen
   (5 Min / 15 Min / 1 Std / bis der Browser geschlossen wird).
3. Ab jetzt verlangt die Erweiterung nach Ablauf den **Tresor-PIN**, bevor Zugangsdaten sichtbar werden.

## 5. Nutzung

- **Autofill:** Login-Feld auf einer Website anklicken → Vorschläge erscheinen → Eintrag wählen.
- **Popup:** Symbol anklicken → suchen → Eintrag anklicken für Details (Anzeigen/Kopieren, 2FA,
  „Auf dieser Seite ausfüllen").
- **Neu anlegen:** im Popup auf **+** → Felder ausfüllen, Passwort per Generator erzeugen → Speichern.

## Fehlerbehebung

| Problem | Ursache / Lösung |
|--------|------------------|
| „Nicht verbunden" | Server-URL prüfen (endet ohne `/`?); ggf. über **„Mit OpenNIT anmelden"** neu verbinden. Ist die Instanz erreichbar (HTTPS/Zertifikat)? |
| Keine Vorschläge auf einer Seite | Ist der Tresor per PIN gesperrt? Passt eine hinterlegte URL zur Domain? Seite neu laden. |
| „Seite nicht bereit" beim Ausfüllen | Seite einmal neu laden, damit das Content-Script aktiv ist. |
| Favicons fehlen | Werden serverseitig per Cron nachgeladen; erscheinen nach dem ersten Durchlauf. |
