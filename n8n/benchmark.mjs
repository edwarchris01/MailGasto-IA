// An unpublished n8n pilot. It never reads Gmail or calls the persistence endpoint.
import { buildGmailWorkflow, gmailSdk } from './gmail-workflow.mjs';

const senders = { 'avisos@nequi.example': 'nequi', 'tarjeta@bancolombia.example': 'bancolombia' };
const formats = [
  { currency: 'COP', token: '$ 25.000', amountMinor: '2500000' },
  { currency: 'COP', token: 'COP 950', amountMinor: '95000' },
  { currency: 'USD', token: 'USD 12.50', amountMinor: '1250' },
  { currency: 'EUR', token: '€ 25,40', amountMinor: '2540' },
  { currency: 'COP', token: '25.000,25 COP', amountMinor: '2500025' },
];
const dates = ['10/11/2026', '2026-11-10', '10 de noviembre de 2026'];
const stores = [
  ['Restaurante Demo', 'alimentacion'], ['Parqueadero Demo', 'transporte'], ['Farmacia Demo', 'salud'],
  ['Cine Demo', 'ocio'], ['Universidad Demo', 'educacion'],
];
const fixtures = formats.flatMap(({ token, ...amount }, group) =>
  dates.flatMap(date => [true, false].map(income => {
    const [store, category] = stores[group];
    return {
      from: income ? 'avisos@nequi.example' : 'tarjeta@bancolombia.example',
      subject: income ? 'Aviso de transferencia' : 'Aviso de compra con tarjeta',
      text: income ? 'Recibiste ' + token + ' el ' + date + '.' : 'Compraste ' + token + ' en ' + store + ' el ' + date + ' con tarjeta.',
      expected: {
        ...amount, date: '2026-11-10', paymentMethod: income ? 'Nequi' : 'Tarjeta',
        direction: income ? 'income' : 'expense', category: income ? 'ingresos' : category,
      },
    };
  })));
fixtures.push(
  {
    from: 'tarjeta@bancolombia.example',
    subject: 'Aviso de compra con tarjeta',
    text: 'Compraste USD 12.50 el 10/11/2026 en Farmacia Demo con tarjeta. Saldo disponible COP 10.000.',
    expected: {
      amountMinor: '1250', currency: 'USD', date: '2026-11-10', paymentMethod: 'Tarjeta',
      direction: 'expense', category: 'salud',
    },
  },
  {
    from: 'tarjeta@bancolombia.example',
    subject: 'Aviso de compra con tarjeta',
    text: 'Compraste COP 25.000 el 10/11/2026 en Cafetería Demo con tarjeta. Valor de la compra COP 50.000.',
    expected: {},
    expectedStatus: 'pending',
    expectedUnconfirmed: 'amount',
  },
  {
    from: 'avisos@comercio.example',
    subject: 'Pago de ropa',
    text: 'Tu pago fue procesado, pagaste 50.000 en almacenes Agaval, el 10/11/2026 a las 12:00pm, gracias por tu compra.',
    expected: {
      amountMinor: '5000000', currency: 'COP', date: '2026-11-10', paymentMethod: null,
      direction: 'expense', category: 'compras',
    },
  },
);
const workflow = buildGmailWorkflow({ senderJson: JSON.stringify(senders) });
const label = 'MailGasto IA · Piloto sintético';
const trigger = {
  type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, name: 'Ejecutar piloto', position: [0, 0], parameters: {},
};
const code = (name, position, jsCode) => ({
  type: 'n8n-nodes-base.code', typeVersion: 2, name, position, parameters: { mode: 'runOnceForAllItems', jsCode },
});
const cases = code('Construir avisos sintéticos', [240, 0], `
const fixtures = ${JSON.stringify(fixtures)};
const input = $input.first().json;
const start = Math.min(fixtures.length - 1, Math.max(0, Math.trunc(Number(input.start)) || 0));
const size = Math.min(3, Math.max(1, Math.trunc(Number(input.size)) || 1));
const startedAt = new Date().toISOString();
return fixtures.slice(start, start + size).map(({from,subject,text,expected,expectedStatus,expectedUnconfirmed}, index) => ({
  json: { identity: {source: 'legacy', messageId: 'synthetic-' + (start + index), receivedAt: startedAt, startedAt},
    labels: ['INBOX'], from, subject, text, expected, expectedStatus, expectedUnconfirmed }
}));
`);
const timer = code('Iniciar medición del aviso', [960, 0], `
return [{ json: { ...$input.first().json, agentStartedAt: Date.now() }, pairedItem: { item: 0 } }];
`);
const metrics = code('Medir precisión sintética', [1680, 0], `
return $input.all().map(({json: {result, agentOutputValid}}, i) => {
  const { expected, expectedStatus = 'registered', expectedUnconfirmed } = $('Construir avisos sintéticos').itemMatching(i).json;
  const agent = $('Clasificar aviso con AI Agent').itemMatching(i).json;
  const { agentStartedAt } = $('Iniciar medición del aviso').itemMatching(i).json;
  const mismatches = Object.keys(expected).filter(key => result.movement?.[key] !== expected[key]);
  if (result.status !== expectedStatus) mismatches.push('status');
  if (expectedUnconfirmed && !result.unconfirmedFields?.includes(expectedUnconfirmed)) mismatches.push('unconfirmedFields');
  const toolCalls = (agent.intermediateSteps ?? []).filter(step => step.action?.tool === 'consultar_reglas_aviso').length;
  return { json: { case: result.messageId, status: result.status, mismatches, exact: mismatches.length === 0,
    agentOutputValid, toolCalls, elapsedMs: Date.now() - agentStartedAt,
    reason: result.reason, unconfirmedFields: result.unconfirmedFields }, pairedItem: { item: i } };
});
`);
const at = (name, position) => ({ ...workflow.nodes.find(node => node.name === name), position });
const filter = at('Filtrar y proteger aviso', [480, 0]);
const loop = at('Procesar avisos uno a uno', [720, 0]);
const agent = at('Clasificar aviso con AI Agent', [1200, 0]);
agent.parameters = { ...agent.parameters, options: { ...agent.parameters.options, returnIntermediateSteps: true } };
const result = at('Preparar resultado para NestJS', [1440, 0]);
const model = at('Ollama Chat Model', [1140, 220]);
const tool = at('consultar_reglas_aviso', [1300, 220]);
const chain = [trigger, cases, filter, loop, timer, agent, result, metrics];
const edge = target => [{ node: target.name, type: 'main', index: 0 }];
const connections = Object.fromEntries(chain.slice(0, -1).map((node, i) =>
  [node.name, { main: node === loop ? [[], edge(chain[i + 1])] : [edge(chain[i + 1])] }]));
connections[metrics.name] = { main: [edge(loop)] };
connections[model.name] = workflow.connections[model.name];
connections[tool.name] = workflow.connections[tool.name];

const pilot = { name: label, nodes: [...chain, model, tool], connections };
process.stdout.write(process.argv.includes('--json') ? JSON.stringify(pilot) : gmailSdk(pilot, 'mailgasto-pilot'));
