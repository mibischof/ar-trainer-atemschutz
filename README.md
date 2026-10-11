# AR-Trainer Atemschutz (PWA-Mockup)

Web-App für Atemschutz-Kaltübungen mit dem Smartphone. Die Kamera zeigt den echten Raum, die App legt Rauch, Dunkelheit, Feuer und vermisste Personen darüber. Feuer und Personen werden über ausgedruckte Marker am Boden platziert. Das Handy kann in der Hand gehalten oder in eine Brille bzw. einen Masken-Adapter gesteckt werden.

Es ist ein **Mockup** zum Ausprobieren und Herzeigen. Die spätere Unity-App soll die Feuer fest im Raum verankern (ARCore/ARKit). Das kann der Browser nicht.

## Was das Mockup kann

- **Kamerabild mit Rauchschicht:** Rauch ab einer einstellbaren Höhe über dem Boden, dazu Dunkelheit und leichter Rauch im ganzen Raum. Wer sich duckt, sieht unter dem Rauch mehr.
- **Feuer auf Markern:** Flammen, Rauchsäule und Feuerschein im Rauch. Die Feuer wachsen, wenn niemand löscht.
- **Vermisste Personen auf Markern.** Eine Person gilt als gefunden, sobald man näher als ca. 1,5 m herankommt.
- **Löschen mit Fernbedienung:** Taste halten heißt Wasser marsch. Das Feuer wird kleiner, wenn der Strahl darauf zielt. Der Wasserverbrauch wird mitgezählt.
- **Heiße Rauchgase und Durchzündung:** Bei zu viel Hitze rollen Flammen durch die Rauchschicht, am Ende kommt die Durchzündung. Kurze Stöße nach oben kühlen die Rauchgase.
- **„Sicht frei“:** schaltet sofort alle Effekte aus und zeigt das echte Kamerabild mit grünem Rand.
- **Drei Darstellungen:** in der Hand, Brille mit 1 großer Linse, Brille mit 2 Linsen (Cardboard). Für die Brillen wird das Bild vorverzerrt; Linsenabstand und Korrektur sind einstellbar.
- **Auswertung** nach der Übung: Dauer, gelöschte Feuer, gefundene Personen, Wasser in Litern, kurze und lange Stöße, höchste Rauchgas-Hitze, Ablauf mit Uhrzeit.
- **Offline-fähig:** Nach dem ersten Öffnen funktioniert die App ohne Internet und lässt sich zum Startbildschirm hinzufügen.

## App öffnen

**<https://mibischof.github.io/ar-trainer-atemschutz/>**

Am Handy im Browser öffnen (Chrome auf Android, Safari auf dem iPhone). Über das Browser-Menü „Zum Startbildschirm hinzufügen“ läuft die App im Vollbild und auch ohne Internet.

Der Browser gibt die Kamera nur über **HTTPS** frei. Das Repository ist eine statische Website ohne Server-Code und wird über GitHub Pages (Branch `main`, Ordner `/`) ausgeliefert. Es kann genauso auf jeden anderen HTTPS-Webspace kopiert werden.

**Am PC testen:** im Ordner `python3 -m http.server 8000` starten und <http://localhost:8000> öffnen. `localhost` gilt als sicher, die Webcam funktioniert. Ohne Lagesensor wird der Blick mit der Maus gezogen.

## Übung vorbereiten

1. Marker drucken: [`marker/AR-Trainer-Marker-A4.pdf`](marker/AR-Trainer-Marker-A4.pdf), oder in der App auf „Marker drucken“ tippen. Auf A4 mit **100 % Größe** drucken. Das schwarze Quadrat ist 15 cm groß.
2. Marker **flach auf den Boden** legen: Feuer 1–4 sind Brandstellen, Person 1–2 sind vermisste Personen.
3. **Licht anlassen.** Die App macht die Dunkelheit selbst; im echten Dunkeln findet die Kamera die Marker nicht.
4. In der App Szenario und Darstellung wählen, „Übung starten“ tippen, Kamera und Bewegungssensor erlauben.

Ohne Drucker: Auf der Marker-Seite „Am Bildschirm zeigen“ wählen, z. B. am Tablet. Dann die Kantenlänge am Bildschirm messen und unter Einstellungen → Markergröße eintragen.

## Bedienung

| Aktion | Fernbedienung / Tastatur | Gamecontroller | Touch |
|---|---|---|---|
| Wasser marsch (halten) | Enter, Leertaste, Pfeil rechts/unten, Bild ab | A, R1, R2 | Taste „Wasser“ (Hand-Ansicht) |
| Sicht frei ein/aus | Pfeil links/oben, Bild auf, Rücktaste | B | Taste „Sicht frei“ |
| Pause-Menü | Esc | Start | Tippen auf den Bildschirm (Brillen-Ansicht) |

Geeignet sind Bluetooth-Seitenumblätterer (für Tablets/Noten) und kleine Bluetooth-Gamecontroller. Selfie-Auslöser senden oft nur „Lauter“; das können Web-Apps nicht zuverlässig auslesen.

## Brille einstellen

1. Darstellung „1 Linse“ oder „2 Linsen“ wählen und unter Einstellungen das **Testgitter** einschalten.
2. Handy in die Brille stecken und schauen: Die Gitterlinien sollen gerade wirken. Wenn sie sich nach außen wölben, die **Linsenkorrektur** verringern; wenn nach innen, erhöhen.
3. Bei 2 Linsen den **Linsenabstand** so einstellen, dass beide Bilder zu einem verschmelzen.
4. **Bildgröße** so wählen, dass das Bild das Sichtfeld füllt, ohne dass die Ränder abgeschnitten werden.

Wenn Feuer beim Drehen des Kopfes „nachschwimmen“, die **Sensor-Verzögerung** anpassen (typisch 40–100 ms). Wenn Entfernungen nicht stimmen, das **Kamera-Sichtfeld** anpassen (typisch 60–75°).

## Grenzen des Mockups

- Keine echte Raumverfolgung: Feuer sitzen genau auf dem Marker, solange er im Bild ist. Danach hält sie der Lagesensor nur in der Richtung fest, nicht beim Gehen.
- Die Augenhöhe (stehen/kriechen) wird nur geschätzt, wenn ein Marker am Boden im Bild ist. Sonst gilt der eingestellte Wert.
- Rauch kennt die echten Wände nicht. Es wird ein Raum mit einstellbarer Tiefe und Höhe angenommen.
- Auf schwachen Geräten ruckelt es eher; dann „Grafikqualität: Niedrig“ wählen.
- **Nur für Kaltübungen.** Ein Ausbilder bleibt immer beim Trupp.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html`, `styles.css` | Oberfläche: Start, Einstellungen, Pause, Auswertung |
| `app.js` | Ablauf, Kamera, Eingabe, Hauptschleife |
| `render.js` | Grafik mit three.js: Rauch, Feuer, Personen, Wasser, Linsen-Vorverzerrung |
| `scenario.js` | Übungslogik: Feuer, Personen, Hitze, Wasser, Protokoll |
| `tracker.js`, `tracker-worker.js` | Marker-Erkennung im Hintergrund-Thread |
| `sensors.js` | Kopfausrichtung aus dem Lagesensor |
| `hud.js`, `audio.js` | Einblendungen und erzeugte Geräusche |
| `settings.js`, `markers.js` | Einstellungen, Szenarien, Marker-Liste |
| `marker.html`, `marker/` | Marker zum Drucken |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline-Fähigkeit und Installation als App |
| `vendor/` | three.js r170 (MIT), js-aruco2 2.0.0 (MIT) |
