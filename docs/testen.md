# Testen

`npm test` startet alle Tests mit `--test-concurrency=1`. Die Integrationstests teilen sich die eine Zeile in `payment_settings` und dürfen deshalb nicht parallel laufen.

Einzelne Dateien: `node --test --test-concurrency=1 tests/integration/events.test.js`. Nie parallel zu anderen Testläufen auf derselben Datenbank starten. Für gleichzeitige Läufe eine eigene Datenbank nehmen:

```bash
TEST_DATABASE_URL=postgres://app:app@localhost:5433/pakyrion_test_b node --test --test-concurrency=1 <dateien>
```
