ALTER TABLE notices
  DROP CONSTRAINT notices_reported_payment_method_check,
  ADD CONSTRAINT notices_reported_payment_method_check CHECK (
    reported_payment_method IN ('Nequi','Bancolombia','Tarjeta','PSE','Transferencia','QR','Botón Bancolombia','Bre-B')
  );
