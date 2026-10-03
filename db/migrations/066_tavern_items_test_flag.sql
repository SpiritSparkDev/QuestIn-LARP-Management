-- Marks sample menu items created by the Test-Modus so removing the test
-- data takes them away again without touching a real drinks menu.
ALTER TABLE tavern_items ADD COLUMN is_test boolean NOT NULL DEFAULT false;
