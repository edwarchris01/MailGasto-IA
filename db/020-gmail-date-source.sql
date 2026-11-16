ALTER TABLE notices ADD COLUMN date_source text CHECK (date_source IN ('reported','received_at'));

-- Keep legacy provenance unknown. A verified re-read may fill it without changing the movement.
CREATE OR REPLACE VIEW confirmed_movements AS
SELECT t.id, m.account_id, coalesce(a.amount_minor, t.amount_minor) AS amount_minor,
       t.currency, coalesce(a.transaction_date, t.transaction_date) AS transaction_date,
       t.payment_method, t.description, coalesce(a.category, t.category) AS category,
       t.direction, 'email'::text AS source, n.id AS notice_id, n.provider,
       a.note, t.amount_minor AS original_amount_minor, t.transaction_date AS original_transaction_date,
       coalesce(a.revision, 0) AS correction_revision, n.date_source, n.received_at
FROM transactions t JOIN notices n ON n.id=t.notice_id JOIN mailboxes m ON m.id=n.mailbox_id
LEFT JOIN email_movement_adjustments a ON a.movement_id=t.id
WHERE n.status='registered'
UNION ALL
SELECT id, account_id, amount_minor, currency, transaction_date,
       payment_method, description, category, direction, 'manual', NULL::uuid, NULL::text,
       NULL::text, NULL::bigint, NULL::date, NULL::integer, NULL::text, NULL::timestamptz
FROM manual_movements;
