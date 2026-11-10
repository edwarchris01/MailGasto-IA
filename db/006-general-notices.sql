ALTER TABLE notices DROP CONSTRAINT notices_provider_check;
ALTER TABLE notices ADD CONSTRAINT notices_provider_check CHECK (provider IN ('nequi','bancolombia','other'));
