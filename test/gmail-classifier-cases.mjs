const operationDate = '2026-11-11';
const expense = { currency: 'COP', date: operationDate, direction: 'expense' };
const receivedAt = '2026-11-13T18:00:00.000Z';

export const gmailClassifierCases = [
  {
    id: 'english-receipt',
    subject: 'Payment receipt',
    text: 'Your payment was completed on 2026-11-11. Amount paid: USD 49.95. Product: web hosting.',
    expected: { status: 'registered', fields: { amountMinor: '4995', currency: 'USD', date: operationDate,
      direction: 'expense', category: 'compras' } },
  },
  {
    id: 'prior-rejection',
    subject: 'Confirmación de pago',
    text: 'Pagaste COP 42.800 el 2026-11-11. Concepto: alimentos.\nHistorial: la solicitud anterior fue rechazada.',
    expected: { status: 'registered', fields: { ...expense, amountMinor: '4280000', category: 'alimentacion' } },
  },
  {
    id: 'invoice-amount-and-date-roles',
    subject: 'Recibo de pago',
    text: 'Pagaste tu servicio de internet residencial.\nSubtotal: COP 62.000\nComisión: COP 2.000\n' +
      'Total pagado: COP 64.000\nSaldo disponible: COP 13.000\nFecha de operación: 2026-11-11\n' +
      'Fecha de emisión: 2026-11-12\nVencimiento: 2026-12-01',
    expected: { status: 'registered', fields: { ...expense, amountMinor: '6400000', category: 'vivienda' } },
  },
  {
    id: 'incidental-category',
    subject: 'Pago confirmado',
    text: 'Pagaste COP 35.000 el 2026-11-11. Concepto: zapatos deportivos.\nConoce también nuestros planes de farmacia y transporte.',
    expected: { status: 'registered', fields: { ...expense, amountMinor: '3500000', category: 'compras' } },
  },
  {
    id: 'unverified-sender',
    subject: 'Pago confirmado',
    text: 'Pagaste COP 30.000 el 2026-11-11. Concepto: almuerzo.',
    authenticated: false,
    expected: { status: 'pending' },
  },
  {
    id: 'own-transfer',
    subject: 'Traslado completado',
    text: 'Transferencia entre tus propias cuentas completada. Importe enviado: COP 15.000. Fecha de operación: 2026-11-11.',
    expected: { status: 'registered', fields: { ...expense, amountMinor: '1500000', category: 'otros' } },
  },
  {
    id: 'ambiguous-amounts',
    subject: 'Confirmación de movimientos',
    text: 'Pagaste COP 13.000 y transferiste COP 14.000 el 2026-11-11.',
    expected: { status: 'pending' },
  },
  {
    id: 'request-not-paid',
    subject: 'Payment requested',
    text: 'A vendor sent you a request for USD 125.00 on 2026-11-11. No money has been charged.',
    expected: { status: 'ignored' },
  },
  {
    id: 'explicit-decline',
    subject: 'Pago rechazado',
    text: 'Tu pago por COP 42.800 fue rechazado el 2026-11-11. No se realizó ningún cargo.',
    expected: { status: 'ignored' },
  },
  {
    id: 'transfer-without-purpose',
    subject: 'Envío confirmado',
    text: 'Enviaste COP 15.000 el 2026-11-11. Destino: billetera digital.',
    expected: { status: 'registered', fields: { ...expense, amountMinor: '1500000', category: 'otros' } },
  },
  {
    id: 'legitimate-identical-amount-one',
    subject: 'Consumo pagado A',
    text: 'Pagaste COP 21.500 en Restaurante Vista el 2026-11-11.',
    expected: { status: 'registered', fields: { ...expense, amountMinor: '2150000', category: 'alimentacion' } },
  },
  {
    id: 'legitimate-identical-amount-two',
    subject: 'Consumo pagado B',
    text: 'Pagaste COP 21.500 en Restaurante Valle el 2026-11-11.',
    expected: { status: 'registered', fields: { ...expense, amountMinor: '2150000', category: 'alimentacion' } },
  },
].map(row => ({ from: 'avisos@comercio.example.test', labels: ['INBOX'], receivedAt, authenticated: true, ...row }));
