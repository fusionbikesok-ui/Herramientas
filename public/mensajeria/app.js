const API = '../api/mensajeria';
const POLL_MIN = 10000;
const POLL_MAX = 60000;
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/aac', 'video/mp4']);
const FILE_MIMES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'video/mp4' };
const ROLES = { reader: 'Consulta', agent: 'Agente', supervisor: 'Supervisión' };
const PRESENCE = { available: 'Disponible', busy: 'Ocupado', offline: 'No disponible' };
const DELIVERY = { queued: '◷ En cola', queue: '◷ En cola', pending: '◷ En cola', sending: '◷ Enviando', sent: '✓ Enviado', delivered: '✓✓ Entregado', read: '✓✓ Leído', failed: '× Falló el envío', cancelled: '× Cancelado', unknown: '? Sin confirmación' };
const DELIVERY_PROGRESS = { queue: 0, queued: 0, pending: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
const SEND_BLOCKED = { thread_closed: 'La conversación está cerrada. Reabrila para responder.', number_not_connected: 'El número de negocio todavía no está conectado. Completá la conexión para responder.', web_not_connected: 'La atención del chat web todavía no está disponible. Actualizá el estado antes de responder.', window_closed: 'Fuera de la ventana de atención de 24 horas. Se necesita una plantilla aprobada.', owner_required: 'Necesitás ser responsable de esta conversación para responder.' };
const ERRORS = { ...SEND_BLOCKED, already_owned: 'Otra persona ya tomó esta conversación. Se actualizará el responsable.', revision_conflict: 'La conversación cambió mientras trabajabas. Revisá su estado actualizado antes de continuar.', idempotency_conflict: 'Esta operación ya tiene un registro diferente. Revisá el historial antes de volver a enviar.', inbox_not_configured: 'La conexión del servicio de mensajería todavía no está configurada.', write_required: 'Tu acceso permite consultar, pero no cambiar la atención.', invalid_target: 'La persona elegida ya no está disponible para atender. Actualizá el equipo.', thread_not_found: 'No se encontró esta conversación.', invalid_media_caption: 'Los archivos admiten hasta 1024 caracteres. El audio debe enviarse sin texto adjunto.', invalid_message: 'Escribí un mensaje o elegí un archivo válido antes de enviar.', media_not_available: 'El archivo no está disponible. Volvé a adjuntarlo antes de enviar.', media_not_found: 'No se encontró el archivo.', media_unavailable: 'El archivo todavía no está disponible.', unsupported_media_type: 'Este tipo de archivo no está permitido.', media_too_large: 'El archivo supera el tamaño permitido.', media_signature_mismatch: 'El contenido no coincide con el tipo de archivo. Elegí un archivo válido.', unsafe_pdf: 'Este PDF contiene elementos no admitidos. Elegí una versión sin contenido activo.', upload_quota_exceeded: 'Se alcanzó el límite de archivos de esta conversación.', nonce_store_unavailable: 'No se pudo confirmar la conexión segura. El servicio volverá a intentar conectarse.' };

export function errorMessage(result) {
  if (result?.code === 'web_media_unsupported') return 'El chat web admite solo texto por ahora. Quitá el archivo para responder.';
  if (ERRORS[result?.code]) return ERRORS[result.code];
  const message = typeof result?.error === 'string' ? result.error : '';
  return message && !/^[a-z0-9_]+$/.test(message) ? message : 'No se pudo completar la operación. Actualizá el estado antes de continuar.';
}

export function sendWindow(thread, now = Date.now()) {
  if (!thread) return { allowed: false, label: 'Sin conversación' };
  if (threadChannel(thread) === 'web') {
    if (thread.can_send === true) return { allowed: true, label: 'Chat web disponible' };
    const reason = ['thread_closed', 'owner_required', 'web_not_connected'].includes(thread.send_blocked_reason) ? SEND_BLOCKED[thread.send_blocked_reason] : 'No se pudo confirmar la disponibilidad del chat web. Actualizá el estado antes de responder.';
    return { allowed: false, label: reason };
  }
  if (thread.can_send === false) return { allowed: false, label: SEND_BLOCKED[thread.send_blocked_reason] || 'No se pudo confirmar que este número pueda enviar texto libre. Actualizá el estado antes de responder.' };
  if (thread.can_send === true) return { allowed: true, label: 'Ventana de atención abierta' };
  const inbound = Date.parse(thread.last_inbound_at || '');
  if (!Number.isFinite(inbound) || inbound > now) return { allowed: false, label: 'No se pudo confirmar la ventana de atención de 24 horas.' };
  if (now - inbound >= SEND_WINDOW_MS) return { allowed: false, label: 'Pasaron 24 horas desde el último mensaje del cliente. Se necesita una plantilla aprobada.' };
  return { allowed: true, label: 'Ventana de atención abierta' };
}

export function threadChannel(thread) { return thread?.channel === 'web' ? 'web' : 'whatsapp'; }
export function channelLabel(thread) { return threadChannel(thread) === 'web' ? 'Chat web' : 'WhatsApp'; }
export function mediaAllowed(thread) { return Boolean(thread && (typeof thread.capabilities?.media === 'boolean' ? thread.capabilities.media : threadChannel(thread) === 'whatsapp')); }
export function aiStateLabel(thread, status) {
  if (thread?.bot_paused) return 'IA pausada';
  const channel = threadChannel(thread) === 'web' ? status?.web : status?.numbers?.find(number => String(number.number_id) === String(thread?.number_id));
  if (!channel || typeof channel.connected !== 'boolean' || typeof channel.bot_enabled !== 'boolean') return 'Estado de IA pendiente';
  return channel.connected && channel.bot_enabled ? 'IA habilitada' : 'IA deshabilitada';
}
export function safePageUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

export function permissions(actor, thread, now = Date.now()) {
  const write = actor?.role === 'agent' || actor?.role === 'supervisor';
  const supervisor = actor?.role === 'supervisor';
  const owner = Boolean(actor?.id && thread?.owner_id && String(actor.id) === String(thread.owner_id));
  const manage = Boolean(write && thread && (owner || supervisor));
  const control = Boolean(write && thread && (!thread.owner_id || owner || supervisor));
  const open = Boolean(thread && thread.status !== 'closed');
  return { write, supervisor, owner, manage, control, take: Boolean(write && thread && !thread.owner_id && open), send: Boolean(manage && open && sendWindow(thread, now).allowed), note: manage };
}

export function oldestMessageId(messages) {
  const oldest = messages.filter(message => /^\d+$/.test(String(message.id))).reduce((previous, message) => {
    if (!previous) return message;
    const created = Date.parse(message.created_at) || 0;
    const previousCreated = Date.parse(previous.created_at) || 0;
    return created < previousCreated || created === previousCreated && BigInt(message.id) < BigInt(previous.id) ? message : previous;
  }, null);
  return oldest ? String(oldest.id) : null;
}

export function mergeMessages(previous, incoming) {
  const result = new Map(previous.map(message => [String(message.id), message]));
  for (const message of incoming) if (message.id != null) {
    const existing = result.get(String(message.id)); const merged = { ...existing, ...message };
    if (existing?.status) {
      const oldProgress = DELIVERY_PROGRESS[existing.status]; const newProgress = DELIVERY_PROGRESS[message.status];
      if (message.status == null || oldProgress != null && newProgress != null && oldProgress > newProgress || oldProgress >= 3 && ['unknown', 'failed', 'cancelled'].includes(message.status) || ['unknown', 'failed', 'cancelled'].includes(existing.status) && newProgress != null && newProgress < 2) merged.status = existing.status;
    }
    result.set(String(message.id), merged);
  }
  return [...result.values()].sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
}

export function reconcileHistoryPage(previous, incoming, { more = false, knownMore = false, older = false, earlierExists } = {}) {
  const page = mergeMessages([], incoming);
  const knownIds = new Set(previous.map(message => String(message.id)));
  const reset = !older && previous.length > 0 && page.length > 0 && !page.some(message => knownIds.has(String(message.id)));
  const messages = mergeMessages(reset ? [] : previous, page);
  if (older || !previous.length || reset) return { messages, more: Boolean(more), reset, probeBefore: null };
  if (!more) return { messages, more: false, reset: false, probeBefore: null };
  const oldest = oldestMessageId(messages);
  if (knownMore || oldest === oldestMessageId(page)) return { messages, more: true, reset: false, probeBefore: null };
  // The latest page's `more` may only describe pages already loaded. Probe the
  // oldest loaded cursor to distinguish those pages from a new historical import.
  return { messages, more: earlierExists === true, reset: false, probeBefore: typeof earlierExists === 'boolean' ? null : oldest };
}

export function attachmentType(file) {
  const extension = String(file?.name || '').split('.').pop().toLowerCase();
  if (!FILE_MIMES[extension]) return '';
  const mime = String(file.type || '').toLowerCase().split(';')[0];
  if (mime === 'audio/x-m4a') return 'audio/mp4';
  if (mime === 'application/ogg') return 'audio/ogg';
  return ALLOWED_MIMES.has(mime) ? mime : (!mime || mime === 'application/octet-stream' ? FILE_MIMES[extension] : '');
}

export function attachmentError(file) {
  const mime = attachmentType(file);
  if (!mime) return 'Elegí un archivo JPEG, PNG, WEBP, PDF, MP3, OGG, M4A, AAC o MP4.';
  if (!file.size) return 'El archivo está vacío.';
  const limit = mime.startsWith('image/') ? 5 : 16;
  if (file.size > limit * 1024 * 1024) return `El máximo para este archivo es ${limit} MB.`;
  return '';
}

export function deliveryLabel(status) { return DELIVERY[status] || (status ? 'Estado pendiente de confirmar' : ''); }

export function captionError(mime, value) {
  if (!mime || !value.trim()) return '';
  if (mime.startsWith('audio/')) return 'El audio debe enviarse sin texto adjunto. Conservá el texto para una respuesta separada.';
  return value.trim().length > 1024 ? 'El texto que acompaña un archivo admite hasta 1024 caracteres.' : '';
}

if (typeof document !== 'undefined') start();

function start() {
  const $ = id => document.getElementById(id);
  const state = { actor: null, csrf: '', agents: [], numbers: [], web: null, threads: [], selected: null, thread: null, relatedWeb: [], messages: [], more: false, listMore: false, filter: 'all', channel: 'all', search: '', number: '', mode: 'reply', drafts: new Map(), operations: new Map(), messageNodes: new Map(), listSeq: 0, threadSeq: 0, selectionEpoch: 0, historyLoading: false, pollTimer: null, pollDelay: POLL_MIN, refreshing: false, identityRefreshing: false, presenceSeq: 0, presencePostAt: 0, presencePosting: false, storageKey: '', statusReady: false, dialogAction: null, lastListError: '', listPages: 1 };
  const text = value => value == null ? '' : String(value);
  const announce = value => { $('announcement').textContent = value; };
  const element = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content != null) node.textContent = text(content); return node; };
  const uuid = () => { if (!globalThis.crypto?.randomUUID) throw new Error('Se necesita una conexión HTTPS segura para operar.'); return crypto.randomUUID(); };
  const currentDraft = () => draftFor(state.selected);
  function draftFor(key) {
    if (!state.drafts.has(key)) state.drafts.set(key, { reply: '', note: '', file: null, uploaded: null });
    return state.drafts.get(key);
  }
  function setNotice(id, message, tone = 'atencion') {
    const node = $(id); node.hidden = !message; node.textContent = message || ''; node.className = `${id === 'global-notice' ? 'global-notice' : 'thread-notice'} ui-aviso ui-aviso--${tone}`;
  }
  function persist() {
    if (!state.storageKey) return;
    try {
      const drafts = [...state.drafts].filter(([, draft]) => draft.reply || draft.note).map(([key, draft]) => [key, { reply: draft.reply, note: draft.note }]);
      const operations = [...state.operations].filter(([, operation]) => operation.phase !== 'upload' || operation.file_hash).map(([key, operation]) => [key, { ...operation, payload: operation.phase === 'upload' ? { ...operation.payload, data_base64: undefined } : operation.payload, state: 'unknown' }]);
      sessionStorage.setItem(state.storageKey, JSON.stringify({ drafts, operations }));
    } catch { /* The in-memory draft is still retained when browser storage is full or disabled. */ }
  }
  function restore() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(state.storageKey) || '{}');
      for (const [key, draft] of Array.isArray(saved.drafts) ? saved.drafts : []) if (typeof key === 'string' && draft && typeof draft === 'object') state.drafts.set(key, { reply: text(draft.reply).slice(0, 4096), note: text(draft.note).slice(0, 4096), file: null, uploaded: null });
      for (const [key, operation] of Array.isArray(saved.operations) ? saved.operations : []) if (typeof key === 'string' && operation?.payload?.key === key && typeof operation.payload.request_id === 'string' && ['upload', 'command'].includes(operation.phase)) state.operations.set(key, { ...operation, state: 'unknown' });
    } catch { /* A corrupt local draft must not prevent reading the inbox. */ }
  }
  async function api(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf } : {}), ...options.headers } });
      let result;
      try { result = await response.json(); } catch { const error = new Error('El servidor devolvió una respuesta que no se pudo confirmar.'); error.status = response.status; error.ambiguous = true; throw error; }
      if (!response.ok || result.ok === false) {
        const error = new Error(errorMessage(result)); error.status = response.status; error.code = result.code; error.ambiguous = response.status >= 500 || response.status === 408;
        if (response.status === 401 || response.status === 403) setNotice('global-notice', response.status === 401 ? 'Tu sesión venció. Volvé a ingresar a Herramientas; el borrador se conserva en esta pestaña.' : error.message, 'critico');
        if ((response.status === 401 || response.status === 403) && path !== '/bootstrap') reloadIdentity();
        throw error;
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') { const timed = new Error('La conexión demoró demasiado.'); timed.ambiguous = true; throw timed; }
      if (error.status == null) error.ambiguous = true;
      throw error;
    } finally { clearTimeout(timer); }
  }
  const post = (path, payload) => api(path, { method: 'POST', body: JSON.stringify(payload) });
  function formatTime(value, short = false) {
    const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
    if (short && date.toDateString() === new Date().toDateString()) return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' }).format(date);
    return new Intl.DateTimeFormat('es-AR', short ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
  }
  function chip(label, tone) { return element('span', `ui-chip${tone ? ` ui-chip--${tone}` : ''}`, label); }
  function nameOf(thread) { return thread?.name || thread?.phone || (threadChannel(thread) === 'web' ? 'Visitante del chat web' : 'Contacto de WhatsApp'); }
  function numberLabel(thread) { return threadChannel(thread) === 'web' ? thread?.page_title || '' : thread?.number_label || state.numbers.find(number => String(number.number_id) === String(thread?.number_id))?.number_label || thread?.number_id || 'Número de negocio'; }
  function sourceLabel(thread) { return [...new Set([channelLabel(thread), numberLabel(thread)].filter(Boolean))].join(' · '); }
  function renderList() {
    const existing = new Map([...$('thread-list').children].map(node => [node.dataset.key, node]));
    const live = new Set();
    state.threads.forEach((thread, index) => {
      const key = text(thread.key); live.add(key); let card = existing.get(key);
      const signature = JSON.stringify(thread);
      if (!card) { card = element('button', 'thread-card'); card.type = 'button'; card.dataset.key = key; card.addEventListener('click', () => selectThread(key)); }
      if (card.dataset.signature !== signature) {
        const top = element('div', 'thread-card-top'); top.append(element('strong', '', nameOf(thread))); const time = element('time', '', formatTime(thread.updated_at, true)); if (thread.updated_at) time.dateTime = thread.updated_at; top.append(time);
        const bottom = element('div', 'thread-card-bottom'); bottom.append(element('span', '', thread.status === 'closed' ? `Cerrada · ${thread.owner_name || 'Sin responsable'}` : thread.owner_name || (thread.owner_id ? 'Responsable asignado' : 'Sin asignar')));
        if (Number(thread.unread) > 0) bottom.append(element('span', 'unread-count', `${thread.unread} sin leer`));
        card.replaceChildren(top, element('p', 'thread-preview', thread.preview || 'Sin mensajes de texto'), bottom, element('span', 'thread-channel', sourceLabel(thread)));
        card.dataset.signature = signature;
      }
      card.setAttribute('aria-current', key === state.selected ? 'true' : 'false');
      if ($('thread-list').children[index] !== card) $('thread-list').insertBefore(card, $('thread-list').children[index] || null);
    });
    for (const [key, node] of existing) if (!live.has(key)) node.remove();
    $('load-list').hidden = !state.listMore;
    $('list-state').classList.toggle('error', Boolean(state.lastListError));
    $('list-state').textContent = state.lastListError || (!state.threads.length ? (state.search || state.number || state.channel !== 'all' ? 'No hay conversaciones que coincidan con estos filtros.' : state.filter === 'mine' ? 'Todavía no tenés conversaciones asignadas.' : state.filter === 'closed' ? 'No hay conversaciones cerradas.' : state.filter === 'unassigned' ? 'No hay conversaciones esperando responsable.' : 'Todavía no hay conversaciones. Las consultas reales del chat web y de WhatsApp aparecerán acá.') : '');
    $('list-state').hidden = !$('list-state').textContent;
  }
  async function loadList({ more = false } = {}) {
    const seq = ++state.listSeq;
    const offset = more ? state.threads.length : 0;
    const queries = Array.from({ length: more ? 1 : state.listPages }, (_, index) => new URLSearchParams({ filter: state.filter, channel: state.channel, search: state.search, number: state.channel === 'web' ? '' : state.number, offset: text(more ? offset : index * 50), limit: '50' }));
    if (more) $('load-list').disabled = true;
    try {
      const pages = await Promise.all(queries.map(query => api(`/list?${query}`))); if (seq !== state.listSeq) return;
      const result = pages[pages.length - 1];
      const incoming = pages.flatMap(page => Array.isArray(page.threads) ? page.threads : []);
      const all = more ? [...state.threads, ...incoming] : incoming;
      state.threads = [...new Map(all.map(thread => [text(thread.key), thread])).values()];
      if (more) state.listPages = Math.max(1, Math.ceil(state.threads.length / 50));
      state.listMore = Boolean(result.more); state.lastListError = ''; renderList();
      for (const counter of document.querySelectorAll('[data-count]')) { const value = result.counts?.[counter.dataset.count]; counter.textContent = Number.isFinite(Number(value)) && value != null ? text(value) : ''; }
    } catch (error) { if (seq === state.listSeq) { state.lastListError = `No se pudo actualizar la bandeja. ${error.message}`; renderList(); } throw error; }
    finally { if (seq === state.listSeq) $('load-list').disabled = false; }
  }
  function renderStatus(result, allowPresence = true) {
    state.statusReady = true; state.numbers = Array.isArray(result.numbers) ? result.numbers : []; state.web = result.web && typeof result.web === 'object' ? result.web : null;
    const connected = state.numbers.filter(number => number.connected === true).length;
    const pending = state.numbers.filter(number => number.coexistence_pending).length;
    const webSummary = state.web?.connected === true ? 'Web disponible' : state.web?.connected === false ? 'Web pendiente' : 'Web sin confirmar';
    $('connection-summary').textContent = `${webSummary} · WhatsApp: ${state.numbers.length ? `${connected} de ${state.numbers.length} números conectados` : 'sin números confirmados'}${pending ? ' · Coexistencia pendiente' : ''}`;
    const metrics = result.metrics || {};
    $('metrics').textContent = [['open', 'abiertas'], ['unassigned', 'sin asignar'], ['pending', 'en cola'], ['errors', 'con error']].filter(([key]) => metrics[key] != null).map(([key, label]) => `${metrics[key]} ${label}`).join(' · ');
    const channels = state.numbers.map(number => {
      const node = element('div', 'channel'); node.append(element('strong', '', `WhatsApp · ${number.number_label || number.number || number.number_id || 'Número de negocio'}`));
      node.append(chip(number.connected ? '✓ Conectado' : number.status === 'disabled' ? 'Deshabilitado' : 'Conexión pendiente', number.connected ? 'ok' : ''));
      if (number.number) node.append(element('p', '', number.number));
      node.append(element('p', '', number.coexistence_pending ? 'Coexistencia pendiente de completar con el teléfono.' : (number.bot_enabled === false ? 'IA deshabilitada para este número.' : 'La atención usa el estado real de este número.')));
      return node;
    });
    const webCard = element('div', 'channel'); webCard.append(element('strong', '', 'Chat web'));
    webCard.append(chip(state.web?.connected === true ? '✓ Disponible' : state.web?.connected === false ? 'Atención pendiente de habilitar' : 'Estado pendiente', state.web?.connected === true ? 'ok' : ''));
    webCard.append(element('p', '', `${aiStateLabel({ channel: 'web' }, { web: state.web })}. El chat web admite respuestas de texto.`));
    $('channels').replaceChildren(webCard, ...channels);
    const desiredNumbers = [{ value: '', label: 'Todos los números' }, ...state.numbers.filter(number => number.number_id).map(number => ({ value: text(number.number_id), label: text(number.number_label || number.number || number.number_id) }))];
    $('number').disabled = state.channel === 'web' || desiredNumbers.length === 1;
    if (JSON.stringify(desiredNumbers) !== $('number').dataset.signature) {
      $('number').replaceChildren(...desiredNumbers.map(number => { const option = element('option', '', number.label); option.value = number.value; return option; })); $('number').value = state.number; $('number').dataset.signature = JSON.stringify(desiredNumbers);
    }
    const agents = Array.isArray(result.agents) ? result.agents : [];
    const ownPresence = agents.find(agent => String(agent.id) === String(state.actor?.id));
    if (allowPresence && ownPresence && PRESENCE[ownPresence.status] && !state.presencePosting && !$('presence').disabled && document.activeElement !== $('presence')) { $('presence').value = ownPresence.status; $('presence').dataset.confirmed = ownPresence.status; }
    const team = element('ul'); for (const agent of agents) team.append(element('li', '', `${agent.name || 'Agente'} · ${PRESENCE[agent.status] || 'Sin presencia confirmada'}`));
    $('team-status').replaceChildren(element('strong', '', 'Equipo'), ...(agents.length ? [team] : [element('p', '', 'Sin presencias registradas.') ]));
    renderThreadBadges();
  }
  async function loadStatus() {
    const seq = state.presenceSeq;
    try { renderStatus(await api('/status'), seq === state.presenceSeq); }
    catch (error) { state.statusReady = false; $('connection-summary').textContent = 'No se pudo confirmar el estado de los canales'; renderThreadBadges(); throw error; }
  }
  async function selectThread(key) {
    if (state.selected === key && state.thread) { $('workspace').classList.add('has-selection'); return; }
    saveText(); state.selectionEpoch++; state.threadSeq++; state.selected = key; state.thread = null; state.relatedWeb = []; state.messages = []; state.messageNodes.clear(); state.more = false; state.historyLoading = false; state.mode = 'reply';
    $('workspace').classList.add('has-selection'); $('welcome').hidden = true; $('thread-view').hidden = false; $('messages').replaceChildren(); $('history-state').textContent = 'Cargando historial…'; $('contact-name').textContent = nameOf(state.threads.find(thread => text(thread.key) === key)); $('contact-meta').textContent = '';
    $('thread-badges').replaceChildren(); $('ownership').textContent = ''; $('web-context').hidden = true; $('copy-phone').disabled = true;
    setNotice('thread-notice', ''); restoreComposer(); renderPermissions(); renderList(); renderPending();
    try { await loadThread({ initial: true }); if (state.selected === key) $('contact-name').focus({ preventScroll: true }); }
    catch (error) { if (state.selected === key) { $('history-state').textContent = 'No se pudo cargar el historial.'; setNotice('thread-notice', error.message, 'critico'); } }
  }
  async function loadThread({ initial = false, older = false } = {}) {
    const key = state.selected; if (!key || state.historyLoading) return;
    const epoch = state.selectionEpoch; const seq = ++state.threadSeq;
    const query = new URLSearchParams({ key });
    if (older) { const before = oldestMessageId(state.messages); if (!before || state.historyLoading) return; state.historyLoading = true; query.set('before', before); $('load-older').disabled = true; }
    try {
      const result = await api(`/thread?${query}`);
      if (key !== state.selected || epoch !== state.selectionEpoch || seq !== state.threadSeq) return;
      if (!result.thread) throw new Error('No se encontró esta conversación.');
      if (!older && state.thread && Number(result.thread.revision) < Number(state.thread.revision)) return;
      const incoming = Array.isArray(result.messages) ? result.messages : [];
      const pagination = { more: result.more, knownMore: state.more, older };
      let history = reconcileHistoryPage(state.messages, incoming, pagination);
      if (history.probeBefore) {
        const probe = await api(`/thread?${new URLSearchParams({ key, before: history.probeBefore })}`);
        if (key !== state.selected || epoch !== state.selectionEpoch || seq !== state.threadSeq) return;
        history = reconcileHistoryPage(state.messages, incoming, { ...pagination, earlierExists: Array.isArray(probe.messages) && probe.messages.length > 0 });
      }
      if (!state.thread || Number(result.thread.revision) >= Number(state.thread.revision)) state.thread = result.thread;
      if (!older && Array.isArray(result.related_web)) state.relatedWeb = result.related_web;
      state.messages = history.messages; state.more = history.more;
      reconcileOperation(key);
      renderThread(); renderMessages({ initial: initial || history.reset, older }); renderPending();
      $('history-state').textContent = history.reset && history.more ? 'Se cargaron los mensajes más recientes. Usá Cargar mensajes anteriores para recuperar el tramo previo.' : state.messages.length ? '' : 'Esta conversación todavía no tiene mensajes.';
    } finally { if (older && key === state.selected && epoch === state.selectionEpoch) { state.historyLoading = false; $('load-older').disabled = false; } }
  }
  function renderWebContext() {
    const related = state.relatedWeb;
    const records = [...(threadChannel(state.thread) === 'web' && (state.thread.page_title || state.thread.page_url || state.thread.handoff_reason) ? [state.thread] : []), ...(Array.isArray(related) ? related : related ? [related] : [])];
    $('web-context').hidden = !records.length;
    if (!records.length) return;
    const nodes = [];
    for (const item of records) {
      if (typeof item === 'string') nodes.push(element('p', '', item));
      else if (item && typeof item === 'object') {
        if (item.summary || item.text || item.preview) nodes.push(element('p', '', item.summary || item.text || item.preview));
        if (item.page_title || item.context?.page_title) nodes.push(element('p', '', `Consulta desde: ${item.page_title || item.context.page_title}`));
        const pageUrl = safePageUrl(item.page_url || item.context?.page_url);
        if (pageUrl) { const paragraph = element('p'); const link = element('a', '', pageUrl); link.href = pageUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; paragraph.append(link); nodes.push(paragraph); }
        if (item.handoff_reason || item.reason || item.context?.handoff_reason) nodes.push(element('p', '', `Motivo de derivación: ${item.handoff_reason || item.reason || item.context.handoff_reason}`));
        for (const message of Array.isArray(item.messages) ? item.messages.slice(-10) : []) nodes.push(element('p', '', `${message.sender === 'customer' || message.role === 'user' ? 'Cliente' : 'Asistente'}: ${message.text || message.content || ''}`));
      }
    }
    if (!nodes.length) nodes.push(element('p', 'meta', 'Hay una consulta web vinculada. Su resumen todavía no está disponible.'));
    $('web-context-content').replaceChildren(...nodes);
  }
  function renderThreadBadges() {
    const thread = state.thread; if (!thread) return;
    const ia = aiStateLabel(thread, state.statusReady ? { numbers: state.numbers, web: state.web } : null);
    const badges = [chip(channelLabel(thread)), chip(thread.status === 'closed' ? 'Cerrada' : 'Abierta'), chip(ia)];
    for (const label of Array.isArray(thread.labels) ? thread.labels : []) badges.push(chip(typeof label === 'string' ? label : label.name || label.label || ''));
    $('thread-badges').replaceChildren(...badges);
  }
  function renderThread() {
    const thread = state.thread; if (!thread) return;
    $('contact-name').textContent = nameOf(thread);
    $('contact-meta').textContent = [thread.phone || 'Teléfono no informado', sourceLabel(thread)].filter(Boolean).join(' · ');
    $('copy-phone').disabled = !thread.phone;
    renderThreadBadges();
    $('ownership').textContent = thread.owner_id ? `Responsable: ${thread.owner_name || (String(thread.owner_id) === String(state.actor?.id) ? state.actor.name : 'Agente asignado')}` : thread.status === 'closed' ? 'Sin responsable · Conversación cerrada' : 'Sin responsable · Tomá la conversación para atenderla';
    $('load-older').hidden = !state.more; renderWebContext(); renderPermissions();
  }
  function renderPermissions() {
    const access = permissions(state.actor, state.thread); const pending = state.operations.has(state.selected); const closed = state.thread?.status === 'closed';
    const web = threadChannel(state.thread) === 'web'; const canAttach = mediaAllowed(state.thread);
    for (const action of ['take', 'transfer', 'release', 'close', 'reopen', 'pause', 'resume']) {
      const visible = action === 'take' ? access.take : action === 'transfer' ? access.manage && !closed : action === 'release' ? access.manage && Boolean(state.thread?.owner_id) : action === 'close' ? access.manage && !closed : action === 'reopen' ? access.control && closed : action === 'pause' ? access.control && !state.thread?.bot_paused : access.control && !closed && Boolean(state.thread?.bot_paused);
      $(action).hidden = !visible; $(action).disabled = pending;
    }
    const note = state.mode === 'note'; const canCompose = note ? access.note : access.send;
    $('reply-mode').setAttribute('aria-pressed', text(!note)); $('note-mode').setAttribute('aria-pressed', text(note)); $('note-mode').disabled = !access.write;
    $('composer').classList.toggle('is-note', note); $('message-input').disabled = !canCompose; $('message-input').placeholder = note ? 'Escribí una nota para el equipo…' : web ? 'Escribí tu respuesta para el chat web…' : 'Escribí tu respuesta…';
    document.querySelector('label[for="message-input"]').textContent = note ? 'Escribir nota privada' : web ? 'Escribir respuesta para el chat web' : 'Escribir respuesta para WhatsApp';
    $('send').textContent = note ? 'Guardar nota' : web ? 'Responder en el chat web' : 'Enviar respuesta';
    const draft = currentDraft(); const caption = note ? '' : !canAttach && (draft.file || draft.uploaded) ? 'Este canal no admite archivos. Quitá el adjunto para responder con texto.' : captionError(draft.uploaded?.mime || (draft.file ? attachmentType(draft.file) : ''), text(draft.reply));
    $('send').disabled = !canCompose || pending || Boolean(caption) || (!text(draft[state.mode]).trim() && (note || !draft.file && !draft.uploaded));
    $('attach').hidden = note || !access.write; $('attach').disabled = !access.send || !canAttach || pending; $('attach').title = canAttach ? 'Adjuntar archivo' : 'Este canal admite solo texto'; $('file-input').disabled = !access.send || !canAttach || pending; $('remove-file').disabled = pending;
    $('attachment').hidden = note || (!draft.file && !draft.uploaded); $('attachment-name').textContent = draft.file ? `${draft.file.name} · ${formatBytes(draft.file.size)}` : draft.uploaded?.name || '';
    $('file-help').hidden = note; $('file-help').textContent = canAttach ? 'Imagen, audio, video o PDF' : 'Este canal admite solo texto';
    $('window-status').textContent = state.thread ? (web ? 'Chat web' : sendWindow(state.thread).allowed ? '24 h · Atención abierta' : 'Texto libre no disponible') : '';
    $('composer-help').textContent = !state.thread ? 'Elegí una conversación para comenzar.' : !access.write ? 'Tu acceso permite consultar el historial. No permite responder, adjuntar ni cambiar la atención.' : !access.manage ? (state.thread.owner_id ? 'Esta conversación la atiende otra persona. Podés consultar su historial.' : 'Tomá esta conversación antes de responder o agregar notas.') : note ? 'Solo el equipo verá esta nota. No se envía al cliente.' : closed ? 'La conversación está cerrada. Reabrila para responder.' : !sendWindow(state.thread).allowed ? sendWindow(state.thread).label : pending ? 'Hay una operación pendiente de confirmar. El borrador se conserva.' : caption || (web ? 'La respuesta llega a este chat web. Por ahora admite solo texto.' : 'La respuesta se envía desde el número de negocio de esta conversación.');
  }
  function formatBytes(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
  function makeMessage(message) {
    const note = message.sender === 'note' || message.kind === 'note'; const outbound = ['operator', 'bot', 'agent', 'human'].includes(message.sender); const system = message.sender === 'system';
    const node = element('article', `message${note ? ' note' : outbound ? ' outbound' : system ? ' system' : ''}`); node.setAttribute('role', 'listitem'); node.dataset.id = text(message.id);
    node.append(element('span', 'message-author', note ? `Nota privada · ${message.agent_name || 'Equipo'}` : message.sender === 'bot' ? message.agent_name || 'Asistente IA' : outbound ? message.agent_name || 'Atención humana' : system ? 'Actividad' : nameOf(state.thread)));
    if (message.revoked || message.text) node.append(element('p', 'message-text', message.revoked ? `Mensaje eliminado en ${channelLabel(state.thread)}.` : message.text));
    if (message.edited && !message.revoked) node.append(element('span', 'meta', `Editado en ${channelLabel(state.thread)}`));
    if (message.media_id && !message.revoked) {
      const url = `${API}/media/${encodeURIComponent(message.media_id)}`; const mime = text(message.mime); const kind = text(message.kind);
      if (mime.startsWith('image/') || kind === 'image') { const link = element('a', 'media-preview'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; const image = element('img', 'message-media'); image.src = url; image.alt = message.file_name || 'Imagen adjunta'; image.loading = 'lazy'; image.referrerPolicy = 'same-origin'; link.append(image); node.append(link); }
      else if (mime.startsWith('audio/') || kind === 'audio' || mime.startsWith('video/') || kind === 'video') { const media = element(mime.startsWith('audio/') || kind === 'audio' ? 'audio' : 'video', 'message-media'); media.controls = true; media.preload = 'none'; media.src = url; if (media.tagName === 'VIDEO') media.playsInline = true; media.setAttribute('aria-label', message.file_name || 'Archivo adjunto'); node.append(media); }
      const download = element('a', 'media-download', `↓ ${message.file_name || (mime === 'application/pdf' ? 'Descargar PDF' : 'Descargar archivo')}`); download.href = url; download.download = message.file_name || ''; download.target = '_blank'; download.rel = 'noopener'; node.append(download);
    }
    const footer = element('div', 'message-footer'); const date = element('time', '', formatTime(message.created_at)); if (message.created_at) date.dateTime = message.created_at; footer.append(date);
    if (outbound && !note) { footer.append(element('span', `message-status ${message.status === 'unknown' || message.status === 'failed' || message.status === 'read' ? message.status : ''}`, deliveryLabel(message.status))); }
    node.append(footer);
    if (outbound && ['unknown', 'failed', 'cancelled'].includes(message.status)) node.append(element('p', 'delivery-help', message.status === 'unknown' ? 'El proveedor no confirmó el resultado. Verificá la entrega antes de enviar otro mensaje; no se reenvía automáticamente.' : message.status === 'cancelled' ? 'El envío fue cancelado antes de completarse. Revisá la atención de esta conversación antes de preparar otro mensaje.' : 'Este envío falló. Revisá el estado y el contenido antes de preparar un nuevo envío.'));
    return node;
  }
  function renderMessages({ initial = false, older = false } = {}) {
    const history = $('history'); const oldHeight = history.scrollHeight; const oldTop = history.scrollTop; const atBottom = oldHeight - history.clientHeight - oldTop < 90;
    const liveIds = new Set(state.messages.map(message => text(message.id)));
    for (const [id, record] of state.messageNodes) if (!liveIds.has(id)) { record.node.remove(); state.messageNodes.delete(id); }
    let newCount = 0;
    state.messages.forEach((message, index) => {
      const id = text(message.id); const signature = JSON.stringify(message); let record = state.messageNodes.get(id);
      if (!record) { record = { node: makeMessage(message), signature }; state.messageNodes.set(id, record); newCount++; }
      else if (record.signature !== signature) {
        const contentSignature = JSON.stringify({ ...message, status: undefined });
        if (record.contentSignature === contentSignature && !['unknown', 'failed', 'cancelled'].includes(record.status) && !['unknown', 'failed', 'cancelled'].includes(message.status)) { const status = record.node.querySelector('.message-status'); if (status) { status.textContent = deliveryLabel(message.status); status.className = `message-status ${message.status === 'read' ? 'read' : ''}`; } }
        else { const replacement = makeMessage(message); record.node.replaceWith(replacement); record.node = replacement; }
        record.signature = signature;
      }
      record.contentSignature = JSON.stringify({ ...message, status: undefined }); record.status = message.status;
      if ($('messages').children[index] !== record.node) $('messages').insertBefore(record.node, $('messages').children[index] || null);
    });
    if (older) history.scrollTop = oldTop + history.scrollHeight - oldHeight;
    else if (initial || atBottom) history.scrollTop = history.scrollHeight;
    if (!initial && !older && newCount) announce(`${newCount} ${newCount === 1 ? 'mensaje nuevo' : 'mensajes nuevos'} en la conversación.`);
  }
  function saveText() { if (state.selected) { currentDraft()[state.mode] = $('message-input').value; persist(); } }
  function restoreComposer() { $('message-input').value = currentDraft()[state.mode] || ''; $('file-input').value = ''; renderPermissions(); }
  function switchMode(mode) { if (state.mode === mode) return; saveText(); state.mode = mode; restoreComposer(); if (!$('message-input').disabled) $('message-input').focus(); }
  function operationDescription(operation) {
    const action = operation.payload.action;
    if (operation.phase === 'upload') return `Archivo: ${operation.payload.name}`;
    if (action === 'send') return `${operation.payload.text || ''}${operation.payload.media_id ? '\nArchivo adjunto' : ''}`.trim();
    if (action === 'note') return `Nota privada: ${operation.payload.text}`;
    return { take: 'Tomar conversación', transfer: 'Transferir conversación', release: 'Liberar conversación', close: 'Cerrar conversación', reopen: 'Reabrir conversación', pause: 'Pausar IA', resume: 'Reanudar IA' }[action] || 'Cambio en la conversación';
  }
  function renderPending() {
    const operation = state.operations.get(state.selected); const box = $('pending-operation'); box.hidden = !operation;
    if (!operation) { box.replaceChildren(); return; }
    const signature = JSON.stringify({ phase: operation.phase, state: operation.state, request_id: operation.payload.request_id, message: operation.error, actor: state.actor?.id, role: state.actor?.role });
    if (box.dataset.signature === signature && box.dataset.key === state.selected) return;
    box.dataset.signature = signature; box.dataset.key = state.selected;
    const nodes = [element('strong', '', operation.state === 'pending' ? 'Confirmando operación…' : 'Resultado sin confirmar'), element('p', '', operationDescription(operation))];
    if (operation.state === 'unknown') {
      nodes.push(element('p', '', `${operation.error || 'Se interrumpió la conexión.'} El borrador se conserva. Verificar consulta la misma operación con su identificador original; no crea otro envío.`));
      if (operation.phase === 'upload' && !operation.payload.data_base64) {
        nodes.push(element('p', '', 'Volvé a seleccionar el mismo archivo para verificar la carga pendiente.'));
        const file = element('input', 'ui-input'); file.type = 'file'; file.disabled = !permissions(state.actor, state.thread).write; file.setAttribute('aria-label', 'Seleccionar el archivo de la carga pendiente'); file.addEventListener('change', () => restoreUploadFile(operation, file.files?.[0])); nodes.push(file);
      } else { const button = element('button', 'ui-btn', 'Verificar operación'); button.type = 'button'; button.addEventListener('click', () => verifyOperation(state.selected)); button.disabled = !permissions(state.actor, state.thread).write; nodes.push(button); }
    }
    box.replaceChildren(...nodes);
  }
  function reconcileOperation(key) {
    const operation = state.operations.get(key); if (!operation || operation.phase !== 'command' || !['send', 'note'].includes(operation.payload.action)) return;
    const confirmed = state.messages.find(message => message.request_id === operation.payload.request_id);
    if (confirmed) finishOperation(key, operation, { thread: state.thread, message: confirmed });
  }
  function finishOperation(key, operation, result) {
    if (state.operations.get(key)?.payload.request_id !== operation.payload.request_id) return;
    state.operations.delete(key);
    const draft = draftFor(key);
    if (operation.payload.action === 'send' || operation.payload.action === 'note') {
      const mode = operation.payload.action === 'note' ? 'note' : 'reply';
      if (draft[mode] === operation.snapshot) draft[mode] = '';
      if (operation.payload.action === 'send' && operation.payload.media_id) { draft.file = null; draft.uploaded = null; }
    }
    if (state.selected === key) {
      state.threadSeq++;
      if (result.thread && (!state.thread || Number(result.thread.revision) >= Number(state.thread.revision))) state.thread = result.thread;
      if (result.message) state.messages = mergeMessages(state.messages, [result.message]);
      if (operation.snapshot === $('message-input').value && (operation.payload.action === 'send' && state.mode === 'reply' || operation.payload.action === 'note' && state.mode === 'note')) $('message-input').value = draft[state.mode];
      renderThread(); renderMessages(); renderPending();
      setNotice('thread-notice', operation.payload.action === 'send' ? 'Mensaje registrado. Su estado de entrega aparece en el historial.' : operation.payload.action === 'note' ? 'Nota privada guardada.' : 'Conversación actualizada.', 'ok');
    }
    persist(); announce(operation.payload.action === 'send' ? 'Mensaje registrado.' : 'Operación confirmada.');
  }
  async function runOperation(key, operation) {
    if (!permissions(state.actor, null).write || operation.actor_id && operation.actor_id !== state.actor?.id) return;
    operation.actor_id = state.actor.id;
    const verifyingUnknown = operation.state === 'unknown';
    operation.state = 'pending'; operation.error = ''; state.operations.set(key, operation); persist();
    if (state.selected === key) { renderPending(); renderPermissions(); }
    try {
      const result = await post(operation.phase === 'upload' ? '/upload' : '/command', operation.payload);
      if (state.operations.get(key)?.payload.request_id !== operation.payload.request_id || operation.actor_id !== state.actor?.id) return;
      if (operation.phase === 'upload') {
        if (!result.media_id) { const error = new Error('No llegó la confirmación del archivo.'); error.ambiguous = true; throw error; }
        const draft = draftFor(key); draft.uploaded = { media_id: result.media_id, name: result.name || operation.payload.name, mime: result.mime || operation.payload.mime };
        state.operations.delete(key); persist();
        const next = { phase: 'command', state: 'pending', actor_id: operation.actor_id, snapshot: operation.snapshot, payload: { key, request_id: operation.send_request_id, revision: operation.revision, action: 'send', text: operation.snapshot.trim(), media_id: result.media_id } };
        await runOperation(key, next);
      } else {
        if (!result.thread) { const error = new Error('No llegó la confirmación de la conversación.'); error.ambiguous = true; throw error; }
        finishOperation(key, operation, result); loadList().catch(() => {});
      }
    } catch (error) {
      if (state.operations.get(key)?.payload.request_id !== operation.payload.request_id) return;
      const unresolved = error.ambiguous || verifyingUnknown && (error.status === 401 || error.status === 403 || error.code === 'idempotency_conflict');
      if (unresolved) { operation.state = 'unknown'; operation.error = error.message; persist(); }
      else { state.operations.delete(key); persist(); if (state.selected === key) setNotice('thread-notice', `${error.message} El borrador se conserva.`, 'critico'); }
      if (state.selected === key) { renderPending(); renderPermissions(); if (!unresolved) loadThread().catch(() => {}); }
    }
  }
  async function verifyOperation(key) {
    if (!permissions(state.actor, null).write) return;
    const operation = state.operations.get(key); if (!operation || operation.state !== 'unknown') return;
    if (state.selected === key) { try { await loadThread(); } catch { /* The idempotent lookup below retains the exact request. */ } }
    if (!state.operations.has(key)) return;
    await runOperation(key, operation);
  }
  async function restoreUploadFile(operation, file) {
    if (!file || !permissions(state.actor, null).write) return;
    if (file.name !== operation.payload.name || file.size !== operation.file_size || attachmentType(file) !== operation.payload.mime) { setNotice('thread-notice', 'El archivo no coincide con la carga pendiente. Elegí el mismo nombre, tipo y tamaño.', 'critico'); return; }
    try { const data = await fileBase64(file); if (operation.file_hash && await contentHash(data) !== operation.file_hash) throw new Error('El contenido no coincide con el archivo original.'); operation.payload.data_base64 = data; draftFor(operation.payload.key).file = file; $('pending-operation').dataset.signature = ''; renderPending(); }
    catch (error) { setNotice('thread-notice', error.message, 'critico'); }
  }
  async function fileBase64(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(text(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('No se pudo leer el archivo.')); reader.readAsDataURL(file); });
  }
  async function contentHash(value) { const bytes = new TextEncoder().encode(value); const hash = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
  async function submitMessage(event) {
    event.preventDefault(); saveText(); const key = state.selected; const thread = state.thread; if (!key || !thread || state.operations.has(key)) return;
    const access = permissions(state.actor, thread); const mode = state.mode; const draft = currentDraft(); const snapshot = draft[mode];
    if (!(mode === 'note' ? access.note : access.send) || (!snapshot.trim() && (mode === 'note' || !draft.file && !draft.uploaded))) return;
    if (mode === 'reply' && (draft.file || draft.uploaded) && !mediaAllowed(thread)) { setNotice('thread-notice', 'Este canal no admite archivos. Quitá el adjunto para responder con texto.', 'critico'); return; }
    const invalidCaption = mode === 'note' ? '' : captionError(draft.uploaded?.mime || (draft.file ? attachmentType(draft.file) : ''), snapshot);
    if (invalidCaption) { setNotice('thread-notice', invalidCaption, 'critico'); return; }
    setNotice('thread-notice', '');
    try {
      if (mode === 'reply' && draft.file && !draft.uploaded) {
        const error = attachmentError(draft.file); if (error) throw new Error(error);
        const operation = { phase: 'upload', state: 'pending', snapshot, revision: thread.revision, send_request_id: uuid(), file_size: draft.file.size, payload: { key, request_id: uuid(), name: draft.file.name, mime: attachmentType(draft.file) } };
        state.operations.set(key, operation); renderPending(); renderPermissions();
        try { operation.payload.data_base64 = await fileBase64(draft.file); operation.file_hash = await contentHash(operation.payload.data_base64); }
        catch (error) { state.operations.delete(key); renderPending(); renderPermissions(); throw error; }
        await runOperation(key, operation);
      } else await runOperation(key, { phase: 'command', state: 'pending', snapshot, payload: { key, request_id: uuid(), revision: thread.revision, action: mode === 'note' ? 'note' : 'send', text: snapshot.trim(), ...(mode === 'reply' && draft.uploaded ? { media_id: draft.uploaded.media_id } : {}) } });
    } catch (error) { if (state.selected === key) setNotice('thread-notice', error.message, 'critico'); }
  }
  function openAction(action) {
    if (!state.thread || state.operations.has(state.selected)) return;
    const access = permissions(state.actor, state.thread); if (!(action === 'take' ? access.take : ['pause', 'resume', 'reopen'].includes(action) ? access.control : access.manage)) return;
    if (action === 'take' || action === 'pause' || action === 'reopen') { issueCommand(action); return; }
    const descriptions = {
      transfer: ['Transferir conversación', 'La persona elegida será responsable de continuar la atención. La IA permanece pausada.', 'Transferir'],
      release: ['Liberar conversación', 'La conversación quedará sin responsable. La IA seguirá pausada hasta que alguien elija Reanudar IA.', 'Liberar'],
      close: ['Cerrar conversación', 'Quedará en Cerradas. Si el cliente vuelve a escribir, la conversación se abrirá nuevamente.', 'Cerrar conversación'],
      resume: ['Reanudar IA', threadChannel(state.thread) === 'web' ? 'La conversación quedará sin responsable y se quitará su pausa de IA. Se mantienen los controles globales y del chat web: la IA responderá solo si están habilitados y el canal está disponible. Esta acción no habilita el control global ni envía un mensaje ahora.' : 'La conversación quedará sin responsable y se quitará su pausa de IA. Se mantienen los controles globales y del número: la IA responderá solo si están habilitados y el número está conectado. Esta acción no habilita el control global ni envía un mensaje ahora.', 'Reanudar IA']
    };
    const [title, description, button] = descriptions[action]; state.dialogAction = { action, key: state.selected, revision: state.thread.revision };
    $('dialog-title').textContent = title; $('dialog-description').textContent = description; $('dialog-confirm').textContent = button; $('dialog-error').hidden = true; $('transfer-field').hidden = action !== 'transfer'; $('transfer-target').required = action === 'transfer';
    const targets = state.agents.filter(agent => String(agent.id) !== String(state.thread.owner_id));
    $('transfer-target').replaceChildren(...targets.map(agent => { const option = element('option', '', agent.name); option.value = agent.id; return option; }));
    $('dialog-confirm').disabled = action === 'transfer' && !targets.length;
    if (action === 'transfer' && !targets.length) { $('dialog-error').hidden = false; $('dialog-error').textContent = 'No hay otro agente activo con permiso para atender.'; }
    $('action-dialog').showModal();
  }
  async function issueCommand(action, target, context = null) {
    const key = context?.key || state.selected; if (!key || state.operations.has(key)) return;
    try { await runOperation(key, { phase: 'command', state: 'pending', payload: { key, request_id: uuid(), revision: context?.revision ?? state.thread.revision, action, ...(target ? { target: { id: target.id, name: target.name } } : {}) } }); }
    catch (error) { if (key === state.selected) setNotice('thread-notice', error.message, 'critico'); }
  }
  async function reloadIdentity() {
    if (state.identityRefreshing) return;
    state.identityRefreshing = true;
    try {
      const result = await api('/bootstrap');
      if (!result.actor?.id || !ROLES[result.actor.role]) throw new Error('No se pudo confirmar el acceso de tu sesión.');
      const storageKey = `mensajeria-drafts-v1:${result.actor.id}`;
      const changedActor = state.storageKey && state.storageKey !== storageKey;
      if (changedActor) { persist(); state.drafts = new Map(); state.operations = new Map(); state.storageKey = storageKey; restore(); }
      state.actor = result.actor; state.csrf = result.csrf || ''; state.agents = Array.isArray(result.agents) ? result.agents : [];
      $('actor-name').textContent = state.actor.name; $('actor-role').textContent = ROLES[state.actor.role]; $('presence-field').hidden = !permissions(state.actor, null).write; $('team').hidden = state.actor.role !== 'supervisor';
      if (state.actor.role !== 'supervisor') $('team-dialog').close();
      if (changedActor) restoreComposer();
      renderPermissions(); renderPending();
    } catch (error) {
      state.actor = null; state.csrf = ''; clearTimeout(state.pollTimer); $('team-dialog').close(); $('team').hidden = true; $('presence-field').hidden = true; $('actor-role').textContent = 'Acceso pendiente de confirmar'; renderPermissions(); renderPending(); setNotice('global-notice', error.message, 'critico');
    } finally { state.identityRefreshing = false; }
  }
  function renderTeam(users) {
    $('team-roster').replaceChildren(...users.map(user => {
      const row = element('div', 'team-row'); const name = element('strong', '', user.name); const select = element('select', 'ui-input'); select.setAttribute('aria-label', `Rol de ${user.name}`);
      for (const [value, label] of [['none', 'Sin acceso'], ['reader', 'Consulta'], ['agent', 'Agente'], ['supervisor', 'Supervisión']]) { const option = element('option', '', label); option.value = value; select.append(option); }
      select.value = user.role || 'none'; const save = element('button', 'ui-btn', 'Guardar'); save.type = 'button'; save.disabled = true;
      select.addEventListener('change', () => { save.disabled = select.value === user.role; });
      save.addEventListener('click', async () => {
        save.disabled = true; select.disabled = true; $('team-feedback').textContent = `Guardando acceso de ${user.name}…`;
        try { const result = await post(`/team/${encodeURIComponent(user.user_id)}`, { role: select.value }); if (Array.isArray(result.agents)) state.agents = result.agents; renderTeam(Array.isArray(result.users) ? result.users : []); $('team-feedback').textContent = `Acceso de ${user.name} actualizado.`; await reloadIdentity(); }
        catch (error) { $('team-feedback').textContent = error.message; select.disabled = false; save.disabled = false; }
      });
      row.append(name, select, save); return row;
    }));
  }
  async function openTeam() {
    if (state.actor?.role !== 'supervisor') return;
    $('team-roster').replaceChildren(); $('team-feedback').textContent = 'Cargando equipo…'; $('team-dialog').showModal();
    try { const result = await api('/team'); renderTeam(Array.isArray(result.users) ? result.users : []); $('team-feedback').textContent = ''; }
    catch (error) { $('team-feedback').textContent = error.message; }
  }
  function schedulePoll() { clearTimeout(state.pollTimer); if (!document.hidden && state.actor) state.pollTimer = setTimeout(refresh, state.pollDelay); }
  async function sendPresence(status) {
    const preceding = state.presencePromise || Promise.resolve();
    const request = preceding.catch(() => {}).then(() => post('/presence', { status }));
    state.presencePromise = request;
    try { return await request; } finally { if (state.presencePromise === request) state.presencePromise = null; }
  }
  async function maintainPresence() {
    const status = $('presence').dataset.confirmed;
    if (document.hidden || !permissions(state.actor, null).write || state.presencePosting || $('presence').disabled || !['available', 'busy'].includes(status) || Date.now() - state.presencePostAt < 30000) return;
    state.presencePosting = true; state.presencePostAt = Date.now();
    try { await sendPresence(status); }
    catch { /* The connection indicator reports refresh failures; stale presence expires on the server. */ }
    finally { state.presencePosting = false; }
  }
  async function refresh() {
    if (document.hidden || state.refreshing || !state.actor) return;
    state.refreshing = true; $('refresh').disabled = true;
    try {
      const results = await Promise.allSettled([loadList(), loadStatus(), state.selected ? loadThread() : Promise.resolve()]);
      const failed = results.some(result => result.status === 'rejected'); state.pollDelay = failed ? Math.min(POLL_MAX, state.pollDelay * 2) : POLL_MIN;
      $('sync-state').textContent = failed ? `Conexión intermitente · Reintento en ${state.pollDelay / 1000} s` : `Actualizado ${formatTime(new Date().toISOString(), true)}`;
      if (!failed) await maintainPresence();
    } finally { state.refreshing = false; $('refresh').disabled = false; schedulePoll(); }
  }
  async function bootstrap() {
    $('refresh').disabled = true;
    try {
      const result = await api('/bootstrap');
      if (!result.actor?.id || !ROLES[result.actor.role]) throw new Error('No se pudo confirmar el acceso de tu sesión.');
      state.actor = result.actor; state.csrf = result.csrf || ''; state.agents = Array.isArray(result.agents) ? result.agents : [];
      const storageKey = `mensajeria-drafts-v1:${state.actor.id}`;
      if (state.storageKey && state.storageKey !== storageKey) { persist(); state.drafts = new Map(); state.operations = new Map(); }
      state.storageKey = storageKey; restore();
      $('actor-name').textContent = state.actor.name; $('actor-role').textContent = ROLES[state.actor.role]; $('presence-field').hidden = !permissions(state.actor, null).write; $('team').hidden = state.actor.role !== 'supervisor';
      $('presence').value = result.presence?.status || 'offline'; $('presence').dataset.confirmed = $('presence').value;
      setNotice('global-notice', state.actor.role === 'reader' ? 'Acceso de consulta: podés revisar conversaciones y estados.' : '', 'info');
      if (state.selected) restoreComposer(); renderPermissions(); renderPending(); await refresh();
    } catch (error) { $('actor-name').textContent = 'Sesión no disponible'; $('actor-role').textContent = ''; $('list-state').textContent = 'No se pudo abrir la bandeja.'; setNotice('global-notice', error.message, 'critico'); }
    finally { $('refresh').disabled = false; }
  }
  $('refresh').addEventListener('click', () => state.actor ? refresh() : bootstrap());
  let searchTimer;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = $('search').value.trim(); resetList(); }, 350); });
  $('channel').addEventListener('change', () => { state.channel = $('channel').value; state.number = ''; $('number').value = ''; $('number-field').hidden = state.channel === 'web'; $('number').disabled = state.channel === 'web' || !state.numbers.some(number => number.number_id); resetList(); });
  $('number').addEventListener('change', () => { state.number = $('number').value; if (state.number) { state.channel = 'whatsapp'; $('channel').value = 'whatsapp'; } resetList(); });
  function resetList() { state.listSeq++; state.listPages = 1; state.threads = []; state.listMore = false; state.lastListError = ''; $('thread-list').replaceChildren(); $('list-state').hidden = false; $('list-state').textContent = 'Buscando conversaciones…'; loadList().catch(() => {}); }
  $('filters').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (!button || button.dataset.filter === state.filter) return; state.filter = button.dataset.filter; for (const tab of $('filters').querySelectorAll('button')) tab.setAttribute('aria-pressed', text(tab === button)); resetList(); });
  $('load-list').addEventListener('click', () => loadList({ more: true }).catch(() => {}));
  $('load-older').addEventListener('click', () => loadThread({ older: true }).catch(error => setNotice('thread-notice', error.message, 'critico')));
  $('back').addEventListener('click', () => { saveText(); $('workspace').classList.remove('has-selection'); $('inbox').focus({ preventScroll: true }); });
  $('reply-mode').addEventListener('click', () => switchMode('reply')); $('note-mode').addEventListener('click', () => switchMode('note'));
  $('message-input').addEventListener('input', () => { saveText(); renderPermissions(); });
  $('composer').addEventListener('submit', submitMessage);
  $('attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => { const file = $('file-input').files?.[0]; if (!file || !mediaAllowed(state.thread) || !permissions(state.actor, state.thread).send) return; const error = attachmentError(file); if (error) { setNotice('thread-notice', error, 'critico'); $('file-input').value = ''; return; } currentDraft().file = file; currentDraft().uploaded = null; setNotice('thread-notice', ''); renderPermissions(); });
  $('remove-file').addEventListener('click', () => { currentDraft().file = null; currentDraft().uploaded = null; $('file-input').value = ''; renderPermissions(); });
  for (const action of ['take', 'transfer', 'release', 'close', 'reopen', 'pause', 'resume']) $(action).addEventListener('click', () => openAction(action));
  $('dialog-cancel').addEventListener('click', () => $('action-dialog').close());
  $('action-form').addEventListener('submit', event => { event.preventDefault(); const context = state.dialogAction; if (!context) return; const target = context.action === 'transfer' ? state.agents.find(agent => String(agent.id) === $('transfer-target').value) : null; if (context.action === 'transfer' && !target) return; $('action-dialog').close(); issueCommand(context.action, target, context); });
  $('presence').addEventListener('change', async () => { const value = $('presence').value; const previous = $('presence').dataset.confirmed || 'offline'; state.presenceSeq++; state.presencePosting = true; state.presencePostAt = Date.now(); $('presence').disabled = true; try { await sendPresence(value); $('presence').dataset.confirmed = value; announce(`Disponibilidad: ${PRESENCE[value]}`); } catch (error) { $('presence').value = previous; setNotice('global-notice', error.message, 'critico'); } finally { state.presencePosting = false; $('presence').disabled = false; } });
  $('copy-phone').addEventListener('click', async () => { if (!state.thread?.phone) return; try { await navigator.clipboard.writeText(text(state.thread.phone)); announce('Teléfono copiado.'); setNotice('thread-notice', 'Teléfono de contacto copiado.', 'ok'); } catch { setNotice('thread-notice', `Copiá el teléfono desde la ficha: ${state.thread.phone}`, 'info'); } });
  $('team').addEventListener('click', openTeam); $('team-close').addEventListener('click', () => $('team-dialog').close());
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(state.pollTimer); saveText(); } else if (state.actor) refresh(); });
  window.addEventListener('online', () => { if (state.actor) refresh(); });
  window.addEventListener('pagehide', () => { saveText(); clearTimeout(state.pollTimer); });
  bootstrap();
}
