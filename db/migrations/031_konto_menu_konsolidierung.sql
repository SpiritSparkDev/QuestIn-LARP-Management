-- Menu keys 'charaktere' and 'con-anmeldungen' are folded into the single
-- 'konto' page (Konto/Veranstaltung/Charaktere tabs on one page) -- see
-- docs/superpowers/specs/2026-09-10-konto-veranstaltung-charaktere-wizard-design.md.
-- Every group that currently shows either of those two also shows 'konto'
-- (verified against db/groupDefaults.js before writing this migration), so
-- no group loses access to the merged page by this update alone.
UPDATE groups SET visible_menus = (visible_menus - 'charaktere') - 'con-anmeldungen';
