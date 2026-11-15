import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildGmailWorkflow } from '../n8n/gmail-workflow.mjs';

export const n8nContainer = process.env.MAILGASTO_E2E_N8N_CONTAINER ?? 'mailgasto-e2e-n8n';
const n8nPort = process.env.MAILGASTO_E2E_N8N_PORT ?? '5679';
export const n8nWebhook = 'http://127.0.0.1:' + n8nPort + '/webhook';
export const localModel = process.env.MAILGASTO_E2E_MODEL ?? 'qwen3.5:4b';
if (!/^mailgasto-e2e-n8n(?:-[a-z]+)?$/.test(n8nContainer) || !/^\d{4,5}$/.test(n8nPort)) {
  throw Error('Configura un contenedor y un puerto locales de n8n para las pruebas.');
}

const legacy = new Set(['Gmail Trigger', 'Preparar IDs de Gmail', 'Guardar ID para reintento',
  'Revisar entregas pendientes', 'Buscar IDs pendientes', 'Reservar reintentos', 'Preparar lectura de Gmail',
  'Leer cuerpo de Gmail', 'Leer cabeceras Gmail directo', 'Normalizar Gmail directo',
  'Confirmar entrega del Gmail directo', 'Quitar ID resuelto']);

export function testCredentials(prefix) {
  return {
    agentKey: randomBytes(32).toString('hex'),
    ingestKey: randomBytes(32).toString('hex'),
    agent: { id: prefix + 'agent', name: prefix + ' agent' },
    ingest: { id: prefix + 'ingest', name: prefix + ' ingest' },
    model: { id: prefix + 'model', name: prefix + ' Ollama' },
  };
}

export function oauthTestWorkflow({ credentials, path, resultUrl, senderJson, classifier }) {
  const { agent, ingest, model } = credentials;
  const flow = buildGmailWorkflow({ agentCredential: agent, resultCredential: ingest, modelCredential: model,
    resultUrl, senderJson, stage: false, classifier, legacyEnabled: false });
  // Gmail direct has no real credential in this isolated instance.
  flow.nodes = flow.nodes.filter(node => !legacy.has(node.name));
  const webhook = flow.nodes.find(node => node.name === 'Recibir Gmail vinculado');
  webhook.parameters.path = path;
  flow.nodes.find(node => node.name === 'Ollama Chat Model').parameters.model = localModel;
  for (const [source, connections] of Object.entries(flow.connections)) {
    if (legacy.has(source)) delete flow.connections[source];
    else for (const [type, branches] of Object.entries(connections)) {
      connections[type] = branches.map(branch => branch.filter(target => !legacy.has(target.node)));
    }
  }
  return flow;
}

export function installWorkflows(workflows, credentials, { ollamaUrl = 'http://ollama:11434' } = {}) {
  const container = n8nContainer;
  const docker = (...args) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const inspect = JSON.parse(docker('inspect', container).toString())[0];
  const binding = inspect.NetworkSettings.Ports?.['5678/tcp']?.[0];
  if (binding?.HostIp !== '127.0.0.1' || binding.HostPort !== n8nPort ||
      !Object.hasOwn(inspect.NetworkSettings.Networks, 'mailgasto-e2e')) {
    throw Error('Se requiere un contenedor aislado con la red mailgasto-e2e y puerto local.');
  }
  const temp = mkdtempSync(join(tmpdir(), 'mailgasto-e2e-'));
  const name = '/tmp/mailgasto-' + randomUUID();
  try {
    writeFileSync(join(temp, 'credentials.json'), JSON.stringify([
      { ...credentials.agent, type: 'httpHeaderAuth', data: { name: 'X-MailGasto-Agent', value: credentials.agentKey } },
      { ...credentials.ingest, type: 'httpHeaderAuth', data: { name: 'X-MailGasto-Ingest', value: credentials.ingestKey } },
      { ...credentials.model, type: 'ollamaApi', data: { baseUrl: ollamaUrl } },
    ]));
    writeFileSync(join(temp, 'workflows.json'), JSON.stringify(workflows.map(workflow => ({
      ...workflow, nodes: workflow.nodes.map(node => ({ id: randomUUID(), ...node })),
    }))));
    for (const kind of ['credentials', 'workflows']) docker('cp', join(temp, kind + '.json'), container + ':' + name + '-' + kind + '.json');
    try {
      docker('exec', container, 'n8n', 'import:credentials', '--input=' + name + '-credentials.json');
    } finally {
      docker('exec', '--user', 'root', container, 'rm', '-f', name + '-credentials.json');
    }
    docker('exec', container, 'n8n', 'import:workflow', '--input=' + name + '-workflows.json');
    for (const { id } of workflows) docker('exec', container, 'n8n', 'publish:workflow', '--id=' + id);
    docker('restart', container);
  } finally {
    docker('exec', '--user', 'root', container, 'rm', '-f', name + '-credentials.json', name + '-workflows.json');
    rmSync(temp, { recursive: true, force: true });
  }
}

export async function waitFor(name, check, seconds = 30) {
  const until = Date.now() + seconds * 1000;
  do {
    const result = await check();
    if (result !== undefined) return result;
    await delay(350);
  } while (Date.now() < until);
  throw new Error('No se pudo comprobar: ' + name);
}

export function waitForProtectedHook(path) {
  return waitFor('webhook de n8n activo y protegido', async () => {
    const response = await fetch(n8nWebhook + '/' + path, { method: 'POST', signal: AbortSignal.timeout(3500) }).catch(() => undefined);
    if (response && [401, 403].includes(response.status)) return true;
  }, 180);
}
