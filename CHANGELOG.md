# Changelog – OpenNIT Vault (Browser-Erweiterung)

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/).
Die Erweiterungsversion (`manifest.json`) ist unabhängig von der OpenNIT-Serverversion.

## [Unreleased]

### Hinzugefügt
- **Passkeys aus dem Tresor:** Fragt eine Webseite nach einem Passkey, bietet die Erweiterung die im
  OpenNIT-Tresor gespeicherten Passkeys für diese Seite an – als Dialog oder, bei der Autofill-Variante,
  direkt in der Vorschlagsliste am Benutzerfeld. Beim Registrieren eines neuen Passkeys fragt sie, ob er
  im Tresor (an einem bestehenden oder neuen Eintrag, persönlich oder im Team) abgelegt werden soll.
  „Browser verwenden" bleibt in jedem Dialog als Ausweg für die Passkeys des Browsers selbst. Der private
  Schlüssel verlässt den Server nie; die Erweiterung reicht nur Signaturen weiter. In der Detailansicht
  sind die Passkeys eines Eintrags sichtbar und löschbar. Benötigt Chrome 111 und Server-Schnittstelle 2.
- **„Passwort speichern?" und „Passwort aktualisieren?":** Nach dem Absenden einer Anmeldung, für die
  kein Eintrag existiert, erscheint oben rechts ein Hinweis mit Zielauswahl (persönlich, Ordner, Team).
  Wurde für einen bekannten Eintrag ein anderes Passwort verwendet, bietet die Erweiterung das
  Aktualisieren an – der Vergleich läuft auf dem Server, ohne dass das gespeicherte Passwort die
  Instanz verlässt. „Nie für diese Seite" merkt sich die Domain. Das erfasste Passwort liegt bis zur
  Entscheidung nur im Arbeitsspeicher der Erweiterung und verfällt nach 90 Sekunden.
- **Ziel beim Anlegen:** Neue Einträge lassen sich in einem Ordner oder in einem Team mit Schreibrecht
  anlegen; bisher landeten sie immer im persönlichen Tresor. Beim Bearbeiten lässt sich der Ordner
  innerhalb des bestehenden Tresors wechseln.
- **Zusatzfelder und Ablaufdatum:** Die Detailansicht zeigt das Ablaufdatum eines Eintrags (mit Hinweis
  ab 14 Tagen vorher) und lädt Zusatzfelder auf Abruf – geheime Felder maskiert, mit Anzeigen und
  Kopieren; der Abruf geheimer Felder steht im Audit-Log.
- **Passwort-Gesundheit:** Schwache und mehrfach verwendete Passwörter sind in Liste und Detailansicht
  markiert. Die Bewertung liefert der Server; Passwörter werden dafür nicht übertragen.
- **Tastenkürzel:** Strg + Umschalt + L (Mac: ⌘ + Umschalt + L) füllt die Anmeldung aus, wenn genau ein
  Eintrag zur Seite passt; sonst öffnet sich das Popup. Änderbar unter chrome://extensions/shortcuts.
- **Server-Stand sichtbar:** Die Einstellungen zeigen, ob der Server die Schnittstelle in der nötigen
  Fassung anbietet, und welche Funktionen sonst verborgen bleiben. Ein 2FA-Secret, das ein älterer
  Server verwirft, meldet die Erweiterung nach dem Speichern statt zu schweigen.

### Behoben
- **Mehrere Adressen je Eintrag bleiben erhalten:** Das Adressfeld beim Anlegen und Bearbeiten war ein
  einzeiliges URL-Feld; der Browser entfernte daraus die Zeilenumbrüche, sodass ein Eintrag mit mehreren
  Adressen beim Speichern zu einer zusammengeklebten Adresse wurde. Das Feld ist jetzt mehrzeilig
  (eine Adresse je Zeile), und der Server nimmt die Zeilen so an, wie der Web-Tresor sie speichert.

## [2.6.0] - 2026-09-24

### Hinzugefügt
- **2FA-Secret in der Erweiterung hinterlegen:** Beim Anlegen und Bearbeiten eines Eintrags gibt es
  ein Feld für das TOTP-Secret. Angenommen wird das Base32-Secret oder der `otpauth://`-Link, den ein
  Dienst als QR-Code zeigt (nur Standard-TOTP: SHA1, 6 Stellen, 30 s). Beim Bearbeiten bleibt ein
  vorhandenes Secret erhalten, solange das Feld leer bleibt; „Hinterlegtes 2FA-Secret entfernen" löscht
  es. Unbrauchbare Eingaben werden mit einer Meldung abgewiesen. Benötigt eine OpenNIT-Version, deren
  Erweiterungs-Schnittstelle das Feld `totp` annimmt.

### Behoben
- **Team-Einträge lassen sich wieder bearbeiten und löschen:** Der Server meldete auch mit Schreibrecht
  im Team „Nur Leserechte für dieses Team", weil er den Team-Schlüssel aus der Web-Sitzung holte, die
  es bei der Anmeldung per Token nicht gibt. Die Korrektur liegt im OpenNIT-Server (Erweiterungs-
  Schnittstelle); die Erweiterung blendet „Bearbeiten" und „Löschen" zusätzlich aus, wenn der Server
  für einen Team-Eintrag nur Leserecht meldet, statt erst beim Speichern zu scheitern.
- **Ablaufdatum bleibt beim Bearbeiten erhalten:** Ein in OpenNIT gesetztes Ablaufdatum ging beim
  Speichern aus der Erweiterung verloren (Korrektur im OpenNIT-Server).

## [2.5.0] - 2026-07-31

### Hinzugefügt
- **Einträge bearbeiten und löschen:** In der Detailansicht gibt es jetzt „Bearbeiten" und „Löschen".
  Beim Bearbeiten bleibt das Passwortfeld leer – wer es leer lässt, behält das gespeicherte Passwort;
  2FA-Secret und Ordner bleiben unangetastet. Für Team-Einträge greift das Schreibrecht des Teams.
- **Passwort-Generator einstellbar:** Länge (12–48) und Sonderzeichen lassen sich beim Anlegen wählen –
  hilfreich bei Seiten, die Sonderzeichen ablehnen.
- **2FA-Code wird für den nächsten Schritt bereitgelegt:** Nach dem Ausfüllen eines Eintrags mit 2FA
  landet beim nächsten 2FA-Feld automatisch ein **frischer** Code in der Zwischenablage – auch dann,
  wenn die Abfrage erst auf einer Folgeseite kommt (z. B. Microsoft-Anmeldung). Einfügen genügt mit
  Strg + V; der bisherige Inhalt der Zwischenablage wird dabei überschrieben und der Code nach 30
  Sekunden wieder entfernt. Abschaltbar unter „Sicherheit → 2FA-Code beim Anmelden bereitlegen".

### Sicherheit
- **Passwort für mehrstufige Logins nicht mehr auf der Festplatte:** Verteilt eine Anmeldung Benutzername
  und Passwort auf zwei Schritte, wurde das Passwort bisher im lokalen Speicher der Erweiterung abgelegt –
  und blieb dort liegen, wenn der zweite Schritt nie erreicht wurde. Es wird jetzt nur noch im Arbeits-
  speicher gehalten, an den jeweiligen Tab gebunden und nach 30 Sekunden bzw. beim Sperren verworfen.
- **Warnung bei fremder Domain greift zuverlässiger:** Ein Eintrag für `vpn.firma.de` galt auf `firma.de`
  fälschlich als passend, sodass die Warnung ausblieb. Zuordnung und Warnung nutzen jetzt dieselbe Regel:
  nur die hinterlegte Adresse selbst und deren Unteradressen gelten als passend.
- **Weniger Berechtigungen:** `scripting` und `activeTab` werden nicht mehr angefordert – beide wurden
  nicht benötigt.
- **Passwort-Generator:** Der Zufall für die Mischreihenfolge wird jetzt getrennt von der Zeichenauswahl
  gezogen, und die Zeichenwahl ist gleichverteilt.
- Notizen werden beim Kopieren wie andere Geheimnisse behandelt und nach 30 Sekunden aus der
  Zwischenablage entfernt.

### Geändert
- **Benutzername immer sichtbar:** Das Auge zum Ausblenden des Benutzernamens in der Detailansicht ist
  entfallen – ein Benutzername ist kein Geheimnis. Das Passwort bleibt weiterhin maskiert.
- **Vorschläge weichen der Seite:** Sobald in ein Feld getippt wird, verschwindet die Vault-Liste –
  darunter erscheint typischerweise die Suche der Seite selbst. Bei Feldern, die erkennbar eine eigene
  Auswahlliste öffnen (etwa Benutzer-Auswahlfelder), erscheinen gar keine Vault-Vorschläge mehr.
  Ausdrücklich als Anmeldefeld ausgezeichnete Felder sind davon ausgenommen.
- **Anmeldung nur noch per SSO:** Das Feld für den manuell erzeugten API-Token samt „Verbindung testen"
  ist aus den Einstellungen entfernt. Die Verbindung entsteht ausschließlich über „Mit OpenNIT anmelden".
  Ein aus einer früheren Version übernommener Token wird beim Update aus dem lokalen Speicher gelöscht;
  wer bisher nur damit verbunden war, meldet sich einmal per SSO an.

### Behoben
- **Restlaufzeit des 2FA-Codes wird wieder korrekt angezeigt:** Der Countdown blieb am Ende eines
  Zeitfensters stehen und lief mit der Zeit aus dem Takt. Er rechnet nun gegen den tatsächlichen
  Ablaufzeitpunkt und holt den neuen Code beim Wechsel genau einmal nach. Lässt sich kein neuer Code
  laden (Tresor gesperrt oder Verbindung weg), zeigt die Anzeige das an, statt auf einem abgelaufenen
  Wert stehen zu bleiben.
- **Neuen Eintrag anlegen funktioniert wieder nach SSO-Anmeldung:** Das Speichern eines im Popup
  erzeugten Passworts brach bisher mit „Nicht konfiguriert." ab, wenn die Erweiterung über
  „Mit OpenNIT anmelden" verbunden war – es wurde ausschließlich der manuelle Token akzeptiert.
  Das Anlegen nutzt nun denselben Zugang wie alle übrigen Aufrufe (inkl. automatischer
  Token-Erneuerung). Ist der Tresor gesperrt, erscheint die PIN-Abfrage statt einer Fehlermeldung.

## [2.4.0] - 2026-07-01

### Hinzugefügt
- **SSO-Anmeldung (OAuth 2.0 + PKCE):** „Mit OpenNIT anmelden" – Anmeldung wie an OpenNIT
  (lokal + 2FA / Microsoft 365 / Keycloak) über `chrome.identity`. Die Erweiterung erhält kurzlebige
  Access-Tokens und einen langlebigen, **rotierenden** Refresh-Token; der Zugang wird automatisch erneuert.
  „Abmelden" widerruft die Sitzung serverseitig.
- Der bisherige **manuelle Token** bleibt als „Erweitert"-Option erhalten (Kiosk/Headless).

### Sicherheit
- Kurzlebige Access-Tokens + Refresh-Token-**Rotation mit Reuse-Detection** (bei Wiederverwendung eines
  bereits rotierten Tokens wird die gesamte Sitzungskette widerrufen).

## [2.3.0] - 2026-07-01

### Sicherheit
- **Token-Härtung:** Bei aktivem Tresor-PIN wird die PIN-Sperre nun **serverseitig erzwungen** – die
  Endpunkte für Einträge/Passwort/TOTP liefern erst nach frischer PIN-Entsperrung Daten. Ein gestohlener
  Token allein ist damit wertlos, solange keine gültige Entsperrung vorliegt (neuer `POST /unlock`
  mit Fensterdauer, `POST /lock` zum sofortigen Sperren).
- **HTTPS-Zwang:** In den Einstellungen werden nur noch `https://`-Adressen akzeptiert (Ausnahme:
  `localhost`) – verhindert Klartext-Übertragung von Token und Passwörtern.
- **Warnung bei fremder Domain:** „Auf dieser Seite ausfüllen" warnt, wenn die aktive Seite nicht zur
  hinterlegten Adresse des Eintrags passt.

### Geändert
- Die Einstellung „PIN-Sperre" legt nur noch die **Dauer** der Entsperrung fest (die Option „Aus" entfällt,
  da die Sperre bei gesetztem Tresor-PIN serverseitig gilt).

## [2.2.2] - 2026-07-01

### Geändert
- Fester Name **„OpenNIT Vault"** (unabhängig vom Instanznamen).
- Berechtigung **`tabs` entfernt** – die aktive Tab-Adresse ist bereits durch die Website-Berechtigungen
  abgedeckt; die Warnung „Browserverlauf lesen" entfällt.

## [2.2.0] - 2026-07-01

### Hinzugefügt
- **PIN-Sperre** mit demselben PIN wie der Web-Tresor, konfigurierbare Sperrdauer (5 Min / 15 Min /
  1 Std / bis der Browser geschlossen wird).
- **Passwort-Generator** und Anzeigen-Auge beim Anlegen.
- **Notizen** in der Detailansicht (anzeigen/kopieren) und in der Suche.
- **Zwischenablage-Auto-Clear** nach dem Kopieren (abschaltbar).
- **Tastatur-Navigation** in der Liste und **Dark Mode**.

## [2.1.0] - 2026-06-30

### Hinzugefügt
- **Detailansicht** je Eintrag mit Anzeigen/Kopieren von Benutzername und Passwort sowie 2FA-Code.
- **Favicons** der hinterlegten Seiten (serverseitig gecacht).

### Behoben
- Klick auf einen Eintrag öffnet nun die Detailansicht.
- Vorschlags-Dropdown an das Design der Erweiterung angeglichen.

## [2.0.0]

### Hinzugefügt
- Erstveröffentlichung: Autofill für Benutzer-, Passwort- und 2FA-Felder, Popup mit Liste/Suche,
  Anlegen neuer Einträge, Einstellungen für Server-URL und Token.
