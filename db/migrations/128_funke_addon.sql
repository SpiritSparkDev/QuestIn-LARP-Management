-- Add-on "Funke" (Matrix-basierter Org-Chat): Login mit der Matrix-ID.
-- funke_homeservers: Servernamen, deren OpenID-Tokens akzeptiert werden
-- (ohne diese Liste koennte jeder fremde Server Nutzer beglaubigen).
-- funke_origin: Origin der Funke-Web-App, der CORS erlaubt wird.
ALTER TABLE app_settings ADD COLUMN funke_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN funke_homeservers text[] NOT NULL DEFAULT '{}';
ALTER TABLE app_settings ADD COLUMN funke_origin text NOT NULL DEFAULT '';

ALTER TABLE oauth_accounts DROP CONSTRAINT oauth_accounts_provider_check;
ALTER TABLE oauth_accounts ADD CONSTRAINT oauth_accounts_provider_check
  CHECK (provider IN ('google', 'facebook', 'discord', 'matrix'));
