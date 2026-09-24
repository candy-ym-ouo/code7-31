-- Media processing recovery: track how many times the privacy pipeline attempted a
-- given asset. Used for bounded retries, detector degradation and watchdog recovery.
ALTER TABLE media_assets
  ADD COLUMN processing_attempts integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0);

CREATE INDEX media_assets_recovery_idx
  ON media_assets(privacy_status, updated_at)
  WHERE privacy_status IN ('scanning', 'processing');
