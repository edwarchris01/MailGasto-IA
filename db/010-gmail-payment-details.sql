ALTER TABLE notices
  ADD COLUMN reported_transaction_date date,
  ADD COLUMN transaction_time text CHECK (transaction_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'),
  ADD COLUMN reported_payment_method text CHECK (reported_payment_method IN ('Nequi','Bancolombia','Tarjeta','PSE','Transferencia')),
  ADD COLUMN card_type text CHECK (card_type IN ('debit','credit')),
  ADD COLUMN card_last4 text CHECK (card_last4 ~ '^[0-9]{4}$'),
  ADD COLUMN reported_institution text CHECK (reported_institution IN ('nequi','bancolombia')),
  ADD CONSTRAINT notices_card_details_check CHECK (
    (card_type IS NULL AND card_last4 IS NULL) OR reported_payment_method IS NOT DISTINCT FROM 'Tarjeta'
  );
