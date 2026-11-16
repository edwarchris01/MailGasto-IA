ALTER TABLE mobile_google_signins
  ADD COLUMN client_platform text NOT NULL DEFAULT 'mobile'
  CHECK (client_platform IN ('mobile', 'web'));
