'use strict';
const $ = id => document.getElementById(id);
const csrf = document.querySelector('meta[name="qa-csrf"]').content;
const storageKey = 'fusion-native-qa-token';
let token = localStorage.getItem(storageKey) || '';
let started = false, session = null, selected = '', active = null, busy = false, refreshing = false;
let customerPending = null, operatorPending = null;
const messages = new Map(), operatorMessages = new Map();
const pollingErrors = new Set();
let cursor = 0, operatorCursor = 0;
const errors = {
  valid_phone_required: 'Ingresá un teléfono de 10 a 15 dígitos.',
  conversation_changed_reload: 'La conversación cambió. Actualizá y revisá su estado antes de volver a actuar.',
  owned_by_another_operator: 'Otro asesor tomó esta conversación.',
  take_conversation_first: 'Tomá la conversación antes de responder.',
  rate_limited: 'Se alcanzó el límite temporal. Esperá un minuto y reintentá.',
  preview_csrf_required: 'La sesión de prueba venció. Recargá la página.',
  preview_session_required: 'La sesión de prueba venció. Recargá la página.',
  session_not_found: 'No encontramos esta conversación. Iniciá una nueva prueba.',
  invalid_fields: 'Revisá los campos. El mensaje admite hasta 4.000 caracteres.'
};
async function request(path, body, headers = {}) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000), cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) { const error = new Error(errors[data.error] || 'No pudimos completar la acción. Reintentá.'); error.status = response.status; throw error; }
  return data;
}
const web = (path, body) => request('/v1/web/' + path, body, { Authorization: 'Bearer ' + token });
const ops = body => request('/qa/operator', body, { 'X-QA-CSRF': csrf });
function fail(side, error, pending) {
  $(side + '-error').textContent = error.status ? error.message : 'No se pudo conectar. El historial se conserva; reintentá.';
  $(side + '-retry').hidden = !pending;
}
function clearError(side) { pollingErrors.delete(side); $(side + '-error').textContent = ''; $(side + '-retry').hidden = true; }
function render(target, rows) {
  const list = $(target); const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 70;
  list.replaceChildren(...Array.from(rows.values()).map(row => {
    const li = document.createElement('li'), who = document.createElement('span'), text = document.createElement('p');
    who.className = 'sender'; who.textContent = row.sender === 'customer' ? 'Cliente' : (row.agent_name || 'Bot de prueba');
    text.textContent = row.text; li.append(who, text); return li;
  }));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}
function stateText(value) {
  if (!value) return 'Seleccioná una conversación.';
  if (value.status === 'archived') return 'Conversación archivada. Un nuevo mensaje del cliente la vuelve a abrir.';
  if (value.agent_id) return 'En atención · ' + value.agent_name;
  if (value.needs_human) return 'Pendiente de atención humana.';
  return 'Bot de prueba disponible.';
}
function controls() {
  $('customer-text').disabled = !started || !!customerPending;
  $('customer-send').disabled = !started || !!customerPending;
  const open = active?.status === 'open', own = active?.agent_id === 'qa-operator', blocked = busy || !!operatorPending;
  $('take').disabled = blocked || !open || !!active?.agent_id;
  $('release').disabled = blocked || !open || !own;
  $('archive').disabled = blocked || !open || (!!active?.agent_id && !own);
  $('operator-text').disabled = blocked || !open || !own;
  $('operator-send').disabled = blocked || !open || !own;
  $('operator-state').textContent = active ? stateText(active) : 'Todavía no hay consultas. Enviá un mensaje desde la vista del cliente.';
  if (session) $('customer-state').textContent = stateText(session);
}
async function refreshCustomer() {
  if (!token || !started) return;
  let more = true;
  while (more) {
    const data = await web('messages?after=' + cursor); session = data.session;
    data.messages.forEach(row => messages.set(row.id, row)); cursor = data.cursor; more = data.has_more;
  }
  render('customer-messages', messages); controls();
}
async function refreshOperator() {
  const data = await ops({ action: 'list' });
  const options = data.sessions.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = (item.customer_name || 'Cliente') + ' · ' + (item.needs_human ? 'Pide asesor' : item.agent_name || 'Bot'); return option; });
  if (!options.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Sin conversaciones abiertas'; options.push(option); }
  if (!data.sessions.some(item => item.id === selected)) { selected = data.sessions[0]?.id || ''; operatorCursor = 0; operatorMessages.clear(); }
  $('inbox').replaceChildren(...options); $('inbox').value = selected;
  if (selected) {
    const reading = selected;
    let more = true;
    while (more) {
      const detail = await ops({ action: 'read', session_id: reading, after: operatorCursor, limit: 100 });
      if (reading !== selected) return;
      active = detail.session; detail.messages.forEach(row => operatorMessages.set(row.id, row)); operatorCursor = detail.cursor; more = detail.has_more;
    }
  } else active = null;
  render('operator-messages', operatorMessages); controls();
}
async function refresh() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try { await refreshCustomer(); if (pollingErrors.has('customer') && !customerPending) clearError('customer'); }
  catch (error) { if (!customerPending) { pollingErrors.add('customer'); fail('customer', error, false); } }
  try { await refreshOperator(); if (pollingErrors.has('operator') && !operatorPending) clearError('operator'); }
  catch (error) { if (!operatorPending) { pollingErrors.add('operator'); fail('operator', error, false); } }
  refreshing = false;
}
$('contact-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; clearError('customer');
  if (!token) { token = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join(''); localStorage.setItem(storageKey, token); }
  try { session = await web('session', { name: $('customer-name').value, phone: $('customer-phone').value, page_title: 'Prueba privada', page_url: location.origin + '/qa/' }); started = true; $('contact-form').hidden = true; controls(); await refresh(); $('customer-text').focus(); }
  catch (error) { fail('customer', error, false); }
  finally { button.disabled = false; }
});
async function sendCustomer() {
  if (!customerPending || busy) return;
  busy = true; controls(); clearError('customer');
  try { await web('messages', customerPending); customerPending = null; $('customer-text').value = ''; await refresh(); }
  catch (error) {
    if (error.status && error.status < 500 && error.status !== 429) customerPending = null;
    fail('customer', error, !!customerPending);
  }
  finally { busy = false; controls(); if (!customerPending) $('customer-text').focus(); }
}
$('customer-form').addEventListener('submit', async event => { event.preventDefault(); if (customerPending) return; customerPending = { request_id: crypto.randomUUID(), text: $('customer-text').value.trim() }; await sendCustomer(); });
$('customer-retry').addEventListener('click', sendCustomer);
async function executeOperator() {
  if (!operatorPending || busy) return;
  busy = true; controls(); clearError('operator');
  try { await ops(operatorPending); const replied = operatorPending.action === 'reply'; operatorPending = null; if (replied) $('operator-text').value = ''; await refresh(); }
  catch (error) {
    // Conflicts require fresh review and a new command; network retries retain the original ID.
    if (error.status && error.status < 500 && error.status !== 429) operatorPending = null;
    fail('operator', error, !!operatorPending); await refresh();
  } finally { busy = false; controls(); }
}
function action(name, text = '') { if (!active || busy || operatorPending) return; operatorPending = { action: name, session_id: active.id, revision: active.revision, request_id: crypto.randomUUID(), text }; void executeOperator(); }
for (const name of ['take', 'release', 'archive']) $(name).addEventListener('click', () => action(name));
$('operator-form').addEventListener('submit', event => { event.preventDefault(); action('reply', $('operator-text').value.trim()); });
$('operator-retry').addEventListener('click', executeOperator);
$('inbox').addEventListener('change', async () => { selected = $('inbox').value; operatorCursor = 0; operatorMessages.clear(); active = null; clearError('operator'); controls(); await refresh(); });
$('refresh').addEventListener('click', async () => { clearError('operator'); await refresh(); });
$('new-chat').addEventListener('click', () => { if (customerPending || busy) return; token = ''; localStorage.removeItem(storageKey); session = null; started = false; cursor = 0; messages.clear(); $('contact-form').hidden = false; $('customer-state').textContent = 'Iniciá una conversación para probar el chat.'; render('customer-messages', messages); clearError('customer'); controls(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
async function boot() {
  if (token) {
    try { const data = await web('messages?after=0'); session = data.session; started = true; data.messages.forEach(row => messages.set(row.id, row)); cursor = data.cursor; $('contact-form').hidden = true; render('customer-messages', messages); }
    catch (error) { if (error.status === 401 || error.status === 404) { token = ''; localStorage.removeItem(storageKey); } else fail('customer', error, false); }
  }
  controls(); await refresh(); setInterval(refresh, 3000);
}
void boot();
