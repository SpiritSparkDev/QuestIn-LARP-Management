-- "Anmeldung startet bald" screen: shown instead of the public landing/
-- register pages while enabled (see frontend/coming-soon.html and
-- frontend/js/comingSoonGate.js). coming_soon_message is admin-authored raw
-- HTML, same trust level as email_templates.body -- rendered in an iframe so
-- it can't reach into the surrounding page's DOM. coming_soon_until is
-- optional: NULL means no countdown is shown even while enabled.
ALTER TABLE app_settings ADD COLUMN coming_soon_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN coming_soon_message text NOT NULL DEFAULT '';
ALTER TABLE app_settings ADD COLUMN coming_soon_until timestamptz;
