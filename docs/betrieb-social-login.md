# Social-Login (Google, Facebook, Discord): abgeschaltet

Stand: D6 im Föderationsplan. Die Anmeldung mit Google, Facebook und Discord ist abgeschaltet,
auch wenn `GOOGLE_CLIENT_ID` usw. in der `.env` stehen. Start- und Callback-Adressen
(`/auth/oauth/<anbieter>/start|callback`) leiten auf `/login.html?oauth_error=social_disabled`,
die Login-Seite zeigt keine Knöpfe mehr. Funke-Login (Matrix-ID) ist davon nicht betroffen.

Bestehende Einträge in `oauth_accounts` bleiben gespeichert (Datenauskunft, spätere Rückkehr
über den QuestIn-Hub).

## Konten ohne Passwort

Wer sich bisher nur über Google/Facebook/Discord angemeldet hat, hat kein lokales Passwort.
„Passwort vergessen?“ auf der Login-Seite deckt das ab: Die Mail enthält den Link zum Setzen
eines Passworts (`reset-password.html`), danach geht der normale Login.

Betroffene Konten finden (z. B. um sie vorab per Mail zu informieren):

```sql
SELECT DISTINCT u.id, u.email, u.first_name, u.last_name
FROM users u JOIN oauth_accounts o ON o.user_id = u.id
WHERE o.provider IN ('google', 'facebook', 'discord')
  AND u.password_hash IS NULL AND u.deactivated_at IS NULL;
```

Admins können einzelnen Personen den Link auch aus der Mitgliederverwaltung schicken.
