-- "Test-Modus": a fictional data set (people, characters, event) that can be
-- loaded and removed as one unit. Everything it creates is flagged is_test,
-- so removal never touches real data.
ALTER TABLE users ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN is_test boolean NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN test_mode_enabled boolean NOT NULL DEFAULT false;
