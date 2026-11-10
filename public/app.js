'use strict';
const $ = id => document.getElementById(id);
const statuses = { registered: 'Registrado', pending: 'Pendiente', error: 'Error', processing: 'En proceso' };
const categoryNames = {
  alimentacion: 'Alimentación', transporte: 'Transporte', vivienda: 'Vivienda', ocio: 'Ocio',
  salud: 'Salud', educacion: 'Educación', ingresos: 'Ingresos', otros: 'Otros',
};
const flash = message => { $('status').textContent = message; };
const formValues = form => Object.fromEntries(new FormData(form));
const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
let page = 1;
let session = '';

async function api(path, method = 'GET', body) {
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const response = await fetch('/v1/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.message || 'No se pudo completar la solicitud.');
  return data;
}

function action(element, event, handler) {
  element.addEventListener(event, async e => {
    if (event === 'submit') e.preventDefault();
    const button = element.matches('button') ? element : element.querySelector('button');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try { await handler(); } catch (error) { flash(error.message); }
    finally { if (button) button.disabled = false; }
  });
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function money(amount, currency) {
  const units = BigInt(amount);
  return currency + ' ' + new Intl.NumberFormat('es-CO').format(units / 100n) + ',' + (units % 100n).toString().padStart(2, '0');
}

async function workspace(owner) {
  $('welcome').textContent = owner.name;
  $('access').hidden = true;
  $('workspace').hidden = false;
  $('delete-confirm').hidden = !fragment.has('delete');
  await Promise.all([loadMailboxes(), loadNotices(), loadConversations()]);
}

async function loadMailboxes() {
  const rows = await api('mailboxes');
  $('mailboxes').replaceChildren();
  for (const row of rows) {
    const state = { active: 'Vinculado', reconnect: 'Reconexión requerida', disconnected: 'Desvinculado' }[row.state];
    const item = element('li', row.email + ' · ' + state);
    if (row.state === 'active') {
      const remove = element('button', 'Desvincular');
      action(remove, 'click', async () => {
        const result = await api('mailboxes/' + row.id, 'DELETE');
        await loadMailboxes();
        flash(result.providerRevoked ? 'Buzón desvinculado.' : 'Buzón desvinculado. Revoca también el permiso desde tu cuenta de Google.');
      });
      item.append(remove);
    } else if (row.source === 'oauth') {
      const reconnect = element('button', 'Reconectar');
      action(reconnect, 'click', () => authorize(row.id));
      item.append(reconnect);
    }
    $('mailboxes').append(item);
  }
}

async function loadNotices() {
  const query = new URLSearchParams(Object.entries(formValues($('filter'))).filter(([, value]) => value));
  const summary = new URLSearchParams(query);
  summary.delete('status');
  query.set('page', page);
  const [report, notices] = await Promise.all([api('summary?' + summary), api('notices?' + query)]);
  $('totals').textContent = report.totals.length ? 'Gastos registrados: ' +
    report.totals.map(row => money(row.amount_minor, row.currency)).join(' · ') : 'Sin gastos registrados.';
  $('notices').replaceChildren();
  $('notice-detail').replaceChildren();
  for (const row of notices.items) {
    const li = element('li', statuses[row.status] + ' · ' + row.provider + (row.amount_minor ? ' · ' + money(row.amount_minor, row.currency) : ''));
    const detail = element('button', 'Ver detalle');
    action(detail, 'click', async () => {
      const value = await api('notices/' + row.id);
      const data = [statuses[value.status], value.transaction_date, value.description, value.payment_method,
        categoryNames[value.category], value.amount_minor && money(value.amount_minor, value.currency)].filter(Boolean);
      $('notice-detail').replaceChildren(element('p', data.join(' · ')));
    });
    li.append(detail);
    $('notices').append(li);
  }
  $('previous').hidden = page === 1;
  $('next').hidden = !notices.hasMore;
}

async function loadConversations() {
  const rows = await api('chat/sessions');
  const select = $('conversations');
  select.replaceChildren(element('option', 'Selecciona una conversación'));
  select.firstChild.value = '';
  for (const row of rows) {
    const option = element('option', new Date(row.created_at).toLocaleString('es-CO'));
    option.value = row.id;
    select.append(option);
  }
  select.value = session;
  await loadTurns();
}

async function loadTurns() {
  $('turns').replaceChildren();
  if (!session) return;
  const turns = await api('chat/sessions/' + session + '/messages');
  for (const turn of turns) {
    $('turns').append(element('li', 'Tú: ' + turn.question), element('li', 'MailGasto: ' + turn.answer));
  }
}

async function authorize(mailboxId) {
  const { url } = await api('mailboxes/gmail/authorize', 'POST', mailboxId ? { mailboxId } : {});
  location.assign(url);
}

for (const [key, label] of Object.entries(categoryNames)) {
  const option = element('option', label);
  option.value = key;
  $('categories').append(option);
}
action($('login'), 'submit', async () => {
  const owner = await api('auth/login', 'POST', formValues($('login')));
  $('login').reset();
  flash('');
  await workspace(owner);
});
action($('register'), 'submit', async () => {
  const result = await api('auth/register', 'POST', formValues($('register')));
  $('register').reset();
  flash(result.message);
});
action($('verify'), 'submit', async () => {
  await api('auth/verify', 'POST', { token: fragment.get('verify'), ...formValues($('verify')) });
  $('verify').reset();
  $('verify').hidden = true;
  flash('Correo verificado. Ya puedes iniciar sesión.');
});
action($('reset-password'), 'submit', async () => {
  const form = $('reset-password');
  const { password, confirmation } = formValues(form);
  if (password !== confirmation) throw new Error('Las contraseñas deben coincidir.');
  await api('auth/password/reset/confirm', 'POST', { token: fragment.get('reset'), password });
  form.reset();
  form.hidden = true;
  $('access').hidden = false;
  flash('Contraseña actualizada. Ya puedes iniciar sesión.');
});
action($('logout'), 'click', async () => { await api('auth/logout', 'POST'); location.reload(); });
action($('link'), 'click', () => authorize());
action($('link-existing'), 'click', async () => { await api('mailboxes/gmail/existing', 'POST'); await loadMailboxes(); });
action($('filter'), 'submit', async () => { page = 1; await loadNotices(); });
action($('previous'), 'click', async () => { page--; await loadNotices(); });
action($('next'), 'click', async () => { page++; await loadNotices(); });
action($('new-chat'), 'click', async () => { session = (await api('chat/sessions', 'POST')).id; await loadConversations(); });
action($('conversations'), 'change', async () => { session = $('conversations').value; await loadTurns(); });
action($('chat'), 'submit', async () => {
  if (!session) {
    session = (await api('chat/sessions', 'POST')).id;
    await loadConversations();
  }
  const target = session;
  await api('chat/sessions/' + target + '/messages', 'POST', formValues($('chat')));
  $('chat').reset();
  if (session === target) await loadTurns();
});
action($('delete-request'), 'click', async () => flash((await api('account/deletion', 'POST')).message));
action($('delete-confirm'), 'click', async () => {
  if (!window.confirm('¿Eliminar la cuenta, sus movimientos y sus conversaciones?')) return;
  await api('account/deletion/confirm', 'POST', { token: fragment.get('delete') });
  location.reload();
});
if (fragment.has('verify')) $('verify').hidden = false;
if (fragment.get('gmail') === 'linked') flash('Gmail vinculado.');
if (fragment.get('gmail') === 'cancelled') flash('Se canceló la vinculación de Gmail.');
if (fragment.has('reset')) {
  $('access').hidden = true;
  $('reset-password').hidden = false;
} else {
  api('auth/me').then(workspace).catch(() => {});
}
