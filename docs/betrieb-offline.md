# Betrieb Offline-Instanz (Check-in + Taverne auf dem Con)

Konzept und Ablauf: `docs/superpowers/plans/2026-10-07-p7-offline-modus.md`. Dieses Dokument ist die Betriebsanleitung.

## Hardware-Checkliste
- [ ] Laptop (Docker installiert, Festplattenverschlüsselung an) + **identischer Ersatzlaptop** mit eigener Kopie
- [ ] WLAN-Router **ohne Internet-Zwang**, DHCP-Reservierung (feste IP) für den Laptop
- [ ] DNS-Eintrag `con.local` -> IP des Laptops im Router (mDNS wird von Docker/Android nicht zuverlässig aufgelöst); alternativ Hosts-Eintrag je Gerät
- [ ] Netzteil, USV oder Powerbank (Laptop + Router), Verlängerungskabel
- [ ] USB-Stick (verschlüsselt) für Zwischenexporte/Rückgabepaket
- [ ] 2-3 Scan-Handys mit installierter CA (siehe unten), Ladekabel
- [ ] Ausgedruckte Notfall-Liste (Teilnehmer, Kontostände) als Rückfall
- [ ] Gleiche App-Version wie online (Versionsanzeige unten links in der Sidebar vergleichen)

## Einrichtung des Laptops
1. Repo/Image in der gleichen Version wie online bereitstellen.
2. `.env` neben der Compose-Datei mit mindestens:
   ```
   POSTGRES_PASSWORD=<zufällig>
   ENCRYPTION_KEY=<wie online bzw. eigener Key bei reduziertem Snapshot>
   CON_HOSTNAME=con.local
   ```
3. Starten (immer explizit mit `-f`):
   ```
   docker compose -f docker-compose.offline.yml up -d --build
   ```
4. Importieren: `docker compose -f docker-compose.offline.yml exec app npm run offline:import -- /pfad/zur/datei.qpkg` (Datei vorher per `docker cp` in den Container; Passphrase wird abgefragt).
5. Prüfen: `https://con.local` im Browser, roter Banner „OFFLINE-VERSION – Stand vom …" muss sichtbar sein.

## Ablauf
1. **Erzeugen (online, vorab):** Admin erzeugt die Offline-Version (Passphrase vergeben). Online ist Check-in/Taverne danach gesperrt (Banner „Rückgabe offen"). Datei `*.qpkg` herunterladen.
2. **Import (vor Ort):** wie oben. Eine bereits importierte Offline-Instanz nimmt keinen zweiten Snapshot an. Den Ersatzlaptop vorher aus demselben Paket vorbereiten, aber **nur einen** Laptop produktiv schreiben lassen.
3. **Betrieb:** Handys ins Con-WLAN, `https://con.local` öffnen. Nachts Zwischenexport auf den USB-Stick.
4. **Rückgabe:** Rückgabepaket erzeugen (Offline-Instanz geht auf „retired"), online einspielen oder bei Netz direkt abgleichen. Konflikte im Konfliktmenü lösen. Erst danach ist Online wieder schreibberechtigt.
5. **Aufräumen:** Paket, USB-Stick-Kopien und Docker-Volumes löschen:
   ```
   docker compose -f docker-compose.offline.yml down -v
   ```

## Zertifikat / CA auf Scan-Handys
Die Kamera (QR-Scan) funktioniert nur über HTTPS. Caddy erzeugt mit `tls internal` eine eigene lokale CA. Root-Zertifikat holen:
```
docker compose -f docker-compose.offline.yml cp proxy:/data/caddy/pki/authorities/local/root.crt ./con-root-ca.crt
```
- **Android:** Datei aufs Handy -> Einstellungen -> Sicherheit -> Verschlüsselung & Anmeldedaten -> Zertifikat installieren -> **CA-Zertifikat**. (Chrome vertraut der Nutzer-CA; Firefox ggf. „Drittanbieter-CA verwenden" aktivieren.)
- **iOS:** Datei öffnen -> Profil installieren, danach Einstellungen -> Allgemein -> Info -> Zertifikatsvertrauenseinstellungen -> Root aktivieren.
- Alternative: `mkcert` auf dem Laptop (`mkcert -install`, `mkcert con.local`) und das Zertifikat statt `tls internal` im Caddyfile (`docker/Caddyfile.offline`) eintragen; dann `mkcert -CAROOT/rootCA.pem` auf die Handys.
- Die CA-Datei enthält nur den öffentlichen Teil; den privaten Schlüssel (im Volume `offline-caddy-data`) nie weitergeben. Nach dem Con CA vom Handy entfernen.

## Datenschutz
- Ein Voll-Dump enthält Personen-, Gesundheits- und Zahlungsdaten; bevorzugt reduzierter Snapshot (siehe Plan, offene Entscheidung 1).
- Paketdatei nur passphrase-verschlüsselt übertragen/speichern, Passphrase getrennt vom Paket weitergeben.
- Laptop mit Festplattenverschlüsselung und Bildschirmsperre; WLAN mit WPA2/3 und starkem Passwort.
- Nach der Rückgabe: Volumes (`down -v`), USB-Stick, Downloads und Ersatzlaptop-Kopie löschen; CA von den Handys entfernen.
- Offline-Modus sendet weder Mails noch Webhooks; Outbox wird erst online nach der Rückgabe versendet.

## Probelauf (vor dem Con, Pflicht)
- [ ] Testevent online anlegen, Offline-Version erzeugen, auf Laptop **und** Ersatzlaptop importieren
- [ ] Router ohne Internet: `https://con.local` ohne Zertifikatswarnung auf allen Scan-Handys, Kamera-Scan funktioniert
- [ ] Check-ins und Taverne-Buchungen von mehreren Handys gleichzeitig
- [ ] Netz ziehen und Laptop hart neu starten: Daten vollständig, Banner/Stand korrekt
- [ ] Rückgabepaket erzeugen und online einspielen: Zahlen im Ergebnisbericht stimmen, Saldoprüfung grün
- [ ] Zeiten notieren (Import, Rückgabe), Ersatzlaptop-Wechsel einmal durchspielen
