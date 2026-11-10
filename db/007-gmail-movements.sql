ALTER TABLE transactions
  ALTER COLUMN payment_method DROP NOT NULL,
  DROP CONSTRAINT transactions_category_check,
  ADD CONSTRAINT transactions_category_check CHECK (
    category IN ('alimentacion','transporte','vivienda','ocio','salud','educacion','compras','ingresos','otros')
  );

ALTER TABLE manual_movements
  DROP CONSTRAINT manual_movements_category_check,
  ADD CONSTRAINT manual_movements_category_check CHECK (
    category IN ('alimentacion','transporte','vivienda','ocio','salud','educacion','compras','ingresos','otros')
  );
