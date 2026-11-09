-- Spreadsheets kept in sync with Google Sheets (web/sheet-google.mjs). The
-- spreadsheet lives in the library (media_assets, one row per version); this
-- row links its family (baseFamily of the caption) to one Google Sheets file and
-- records the file version and the library version of the last sync, which is
-- the base of the merge when both sides changed. Server boot NEVER creates this
-- table. Until it exists no spreadsheet is linked and nothing syncs, so
-- deploying the code first is safe. Running it in production requires the
-- operator's separate approval.
BEGIN;
CREATE TABLE mtr_harness.sheet_google_links (
 user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
 family text NOT NULL CHECK(family<>''),
 google_email text,
 file_id text NOT NULL,
 link text,
 synced_version bigint NOT NULL DEFAULT 0,
 base_asset_id uuid REFERENCES mtr_harness.media_assets(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id, family)
);
COMMIT;
