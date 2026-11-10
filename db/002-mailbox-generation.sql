ALTER TABLE mailboxes ADD COLUMN generation uuid NOT NULL DEFAULT gen_random_uuid();
