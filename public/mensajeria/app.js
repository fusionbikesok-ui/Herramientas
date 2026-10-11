import {savedReply,messageLabel,forwardBlock} from './message-actions.js?v=351ec445ab57';
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
const ERRORS = { ...SEND_BLOCKED, message_reference_unavailable:'El mensaje original ya no está disponible para esta acción.',message_reference_changed:'El mensaje original cambió. Volvé a seleccionarlo antes de continuar.',invalid_message_reference:'Volvé a elegir el mensaje original.', already_owned: 'Otra persona ya tomó esta conversación. Se actualizará el responsable.', revision_conflict: 'La conversación cambió mientras trabajabas. Revisá su estado actualizado antes de continuar.', idempotency_conflict: 'Esta operación ya tiene un registro diferente. Revisá el historial antes de volver a enviar.', inbox_not_configured: 'La conexión del servicio de mensajería todavía no está configurada.', write_required: 'Tu acceso permite consultar, pero no cambiar la atención.', invalid_target: 'La persona elegida ya no está disponible para atender. Actualizá el equipo.', thread_not_found: 'No se encontró esta conversación.', invalid_media_caption: 'Los archivos admiten hasta 1024 caracteres. El audio debe enviarse sin texto adjunto.', invalid_message: 'Escribí un mensaje o elegí un archivo válido antes de enviar.', media_not_available: 'El archivo no está disponible. Volvé a adjuntarlo antes de enviar.', media_not_found: 'No se encontró el archivo.', media_unavailable: 'El archivo todavía no está disponible.', unsupported_media_type: 'Este tipo de archivo no está permitido.', media_too_large: 'El archivo supera el tamaño permitido.', media_signature_mismatch: 'El contenido no coincide con el tipo de archivo. Elegí un archivo válido.', unsafe_pdf: 'Este PDF contiene elementos no admitidos. Elegí una versión sin contenido activo.', upload_quota_exceeded: 'Se alcanzó el límite de archivos de esta conversación.', nonce_store_unavailable: 'No se pudo confirmar la conexión segura. El servicio volverá a intentar conectarse.' };

export function readBoundary(messages, { role, visible, selected, atBottom, unread } = {}) {
  if (!['agent', 'supervisor'].includes(role) || !visible || !selected || !atBottom || !(unread > 0)) return '';
  return messages.reduce((last, message) => {
    const id = String(message.id || '');
    return /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n && BigInt(id) > BigInt(last || '0') ? id : last;
  }, '');
}
export function inboxPaneWidth(preferred, available) {
  const min = 260, max = Math.max(min, Math.min(620, available - 12 - 360));
  const fallback = available <= 1100 ? 330 : 370;
  return { min, max, value: Math.round(Math.max(min, Math.min(max, Number.isFinite(preferred) ? preferred : fallback))) };
}

export function errorMessage(result) {
  if (result?.code === 'template_opt_in_required') return 'Confirmá que el cliente autorizó que lo contactemos por WhatsApp.';
  if (result?.code === 'recording_converter_busy') return 'Se están preparando otros audios. Tu grabación se conserva; volvé a enviarla en unos segundos.';
  const newErrors = { invalid_international_phone: 'Ingresá el número completo con + y código de país, por ejemplo +54 9 351 123 4567.', invalid_customer_name: 'Revisá el nombre del cliente; no debe contener saltos de línea.', template_not_approved: 'Meta todavía no aprobó esta plantilla. Consultá el catálogo nuevamente más tarde.', template_not_available: 'La plantilla ya no está disponible para este número. Consultá el catálogo nuevamente.', templates_unavailable: 'Meta no respondió al consultar las plantillas. Volvé a intentarlo.', templates_not_configured: 'Este número todavía no tiene configurada la consulta de plantillas.', template_changed: 'La plantilla cambió en Meta. Volvé a elegirla y revisá el mensaje antes de enviar.', invalid_template: 'Elegí una plantilla aprobada del catálogo de este número.', invalid_template_parameters: 'Completá todas las variables de la plantilla sin saltos de línea.', template_message_too_long: 'La plantilla completada es demasiado larga. Acortá sus variables.', opt_in_required: 'Confirmá que el cliente autorizó que lo contactemos por WhatsApp.', media_template_unsupported: 'Esta plantilla contiene archivos y todavía no puede enviarse desde esta bandeja.', unsupported_template_component: 'Esta plantilla incluye botones o componentes que todavía no se admiten en esta bandeja.', recording_converter_unavailable: 'La preparación de audios no está disponible en este momento. El audio se conserva; volvé a intentarlo más tarde.', recording_conversion_timeout: 'El audio tardó demasiado en prepararse. Intentá una grabación más corta.', recording_invalid_audio: 'No se pudo leer la grabación. Conservamos tu borrador; probá grabar el audio de nuevo.', recording_unsupported_format: 'Este formato de grabación no se admite. Probá desde otro navegador.', recording_unsupported_codec: 'El navegador grabó un formato de audio no compatible. Probá otro navegador.', recording_too_long: 'El audio supera los 5 minutos. Grabá uno más corto.' };
  if (newErrors[result?.code]) return newErrors[result.code];
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
export function customerWindowOpen(thread, now = Date.now()) {
  const inbound = Date.parse(thread?.last_inbound_at || '');
  return threadChannel(thread) === 'whatsapp' && Number.isFinite(inbound) && inbound <= now && now - inbound < SEND_WINDOW_MS;
}
export function templateOffered(actor, thread, now = Date.now()) {
  const inbound = Date.parse(thread?.last_inbound_at || '');
  const needsTemplate = !thread?.last_inbound_at || Number.isFinite(inbound) && now - inbound >= SEND_WINDOW_MS;
  return Boolean(permissions(actor, thread, now).manage && thread?.status !== 'closed' && threadChannel(thread) === 'whatsapp' && thread.can_send_template === true && needsTemplate);
}
export function sharedDraft(draft, prepared) {
  const content = String(prepared?.text || '').trim();
  const previous = String(draft?.reply || '');
  if (prepared?.media && (draft?.file || draft?.uploaded)) return { error: 'Ya tenés un archivo o audio en el borrador. Cerrá esta vista y quitá o enviá ese adjunto antes de agregar este contenido.' };
  const reply = [previous, content].filter(Boolean).join(previous.endsWith('\n\n') ? '' : '\n\n');
  if (reply.length > 4096) return { error: 'El mensaje superaría los 4096 caracteres. Tu borrador se conserva; acortalo antes de agregar este contenido.' };
  const mime = prepared?.media?.mime || draft?.uploaded?.mime || (draft?.recording ? 'audio/ogg' : draft?.file ? attachmentType(draft.file) : '');
  const error = captionError(mime, reply);
  if (error) return { error: `${error} Tu borrador se conserva.` };
  return { reply, uploaded: prepared?.media || draft?.uploaded || null };
}
export function savedAttachment(value) {
  if (!value || !['application/pdf', 'image/jpeg'].includes(value.mime) || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.media_id || '') || typeof value.name !== 'string' || value.name.length > 180) return null;
  return { media_id: value.media_id, name: value.name, mime: value.mime };
}
export function shareContextCurrent(context, { actor, thread, selected, selectionEpoch, mode = 'reply', pending = false, recording = false } = {}) {
  return Boolean(context && actor && thread && String(context.actor_id) === String(actor.id) && context.key === selected && context.key === thread.key && context.epoch === selectionEpoch && String(context.phone || '') === String(thread.phone || '') && String(context.number_id || '') === String(thread.number_id || '') && mode === 'reply' && !pending && !recording && permissions(actor, thread).send && (context.kind !== 'invoice' || threadChannel(thread) === 'whatsapp' && mediaAllowed(thread)));
}
export function productPrice(value, currency = 'ARS') {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return 'Precio a confirmar';
  try { return new Intl.NumberFormat('es-AR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value)); } catch { return 'Precio a confirmar'; }
}
export function invoiceDate(value) {
  const parts = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(value || ''));
  if (parts) return `${parts[3]}/${parts[2]}/${parts[1]}`;
  const date = new Date(value || '');
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('es-AR') : '';
}
export function productStock(value) {
  if (value == null || value === '') return 'Stock a confirmar';
  if (typeof value === 'object') return productStock(value.quantity ?? value.status);
  if (Number.isFinite(Number(value))) return Number(value) > 0 ? `Stock: ${Number(value)}` : 'Sin stock';
  return ({ instock: 'Disponible', outofstock: 'Sin stock', onbackorder: 'Por encargo' })[String(value)] || 'Stock a confirmar';
}
export function channelLabel(thread) { return threadChannel(thread) === 'web' ? 'Chat web' : 'WhatsApp'; }
export function mediaAllowed(thread) { return Boolean(thread && (typeof thread.capabilities?.media === 'boolean' ? thread.capabilities.media : threadChannel(thread) === 'whatsapp')); }
export function aiStateLabel(thread, status) {
  if (thread?.bot_paused) return 'IA pausada';
  const channel = threadChannel(thread) === 'web' ? status?.web : status?.numbers?.find(number => String(number.number_id) === String(thread?.number_id));
  if (!channel || typeof channel.connected !== 'boolean' || typeof channel.bot_enabled !== 'boolean') return 'Estado de IA pendiente';
  return ({enabled:'IA habilitada',not_connected:'Canal sin conectar',master_off:'IA general apagada',channel_off:'IA apagada en el canal',number_off:'IA apagada en este número',outside_hours:'IA fuera de horario'})[channel.ai_reason] || (channel.connected && channel.bot_enabled ? 'IA habilitada' : 'IA deshabilitada');
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

export function shouldSendOnEnter(event, { disabled = false, audio = false, pending = false } = {}) {
  return event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && event.keyCode !== 229 && !event.repeat && !disabled && !audio && !pending;
}
export function requestTimeout(path) { return path === '/upload' || path === '/commerce/prepare' ? 70000 : 25000; }
export function contactInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (/^[+\d\s()-]+$/.test(String(name))) return String(name).replace(/\D/g, '').slice(-2) || '?';
  return [...words[0]][0].toLocaleUpperCase('es') + (words.length > 1 ? [...words[words.length - 1]][0].toLocaleUpperCase('es') : '');
}
export function internationalPhone(value) {
  const input = String(value || '').trim();
  if (!/^\+[\d\s()-]+$/.test(input)) return '';
  const normalized = '+' + input.replace(/\D/g, '');
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : '';
}
export function recordingMime(Recorder) {
  if (typeof Recorder?.isTypeSupported !== 'function') return '';
  return ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(mime => Recorder.isTypeSupported(mime)) || '';
}
export function recordingError(file) {
  if (!/^audio\/(webm|ogg|mp4)(;.*)?$/i.test(file?.type || '')) return 'El navegador no produjo un formato de audio compatible.';
  if (!file.size) return 'No se grabó audio. Volvé a intentarlo.';
  if (file.size > 16 * 1024 * 1024) return 'El audio supera el máximo de 16 MB. Grabá uno más corto.';
  return '';
}
export function microphoneError(error) {
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) return 'El micrófono no está habilitado. Permití su uso en el navegador y volvé a pulsar Audio.';
  if (['NotFoundError', 'DevicesNotFoundError'].includes(error?.name)) return 'No se encontró un micrófono. Conectá uno y volvé a intentarlo.';
  if (['NotReadableError', 'TrackStartError'].includes(error?.name)) return 'No se pudo usar el micrófono. Cerrá otras aplicaciones que lo estén utilizando.';
  return error?.message || 'No se pudo grabar el audio. Volvé a intentarlo.';
}

// The only way to obtain a recording is an explicit start() call. Stopping never sends it.
export function createAudioCapture({ Recorder = globalThis.MediaRecorder, mediaDevices = globalThis.navigator?.mediaDevices, onState = () => {}, onReady = () => {}, onError = () => {}, now = () => Date.now(), every = setInterval, clear = clearInterval } = {}) {
  let current = null;
  const release = session => { if (session?.timer != null) clear(session.timer); for (const track of session?.stream?.getTracks() || []) track.stop(); };
  const cancel = () => { const session = current; current = null; if (session?.recorder?.state === 'recording') session.recorder.stop(); release(session); onState('idle', 0); };
  const fail = (session, error) => { if (session !== current) return; cancel(); onError(microphoneError(error)); };
  const stop = () => { const session = current; if (session?.recorder?.state !== 'recording') return; session.seconds = Math.min(300, Math.max(0, (now() - session.started) / 1000)); onState('stopping', session.seconds); if (session.timer != null) clear(session.timer); session.recorder.stop(); };
  async function start() {
    if (current) return;
    const session = { chunks: [], bytes: 0, stream: null, recorder: null, timer: null, seconds: 0 }; current = session; onState('requesting', 0);
    try {
      const mime = recordingMime(Recorder);
      if (!mime || !mediaDevices?.getUserMedia) throw new Error('Este navegador no permite grabar audio. Podés adjuntar un archivo de audio o usar un navegador actualizado con HTTPS.');
      session.stream = await mediaDevices.getUserMedia({ audio: true });
      if (session !== current) { release(session); return; }
      session.recorder = new Recorder(session.stream, { mimeType: mime, audioBitsPerSecond: 64000 });
      session.recorder.ondataavailable = event => {
        if (session !== current || !event.data?.size) return;
        session.bytes += event.data.size;
        if (session.bytes > 16 * 1024 * 1024) { fail(session, new Error('El audio superó 16 MB y se descartó. Grabá uno más corto.')); return; }
        session.chunks.push(event.data);
      };
      session.recorder.onerror = event => fail(session, event.error || new Error('La grabación se interrumpió. Volvé a intentarlo.'));
      session.recorder.onstop = () => {
        release(session); if (session !== current) return; current = null;
        const blob = new Blob(session.chunks, { type: session.recorder.mimeType || mime });
        const error = recordingError(blob); onState('idle', 0);
        if (error) onError(error); else onReady({ blob, mime: blob.type, seconds: session.seconds || Math.min(300, (now() - session.started) / 1000) });
      };
      session.started = now(); session.recorder.start(500); onState('recording', 0);
      session.timer = every(() => { if (session !== current) return; const seconds = (now() - session.started) / 1000; if (seconds >= 300) stop(); else onState('recording', seconds); }, 250);
    } catch (error) { fail(session, error); }
  }
  return { start, stop, cancel };
}

export function templateParameters(template, values = {}) {
  return Object.fromEntries(['header', 'body'].map(section => [section, (template?.variables?.[section] || []).map((variable, index) => String(values[section]?.[index] || '').trim())]));
}
export function templatePreviewText(preview) {
  if (typeof preview === 'string') return preview;
  return ['header', 'body', 'footer'].map(key => typeof preview?.[key] === 'string' ? preview[key] : '').filter(Boolean).join('\n\n');
}

if (typeof document !== 'undefined') start();

function start() {
  const $ = id => document.getElementById(id);
  const state = { actor: null, csrf: '', agents: [], numbers: [], web: null, threads: [], selected: null, thread: null, relatedWeb: [], messages: [], more: false, listMore: false, filter: 'unread', channel: 'all', search: '', number: '', mode: 'reply', drafts: new Map(), operations: new Map(), messageNodes: new Map(), listSeq: 0, threadSeq: 0, selectionEpoch: 0, historyLoading: false, pollTimer: null, pollDelay: POLL_MIN, refreshing: false, identityRefreshing: false, presenceSeq: 0, presencePostAt: 0, presencePosting: false, storageKey: '', statusReady: false, dialogAction: null, lastListError: '', listPages: 1, recordingPhase: 'idle', recordingSeconds: 0, recordingKey: null, newChatOperation: null, newChatBusy: false, templateContext: null, templateSeq: 0 };
  const text = value => value == null ? '' : String(value);
  const announce = value => { $('announcement').textContent = value; };
  const element = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; if (content != null) node.textContent = text(content); return node; };
  const uuid = () => { if (!globalThis.crypto?.randomUUID) throw new Error('Se necesita una conexión HTTPS segura para operar.'); return crypto.randomUUID(); };
  const currentDraft = () => draftFor(state.selected);
  function draftFor(key) {
    if (!state.drafts.has(key)) state.drafts.set(key, { reply: '', note: '', file: null, uploaded: null });
    return state.drafts.get(key);
  }
  const capture = createAudioCapture({
    onState: (phase, seconds) => { state.recordingPhase = phase; state.recordingSeconds = seconds; renderPermissions(); },
    onReady: ({ blob, mime, seconds }) => {
      if (!state.recordingKey || state.recordingKey !== state.selected) return;
      const draft = currentDraft(); const extension = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'm4a';
      clearAttachment(draft); draft.file = new File([blob], `audio-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, { type: mime }); draft.recording = true; draft.duration = seconds;
      state.recordingKey = null; renderPermissions(); announce('Audio listo para escuchar. Pulsá Enviar audio cuando quieras enviarlo.');
    },
    onError: message => { state.recordingKey = null; setNotice('thread-notice', message, 'critico'); renderPermissions(); }
  });
  function releasePreview(draft) {
    if (draft?.previewURL) { URL.revokeObjectURL(draft.previewURL); draft.previewURL = null; }
  }
  function clearAttachment(draft) { releasePreview(draft); draft.file = null; draft.uploaded = null; draft.recording = false; draft.duration = null; }
  function stopAudioResources(all = false) {
    state.recordingKey = null; capture.cancel();
    if (all) for (const draft of state.drafts.values()) releasePreview(draft); else releasePreview(state.drafts.get(state.selected));
    $('recording-preview').pause(); $('recording-preview').removeAttribute('src'); $('recording-preview').load();
  }
  function audioDraft(draft) { return Boolean(draft?.recording || (draft?.uploaded?.mime || (draft?.file ? attachmentType(draft.file) : '')).startsWith('audio/')); }
  function renderRecording() {
    const draft = currentDraft(); const active = state.recordingPhase !== 'idle'; const ready = Boolean(draft.recording && draft.file);
    $('recording-panel').hidden = state.mode === 'note' || (!active && !ready);
    $('recording-panel').classList.toggle('is-recording', active);
    const seconds = Math.floor(active ? state.recordingSeconds : draft.duration || 0); const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    $('recording-status').textContent = state.recordingPhase === 'requesting' ? 'Esperando permiso del micrófono…' : state.recordingPhase === 'stopping' ? 'Preparando audio…' : active ? `● Grabando ${duration} / 5:00` : `Audio listo · ${duration}`;
    $('stop-recording').hidden = !active; $('stop-recording').disabled = state.recordingPhase !== 'recording';
    $('discard-recording').disabled = state.operations.has(state.selected);
    $('recording-preview').hidden = !ready || active;
    if (ready && !active && state.mode === 'reply' && $('workspace').classList.contains('has-selection')) {
      if (!draft.previewURL) draft.previewURL = URL.createObjectURL(draft.file);
      if ($('recording-preview').getAttribute('src') !== draft.previewURL) $('recording-preview').src = draft.previewURL;
    }
    $('recording-help').textContent = active ? 'Máximo 5 minutos. Al detenerlo podés escucharlo antes de enviarlo.' : 'Escuchalo antes de enviar. El texto escrito se conserva para enviarlo por separado.';
  }
  function beginRecording() {
    const draft = currentDraft();
    if (!permissions(state.actor, state.thread).send || !mediaAllowed(state.thread) || state.mode !== 'reply' || state.operations.has(state.selected) || draft.file || draft.uploaded || state.recordingPhase !== 'idle') return;
    state.recordingKey = state.selected; setNotice('thread-notice', ''); capture.start();
  }
  function setNotice(id, message, tone = 'atencion') {
    const node = $(id); node.hidden = !message; node.textContent = message || ''; node.className = `${id === 'global-notice' ? 'global-notice' : 'thread-notice'} ui-aviso ui-aviso--${tone}`;
  }
  function persist() {
    if (!state.storageKey) return;
    try {
      const drafts = [...state.drafts].filter(([, draft]) => draft.reply || draft.note || savedAttachment(draft.uploaded) || savedReply(draft.replyTo)).map(([key, draft]) => [key, { reply: draft.reply, note: draft.note, uploaded: savedAttachment(draft.uploaded),replyTo:savedReply(draft.replyTo) }]);
      const operations = [...state.operations].filter(([, operation]) => operation.phase !== 'upload' || operation.file_hash).map(([key, operation]) => [key, { ...operation, payload: operation.phase === 'upload' ? { ...operation.payload, data_base64: undefined } : operation.payload, state: 'unknown' }]);
      sessionStorage.setItem(state.storageKey, JSON.stringify({ drafts, operations }));
    } catch { /* The in-memory draft is still retained when browser storage is full or disabled. */ }
  }
  function restore() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(state.storageKey) || '{}');
      for (const [key, draft] of Array.isArray(saved.drafts) ? saved.drafts : []) if (typeof key === 'string' && draft && typeof draft === 'object') state.drafts.set(key, { reply: text(draft.reply).slice(0, 4096), note: text(draft.note).slice(0, 4096), file: null, uploaded: savedAttachment(draft.uploaded),replyTo:savedReply(draft.replyTo) });
      for (const [key, operation] of Array.isArray(saved.operations) ? saved.operations : []) if (typeof key === 'string' && operation?.payload?.key === key && typeof operation.payload.request_id === 'string' && ['upload', 'command'].includes(operation.phase)) state.operations.set(key, { ...operation, state: 'unknown' });
    } catch { /* A corrupt local draft must not prevent reading the inbox. */ }
  }
  async function api(path, options = {}) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const cancel = () => controller.abort();
    if (externalSignal?.aborted) cancel(); else externalSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), requestTimeout(path));
    try {
      const response = await fetch(`${API}${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf } : {}), ...options.headers } });
      let result;
      try { result = await response.json(); } catch { const error = new Error('El servidor devolvió una respuesta que no se pudo confirmar.'); error.status = response.status; error.ambiguous = true; throw error; }
      if (!response.ok || result.ok === false) {
        const error = new Error(errorMessage(result)); error.status = response.status; error.code = result.code; error.ambiguous = response.status >= 500 || response.status === 408;
        if (response.status === 401 || response.status === 403) setNotice('global-notice', response.status === 401 ? 'Tu sesión venció. Volvé a ingresar a Herramientas; el borrador se conserva en esta pestaña.' : error.message, 'critico');
        if (response.status === 401 || response.status === 403) { stopAudioResources(true); closeShare(); $('forward-dialog').close(); forwardContext=null; forwardSequence++; }
        if ((response.status === 401 || response.status === 403) && path !== '/bootstrap') reloadIdentity();
        throw error;
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') { if (externalSignal?.aborted) throw error; const timed = new Error('La conexión demoró demasiado.'); timed.ambiguous = true; throw timed; }
      if (error.status == null) error.ambiguous = true;
      throw error;
    } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', cancel); }
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
  function shortSource(thread) { const number = state.numbers.find(item => String(item.number_id) === String(thread.number_id)); const digits = String(number?.number || number?.number_label || thread.number_label || '').replace(/\D/g, ''); return threadChannel(thread) === 'web' ? 'Web' : `WA${digits ? ` · ${digits.slice(-4)}` : ''}`; }
  function renderList() {
    const list = $('thread-list'); const top = list.scrollTop; const anchor = [...list.children].find(node => node.offsetTop + node.offsetHeight > list.offsetTop + top); const anchorOffset = anchor ? anchor.offsetTop - top : 0;
    const existing = new Map([...$('thread-list').children].map(node => [node.dataset.key, node]));
    const live = new Set();
    state.threads.forEach((thread, index) => {
      const key = text(thread.key); live.add(key); let card = existing.get(key);
      const signature = JSON.stringify([thread, shortSource(thread), sourceLabel(thread)]);
      if (!card) { card = element('button', 'thread-card'); card.type = 'button'; card.dataset.key = key; card.addEventListener('click', () => selectThread(key)); }
      if (card.dataset.signature !== signature) {
        const top = element('div', 'thread-card-top'); top.append(element('strong', '', nameOf(thread))); const time = element('time', '', formatTime(thread.updated_at, true)); if (thread.updated_at) time.dateTime = thread.updated_at; top.append(time);
        const bottom = element('div', 'thread-card-bottom'); const owner = element('span', 'thread-owner', thread.status === 'closed' ? `Cerrada · ${thread.owner_name || 'Sin responsable'}` : thread.owner_name || (thread.owner_id ? 'Responsable asignado' : 'Sin asignar')); bottom.append(owner);
        const source = element('span', 'thread-channel', shortSource(thread)); source.title = sourceLabel(thread); bottom.append(source);
        if (Number(thread.unread) > 0) { const unread = element('span', 'unread-count', Number(thread.unread) > 99 ? '99+' : thread.unread); unread.setAttribute('aria-label', `${thread.unread} sin leer`); bottom.append(unread); }
        const avatar = element('span', 'thread-avatar', contactInitials(nameOf(thread))); avatar.setAttribute('aria-hidden', 'true');
        const content = element('div', 'thread-card-content'); content.append(top, element('p', 'thread-preview', thread.preview || 'Sin mensajes de texto'), bottom); card.replaceChildren(avatar, content); card.classList.toggle('is-unread', Number(thread.unread) > 0);
        card.dataset.signature = signature;
      }
      card.setAttribute('aria-current', key === state.selected ? 'true' : 'false');
      if ($('thread-list').children[index] !== card) $('thread-list').insertBefore(card, $('thread-list').children[index] || null);
    });
    for (const [key, node] of existing) if (!live.has(key)) node.remove();
    if (top > 0 && anchor?.isConnected) list.scrollTop = anchor.offsetTop - anchorOffset; else list.scrollTop = top;
    $('load-list').hidden = !state.listMore;
    $('list-state').classList.toggle('error', Boolean(state.lastListError));
    $('list-state').textContent = state.lastListError || (!state.threads.length ? (state.search || state.number || state.channel !== 'all' ? 'No hay conversaciones que coincidan con estos filtros.' : state.filter === 'unread' ? 'Estás al día. No hay chats pendientes de leer.' : state.filter === 'mine' ? 'Todavía no tenés conversaciones asignadas.' : state.filter === 'closed' ? 'No hay conversaciones cerradas.' : state.filter === 'unassigned' ? 'No hay conversaciones esperando responsable.' : 'Todavía no hay conversaciones. Las consultas reales del chat web y de WhatsApp aparecerán acá.') : '');
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
      node.append(element('p', '', number.coexistence_pending ? 'Coexistencia pendiente de completar con el teléfono.' : 'La IA responde mensajes nuevos si el chat está abierto, sin responsable y sin pausa.'));
      node.append(element('p','',aiStateLabel({number_id:number.number_id},{numbers:state.numbers})));
      if(state.actor?.role==='supervisor' && typeof number.ai_number_enabled==='boolean'){
        const toggle=element('button','ui-btn',number.ai_number_enabled?'Apagar IA de este número':'Encender IA de este número');toggle.type='button';toggle.disabled=!number.connected;
        toggle.addEventListener('click',async()=>{toggle.disabled=true;try{renderStatus(await post('/ai-number',{number:number.number,enabled:!number.ai_number_enabled}));}catch(e){setNotice('global-notice',e.message,'critico');toggle.disabled=false;}});node.append(toggle);
      }
      return node;
    });
    const webCard = element('div', 'channel'); webCard.append(element('strong', '', 'Chat web'));
    webCard.append(chip(state.web?.connected === true ? '✓ Disponible' : state.web?.connected === false ? 'Atención pendiente de habilitar' : 'Estado pendiente', state.web?.connected === true ? 'ok' : ''));
    webCard.append(element('p', '', `${aiStateLabel({ channel: 'web' }, { web: state.web })}. El chat web admite respuestas de texto.`));
    if(state.actor?.role==='supervisor'){
      const settings=element('a','ui-btn','Configurar IA y horarios');settings.href='https://fusionbikes.com.ar/wp-admin/admin.php?page=fusion-live-chat-bridge';settings.target='_blank';settings.rel='noopener';webCard.append(settings);
    }
    if(state.actor?.can_restore_supervision && state.actor.role==='supervisor'){
      const link=element('a','ui-btn','Configurar OpenAI');link.href='./multimedia.html';webCard.append(link);
    }
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
    renderList();
    renderThreadBadges();
    renderPermissions();
  }
  async function loadStatus() {
    const seq = state.presenceSeq;
    try { renderStatus(await api('/status'), seq === state.presenceSeq); }
    catch (error) { state.statusReady = false; $('connection-summary').textContent = 'No se pudo confirmar el estado de los canales'; renderThreadBadges(); throw error; }
  }
  async function selectThread(key) {
    if (state.selected === key && state.thread) { $('workspace').classList.add('has-selection'); scheduleRead(); return; }
    saveText(); stopAudioResources(); state.selectionEpoch++; state.threadSeq++; state.selected = key; state.thread = null; state.relatedWeb = []; state.messages = []; state.messageNodes.clear(); state.more = false; state.historyLoading = false; state.mode = 'reply';
    $('workspace').classList.add('has-selection'); $('welcome').hidden = true; $('thread-view').hidden = false; $('messages').replaceChildren(); $('history-state').textContent = 'Cargando historial…'; $('contact-name').textContent = nameOf(state.threads.find(thread => text(thread.key) === key)); $('contact-meta').textContent = '';
    $('thread-badges').replaceChildren(); $('ownership').textContent = ''; $('web-context').hidden = true; $('copy-phone').disabled = true;
    setNotice('thread-notice', ''); restoreComposer(); renderPermissions(); renderList(); renderPending();
    try { await loadThread({ initial: true }); if (state.selected === key) $('contact-name').focus({ preventScroll: true }); }
    catch (error) { if (state.selected === key) { $('history-state').textContent = 'No se pudo cargar el historial.'; setNotice('thread-notice', error.message, 'critico'); } }
  }
  let readTimer, readBusy = false, preferredWidth = null;
  function scheduleRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(acknowledgeRead, 180);
  }
  async function acknowledgeRead() {
    const history = $('history');
    const boundary = readBoundary(state.messages, { role: state.actor?.role, visible: !document.hidden && !document.querySelector('dialog[open]'),
      selected: $('workspace').classList.contains('has-selection') && !state.historyLoading,
      atBottom: history.scrollHeight - history.clientHeight - history.scrollTop < 90, unread: state.thread?.unread });
    if (!boundary || readBusy || !state.selected || state.thread?.key !== state.selected) return;
    const key = state.selected, actor = state.actor.id, epoch = state.selectionEpoch;
    readBusy = true;
    try {
      const result = await post('/read', { key, through_id: boundary });
      if (state.actor?.id !== actor) return;
      if (state.selected === key && state.selectionEpoch === epoch && state.thread) {
        // An in-flight thread fetch can contain a newer arrival. Preserve its state;
        // the following list refresh and poll supply the authoritative count.
        const current = readBoundary(state.messages, { role: state.actor.role, visible: true, selected: true, atBottom: true, unread: 1 });
        if (current === boundary) state.thread.unread = result.unread;
      }
      await loadList();
    } catch {
      if (state.selected === key && state.selectionEpoch === epoch) announce('No se pudo confirmar la lectura. El chat conserva su estado pendiente hasta volver a intentarlo.');
    } finally { readBusy = false; }
  }
  const divider = $('inbox-divider');
  const widthKey = () => `mensajeria-inbox-width-v1:${state.actor?.id || 'local'}`;
  function applyWidth() {
    if (window.innerWidth <= 767) return;
    const bounds = inboxPaneWidth(preferredWidth, $('workspace').clientWidth);
    $('workspace').style.setProperty('--inbox-width', `${bounds.value}px`);
    for (const [attr, value] of [['min', bounds.min], ['max', bounds.max], ['now', bounds.value]]) divider.setAttribute(`aria-value${attr}`, String(value));
  }
  function restoreWidth() {
    preferredWidth = null;
    try { const value = localStorage.getItem(widthKey()); if (value !== null && Number.isFinite(Number(value))) preferredWidth = Number(value); } catch { /* Layout still works without storage. */ }
    applyWidth();
  }
  function saveWidth(value) {
    preferredWidth = value === null ? null : inboxPaneWidth(value, $('workspace').clientWidth).value;
    applyWidth();
    try { if (preferredWidth === null) localStorage.removeItem(widthKey()); else localStorage.setItem(widthKey(), String(preferredWidth)); } catch { /* Keep the width for this session. */ }
  }
  let drag = null;
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || window.innerWidth <= 767) return;
    event.preventDefault(); divider.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, width: $('inbox').getBoundingClientRect().width };
    divider.setPointerCapture(event.pointerId); document.body.classList.add('is-resizing');
  });
  divider.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) { preferredWidth = inboxPaneWidth(drag.width + event.clientX - drag.x, $('workspace').clientWidth).value; applyWidth(); } });
  function endDrag(event) {
    if (drag?.id !== event.pointerId) return;
    drag = null; document.body.classList.remove('is-resizing'); saveWidth(preferredWidth);
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(name, endDrag);
  divider.addEventListener('dblclick', () => saveWidth(null));
  divider.addEventListener('keydown', event => {
    const bounds = inboxPaneWidth(preferredWidth, $('workspace').clientWidth), step = event.shiftKey ? 50 : 20;
    const values = { ArrowLeft: bounds.value - step, ArrowRight: bounds.value + step, Home: bounds.min, End: bounds.max, Enter: null };
    if (!(event.key in values)) return;
    event.preventDefault(); saveWidth(values[event.key]);
  });
  window.addEventListener('resize', applyWidth);
  $('history').addEventListener('scroll', scheduleRead, { passive: true });

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
      if (!older) scheduleRead();
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
    renderReplyContext();
    const access = permissions(state.actor, state.thread); const pending = state.operations.has(state.selected); const closed = state.thread?.status === 'closed';
    if (state.recordingPhase !== 'idle' && !access.send) { stopAudioResources(); announce('La grabación se detuvo porque cambió el permiso para responder.'); }
    const web = threadChannel(state.thread) === 'web'; const canAttach = mediaAllowed(state.thread);
    for (const action of ['take', 'transfer', 'release', 'close', 'reopen', 'pause', 'resume']) {
      const visible = action === 'take' ? access.take : action === 'transfer' ? access.manage && !closed : action === 'release' ? access.manage && Boolean(state.thread?.owner_id) : action === 'close' ? access.manage && !closed : action === 'reopen' ? access.control && closed : action === 'pause' ? access.control && !state.thread?.bot_paused : access.control && !closed && Boolean(state.thread?.bot_paused);
      $(action).hidden = !visible; $(action).disabled = pending || state.recordingPhase !== 'idle';
    }
    const note = state.mode === 'note'; const canCompose = note ? access.note : access.send;
    $('reply-mode').setAttribute('aria-pressed', text(!note)); $('note-mode').setAttribute('aria-pressed', text(note)); $('note-mode').disabled = !access.write;
    $('composer').classList.toggle('is-note', note); $('message-input').disabled = !canCompose; $('message-input').placeholder = note ? 'Escribí una nota para el equipo…' : web ? 'Escribí tu respuesta para el chat web…' : 'Escribí tu respuesta…';
    document.querySelector('label[for="message-input"]').textContent = note ? 'Escribir nota privada' : web ? 'Escribir respuesta para el chat web' : 'Escribir respuesta para WhatsApp';
    const draft = currentDraft(); const hasAudio = audioDraft(draft); const recording = state.recordingPhase !== 'idle';
    $('send').textContent = note ? 'Guardar nota' : hasAudio ? 'Enviar audio' : 'Enviar';
    const caption = note ? '' : !canAttach && (draft.file || draft.uploaded) ? 'Este canal no admite archivos. Quitá el adjunto para responder con texto.' : hasAudio ? '' : captionError(draft.uploaded?.mime || (draft.file ? attachmentType(draft.file) : ''), text(draft.reply));
    $('send').disabled = !canCompose || pending || recording || Boolean(caption) || (!text(draft[state.mode]).trim() && (note || !draft.file && !draft.uploaded));
    $('attach').hidden = note || !access.write; $('attach').disabled = !access.send || !canAttach || pending || recording; $('attach').title = canAttach ? 'Adjuntar archivo' : 'Este canal admite solo texto'; $('file-input').disabled = $('attach').disabled; $('remove-file').disabled = pending;
    $('record-audio').hidden = note || !access.write; $('record-audio').disabled = !access.send || !canAttach || pending || recording || Boolean(draft.file || draft.uploaded);
    $('use-template').hidden = note || !templateOffered(state.actor, state.thread); $('use-template').disabled = !canUseTemplate() || recording;
    for (const kind of ['product', 'invoice', 'tracking']) { const button = $(`share-${kind}`); button.hidden = note || !access.write; button.disabled = !access.send || pending || recording || kind === 'invoice' && (!canAttach || web); }
    $('commerce-help').hidden = note || !access.write || !web;
    $('commerce-help').textContent = 'El chat web admite texto y enlaces de productos o seguimiento. Archivos, audio y facturas PDF se comparten por WhatsApp.';
    if (state.shareContext && !currentShare(state.shareContext)) closeShare('Cambió la conversación o tu permiso para responder. Volvé a abrir el selector.');
    if (state.templateContext?.preview) $('template-send').disabled = !$('template-opt-in').checked || !canUseTemplate() || state.templateContext.key !== state.selected || state.templateContext.preview.signature !== templateInputSignature();
    $('new-chat').disabled = !access.write || !state.numbers.some(number => number.connected === true);
    $('attachment').hidden = note || draft.recording || (!draft.file && !draft.uploaded); $('attachment-name').textContent = draft.file ? `${draft.file.name} · ${formatBytes(draft.file.size)}` : draft.uploaded?.name || '';
    const thumbnail = !note && draft.uploaded?.mime === 'image/jpeg' ? `${API}/media/${encodeURIComponent(draft.uploaded.media_id)}` : '';
    $('attachment-image').hidden = !thumbnail;
    if (thumbnail) { if ($('attachment-image').getAttribute('src') !== thumbnail) $('attachment-image').src = thumbnail; } else $('attachment-image').removeAttribute('src');
    $('file-help').hidden = note; $('file-help').textContent = canAttach ? 'Imagen, audio, video o PDF' : 'Este canal admite solo texto';
    $('window-status').textContent = state.thread ? (web ? 'Chat web' : sendWindow(state.thread).allowed ? '24 h · Atención abierta' : 'Texto libre no disponible') : '';
    $('composer-help').textContent = !state.thread ? 'Elegí una conversación para comenzar.' : !access.write ? 'Tu acceso permite consultar el historial. No permite responder, adjuntar ni cambiar la atención.' : !access.manage ? (state.thread.owner_id ? 'Esta conversación la atiende otra persona. Podés consultar su historial.' : 'Tomá esta conversación antes de responder o agregar notas.') : note ? 'Solo el equipo verá esta nota. No se envía al cliente.' : closed ? 'La conversación está cerrada. Reabrila para responder.' : !sendWindow(state.thread).allowed ? sendWindow(state.thread).label : pending ? 'Hay una operación pendiente de confirmar. El borrador se conserva.' : caption || (hasAudio ? 'El audio se envía sin texto. Tu borrador se conserva para una respuesta separada.' : web ? 'La respuesta llega a este chat web.' : 'Respondés desde el número de negocio de esta conversación.');
    $('composer-help').classList.toggle('is-hint', Boolean(state.thread && access.manage && !note && !closed && sendWindow(state.thread).allowed && !pending && !caption && !hasAudio));
    $('keyboard-help').textContent = !note && hasAudio ? 'Para enviar el audio, pulsá Enviar audio · El texto se conserva' : note ? 'Enter guarda la nota privada · Shift + Enter agrega una línea' : 'Enter envía · Shift + Enter agrega una línea';
    renderRecording();
  }
  function canUseTemplate(thread = state.thread) { return Boolean(templateOffered(state.actor, thread) && !state.operations.has(thread.key)); }

  function currentShare(context) {
    return context === state.shareContext && shareContextCurrent(context, { ...state, pending: state.operations.has(state.selected), recording: state.recordingPhase !== 'idle' });
  }
  function closeShare(message = '') {
    const context = state.shareContext;
    state.shareContext = null;
    clearTimeout(context?.timer); context?.controller?.abort();
    if ($('share-dialog').open) $('share-dialog').close();
    if (message) setNotice('thread-notice', message, 'atencion');
  }
  function shareError(message, retry = null) {
    dialogError('share-error', message);
    $('share-retry').hidden = !retry;
    if (state.shareContext) state.shareContext.retry = retry;
  }
  function shareFreshness(result) {
    const updated = formatTime(result.updated_at);
    $('share-freshness').textContent = `${result.stale ? 'Datos pendientes de actualizar. ' : ''}${updated ? `Sincronizado: ${updated}.` : 'Fecha de sincronización no disponible.'}${result.stale ? ' Confirmá precio, stock o estado antes de compartir.' : ''}`;
    $('share-freshness').classList.toggle('is-stale', result.stale === true);
  }
  function resetSharePreview(context) {
    context.prepared = null; context.invoices = null; context.order = null; context.seq++;
    $('share-preview').hidden = true; $('share-preview-media').hidden = true; $('share-preview-media').removeAttribute('href');
    $('share-preview-image').hidden = true; $('share-preview-image').removeAttribute('src');
    $('product-stock').disabled = false; $('product-search').disabled = false; $('share-back').disabled = false;
    $('share-add').hidden = true; $('share-back').hidden = true; $('share-results').hidden = false;
    shareError('');
  }
  async function openShare(kind) {
    const context = { kind, key: state.selected, actor_id: state.actor?.id, epoch: state.selectionEpoch, phone: state.thread?.phone, number_id: state.thread?.number_id, seq: 0, products: [], orders: [] };
    if (!shareContextCurrent(context, { ...state, pending: state.operations.has(state.selected), recording: state.recordingPhase !== 'idle' })) return;
    closeShare(); saveText(); state.shareContext = context;
    $('share-title').textContent = { product: 'Compartir producto', invoice: 'Compartir factura', tracking: 'Compartir seguimiento' }[kind];
    $('share-recipient').textContent = `Para ${nameOf(state.thread)} · ${state.thread.phone || 'Sin teléfono informado'} · ${channelLabel(state.thread)}`;
    $('share-description').textContent = kind === 'product' ? 'Buscá por nombre o SKU. Revisá la variante, el precio de la web y el stock antes de elegir.' : kind === 'invoice' ? 'Elegí el pedido para agregar su factura al mensaje. Si tiene varios comprobantes, elegí uno.' : 'Elegí un pedido de este teléfono para compartir su seguimiento registrado.';
    $('product-filters').hidden = kind !== 'product'; $('product-search').value = '';
    $('share-results').replaceChildren(); $('share-freshness').textContent = ''; $('share-freshness').classList.remove('is-stale');
    resetSharePreview(context);
    $('share-state').textContent = kind === 'product' ? 'Escribí al menos 2 caracteres para buscar productos.' : 'Buscando pedidos por el teléfono de esta conversación…';
    $('share-dialog').showModal();
    if (kind === 'product') $('product-search').focus(); else { $('share-close').focus(); await loadShareOrders(context); }
  }
  function scheduleProductSearch() {
    const context = state.shareContext; if (!currentShare(context) || context.kind !== 'product') return;
    clearTimeout(context.timer); context.controller?.abort(); resetSharePreview(context); $('share-results').replaceChildren();
    const query = $('product-search').value.trim();
    if (query.length < 2) { $('share-state').textContent = 'Escribí al menos 2 caracteres para buscar productos.'; return; }
    $('share-state').textContent = 'Buscando productos…'; context.timer = setTimeout(() => searchShareProducts(context, query), 250);
  }
  async function searchShareProducts(context, query) {
    if (!currentShare(context)) return;
    const seq = ++context.seq; context.controller?.abort(); const controller = new AbortController(); context.controller = controller; shareError('');
    try {
      const result = await api(`/products?${new URLSearchParams({ q: query, stock: $('product-stock').value })}`, { signal: controller.signal });
      if (!currentShare(context) || seq !== context.seq || $('product-search').value.trim() !== query) return;
      context.products = Array.isArray(result.products) ? result.products : []; shareFreshness(result);
      $('share-state').textContent = context.products.length ? `${context.products.length} ${context.products.length === 1 ? 'producto' : 'productos'}.${result.more ? ' Hay más resultados; afiná la búsqueda.' : ''}` : 'No se encontraron productos. Probá otro nombre o SKU.';
      renderShareProducts(context);
    } catch (error) { if (currentShare(context) && seq === context.seq && error.name !== 'AbortError') { $('share-state').textContent = 'No se pudo consultar el catálogo.'; shareError(error.message, () => searchShareProducts(context, query)); } }
  }
  function shareChoice(content, callback) {
    const card = element('button', 'share-choice'); card.type = 'button'; card.append(content); card.addEventListener('click', callback);
    const row = element('div', 'share-result'); row.setAttribute('role', 'listitem'); row.append(card); return row;
  }
  function renderShareProducts(context) {
    $('share-results').replaceChildren(...context.products.map(product => {
      const content = element('span', 'product-result-content');
      const imageUrl = safePageUrl(product.image);
      if (imageUrl) { const image = element('img', 'product-thumbnail'); image.src = imageUrl; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; content.append(image); }
      else content.append(element('span', 'product-thumbnail product-no-image', 'Sin foto'));
      const details = element('span', 'product-result-details'); details.append(element('strong', '', product.name || 'Producto'), element('span', 'product-variant', product.variation || ''), element('span', 'meta', product.sku || 'SKU no informado'));
      const values = element('span', 'product-result-values'); values.append(element('strong', '', productPrice(product.price)), element('span', 'meta', 'Contado / transferencia'), element('span', 'meta', productStock(product.stock)), element('span', 'meta', formatTime(product.updated_at)));
      content.append(details, values); return shareChoice(content, () => prepareShare(context, { product_id: product.id }));
    }));
  }
  async function loadShareOrders(context) {
    if (!currentShare(context)) return;
    const seq = ++context.seq; shareError(''); $('share-state').textContent = 'Buscando pedidos por teléfono…';
    try {
      const result = await api(`/commerce/orders?${new URLSearchParams({ key: context.key })}`);
      if (!currentShare(context) || seq !== context.seq) return;
      context.orders = Array.isArray(result.orders) ? result.orders : []; shareFreshness(result);
      $('share-state').textContent = [context.orders.length ? `${context.orders.length} pedidos coinciden con ${result.phone || context.phone}. Revisá el nombre y los productos.` : 'No se encontraron pedidos con este teléfono en el historial sincronizado.', typeof result.identity_warning === 'string' ? result.identity_warning : result.identity_warning ? 'El teléfono por sí solo no confirma la identidad del cliente.' : ''].filter(Boolean).join(' ');
      renderShareOrders(context);
    } catch (error) { if (currentShare(context) && seq === context.seq) { $('share-state').textContent = 'No se pudo consultar el historial de pedidos.'; shareError(error.message, () => loadShareOrders(context)); } }
  }
  function orderDescription(order) {
    const status = ({ completed: 'Completado', processing: 'En preparación', pending: 'Pendiente', 'on-hold': 'En espera', cancelled: 'Cancelado', refunded: 'Reembolsado', failed: 'Fallido' })[order.status] || order.status;
    return [order.customer_name || 'Nombre no informado', formatTime(order.created_at), status, productPrice(order.total, order.currency || 'ARS'), (order.last_items || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean).join(' · ')].filter(Boolean).join(' · ');
  }
  function renderShareOrders(context) {
    $('share-results').replaceChildren(...context.orders.map(order => {
      const content = element('span', 'order-result-content'); content.append(element('strong', '', `Pedido #${order.number || order.id}`), element('span', '', orderDescription(order)));
      if (context.kind === 'tracking' && !order.tracking?.length) content.append(element('span', 'meta', 'Sin número de seguimiento registrado'));
      if (context.kind === 'invoice' && order.invoice_available === false) content.append(element('span', 'meta', 'Sin factura emitida disponible'));
      return shareChoice(content, () => chooseShareOrder(context, order));
    }));
  }
  function chooseShareOrder(context, order) {
    if (!currentShare(context) || context.busy) return;
    context.order = order; context.prepared = null; context.seq++;
    $('share-results').replaceChildren(); $('share-preview').hidden = true; $('share-add').hidden = true; $('share-back').hidden = false; shareError('');
    if (context.kind === 'invoice') {
      prepareShare(context, { order_id: order.id });
    } else {
      const trackings = Array.isArray(order.tracking) ? order.tracking : [];
      $('share-state').textContent = trackings.length ? `Pedido #${order.number || order.id}: elegí el envío que querés compartir.` : 'Este pedido todavía no tiene un número de seguimiento registrado. La etiqueta o el lote de exportación no son un seguimiento.';
      $('share-results').replaceChildren(...trackings.map((tracking, index) => shareChoice(element('span', 'order-result-content', `${tracking.carrier || 'Envío'} · ${tracking.number || 'Seguimiento'}`), () => prepareShare(context, { order_id: order.id, tracking_index: index }))));
    }
  }
  function setShareBusy(context, busy) {
    context.busy = busy;
    for (const button of $('share-results').querySelectorAll('button')) button.disabled = busy;
    $('share-back').disabled = busy; $('product-search').disabled = busy;
    $('product-stock').disabled = busy;
    $('share-add').disabled = busy;
  }
  async function prepareShare(context, selection) {
    if (!currentShare(context) || context.busy) return;
    if (['invoice', 'product'].includes(context.kind) && mediaAllowed(state.thread) && (currentDraft().file || currentDraft().uploaded)) { shareError('Ya tenés un archivo en el borrador. Quitalo o envialo antes de agregar otro.'); return; }
    const seq = ++context.seq; setShareBusy(context, true); shareError(''); $('share-state').textContent = context.kind === 'invoice' ? 'Consultando facturas emitidas…' : 'Preparando vista previa…';
    try {
      const result = await post('/commerce/prepare', { key: context.key, kind: context.kind, ...selection, request_id: uuid() });
      if (!currentShare(context) || seq !== context.seq) return;
      if (result.selection_required) {
        context.invoices = Array.isArray(result.invoices) ? result.invoices : [];
        $('share-state').textContent = context.invoices.length ? 'Elegí el comprobante para agregarlo al mensaje.' : 'No hay una factura emitida disponible para este pedido.';
        $('share-results').replaceChildren(...context.invoices.map(invoice => shareChoice(element('span', 'order-result-content', [invoice.label || `Comprobante ${invoice.id}`, invoiceDate(invoice.date), invoice.total != null ? productPrice(invoice.total) : ''].filter(Boolean).join(' · ')), () => prepareShare(context, { order_id: selection.order_id, invoice_id: invoice.id }))));
        return;
      }
      if (!result.text && !result.media) throw new Error('No se pudo preparar un contenido para compartir.');
      if (result.media && (!/^[a-zA-Z0-9_-]+$/.test(String(result.media.media_id || '')) || !['application/pdf', 'image/jpeg'].includes(result.media.mime))) throw new Error('No se pudo confirmar el archivo para compartir.');
      context.prepared = { text: String(result.text || ''), ...(result.media ? { media: result.media } : {}) };
      $('share-preview-text').textContent = context.prepared.text; $('share-preview').hidden = false; $('share-results').hidden = true; $('share-add').hidden = false; $('share-back').hidden = false;
      $('share-state').textContent = 'Revisá el contenido antes de agregarlo al borrador.';
      const photo = result.media?.mime === 'image/jpeg';
      $('share-preview-image').hidden = !photo;
      if (photo) $('share-preview-image').src = `${API}/media/${encodeURIComponent(result.media.media_id)}`;
      $('share-preview-media').hidden = !result.media || photo;
      if (result.media && !photo) { $('share-preview-media').href = `${API}/media/${encodeURIComponent(result.media.media_id)}`; $('share-preview-media').textContent = `Revisar PDF · ${result.media.name || 'Factura'}`; }
      $('share-preview-title').focus({ preventScroll: true });
      const merged = sharedDraft(currentDraft(), context.prepared); if (merged.error) shareError(merged.error);
      else if (context.kind === 'invoice') { setShareBusy(context, false); addSharedDraft(); }
    } catch (error) { if (currentShare(context) && seq === context.seq) { $('share-state').textContent = 'No se pudo preparar el contenido.'; shareError(error.message, () => prepareShare(context, selection)); } }
    finally { if (currentShare(context)) { setShareBusy(context, false); if (context.prepared) $('share-add').disabled = Boolean(sharedDraft(currentDraft(), context.prepared).error); } }
  }
  function shareBack() {
    const context = state.shareContext; if (!currentShare(context) || context.busy) return;
    resetSharePreview(context);
    if (context.kind === 'product') { renderShareProducts(context); $('share-state').textContent = 'Elegí un producto para revisar el mensaje.'; $('product-search').focus(); }
    else { renderShareOrders(context); $('share-state').textContent = 'Elegí un pedido para continuar.'; $('share-results').querySelector('button')?.focus(); }
  }
  function addSharedDraft() {
    const context = state.shareContext; if (!currentShare(context) || context.busy || !context.prepared) return;
    const merged = sharedDraft(currentDraft(), context.prepared); if (merged.error) { shareError(merged.error); return; }
    const draft = currentDraft(); draft.reply = merged.reply;
    if (context.prepared.media) draft.uploaded = merged.uploaded;
    persist(); closeShare(); restoreComposer(); renderPermissions(); $('message-input').focus(); announce('Contenido agregado al borrador. Revisalo y pulsá Enviar cuando quieras compartirlo.');
  }
  function renderReplyContext() {
    const quote=currentDraft().replyTo, box=$('reply-context');
    box.hidden=state.mode!=='reply'||!quote;
    $('reply-context-text').textContent=quote?`${quote.author}: ${quote.text}`:'';
    $('reply-cancel').disabled=state.operations.has(state.selected);
  }
  function quoteMessage(message) {
    if (!permissions(state.actor,null).write || state.operations.has(state.selected) || !message.can_reply) return;
    saveText();state.mode='reply';
    currentDraft().replyTo=savedReply({id:message.id,version:message.reference_version,author:message.sender==='customer'?nameOf(state.thread):message.agent_name||'Equipo',text:messageLabel(message)});
    persist();restoreComposer();$('message-input').focus();
  }
  function appendMessageActions(node,message) {
    if (!permissions(state.actor,null).write || message.revoked || (!message.can_reply&&!message.can_forward)) return;
    const tools=element('div','message-tools');
    if(message.can_reply){const reply=element('button','message-reply','↩ Responder');reply.type='button';reply.title='Responder a este mensaje';reply.addEventListener('click',()=>quoteMessage(message));tools.append(reply);}
    if(message.can_forward){
      const menu=element('details','message-menu');const summary=element('summary','','⋯');summary.setAttribute('aria-label','Más opciones del mensaje');summary.title='Reenviar mensaje';menu.append(summary);
      const buttons=element('div','message-menu-items');const button=element('button','ui-btn','↗ Reenviar');button.type='button';button.addEventListener('click',()=>{menu.open=false;openForward(message);});buttons.append(button);
      menu.append(buttons);tools.append(menu);
    }
    node.append(tools);
  }
  let forwardContext=null,forwardSearchTimer=null,forwardSequence=0;
  async function openForward(message) {
    if(!permissions(state.actor,null).write||!message.can_forward)return;
    forwardContext={source_key:state.selected,message,actor_id:state.actor.id,target:null};
    $('forward-preview').textContent=messageLabel(message).slice(0,500);
    $('forward-search').value='';$('forward-confirm').disabled=true;$('forward-confirm').textContent='Reenviar';
    $('forward-destination').textContent='Elegí a quién reenviar.';dialogError('forward-error','');
    $('forward-dialog').showModal();$('forward-search').focus();await searchForward();
  }
  async function searchForward() {
    const context=forwardContext,seq=++forwardSequence;if(!context)return;
    $('forward-results').replaceChildren(element('p','meta','Buscando conversaciones…'));
    try {
      const result=await api('/list?'+new URLSearchParams({filter:'all',channel:'all',search:$('forward-search').value,limit:'30'}));
      if(context!==forwardContext||seq!==forwardSequence)return;
      const nodes=(result.threads||[]).map(thread=>{
        const blocked=forwardBlock(thread,state.actor,context.message);
        const button=element('button','forward-target');button.type='button';button.dataset.key=thread.key;button.disabled=Boolean(blocked);button.setAttribute('aria-pressed',String(context.target?.key===thread.key));
        button.append(element('strong','',nameOf(thread)),element('span','meta',[thread.phone,sourceLabel(thread),blocked||(!thread.owner_id?'Sin responsable · se tomará al reenviar':'A tu cargo')].filter(Boolean).join(' · ')));
        button.addEventListener('click',()=>selectForwardTarget(thread.key,context));return button;
      });
      $('forward-results').replaceChildren(...(nodes.length?nodes:[element('p','meta','No encontramos conversaciones. Probá con el nombre o teléfono.') ]));
    }catch(error){if(context===forwardContext&&seq===forwardSequence)dialogError('forward-error',error.message);}
  }
  async function selectForwardTarget(key,context) {
    const seq=++forwardSequence;context.target=null;$('forward-confirm').disabled=true;
    try{
      const result=await api('/thread?'+new URLSearchParams({key}));
      if(context!==forwardContext||seq!==forwardSequence)return;
      const blocked=forwardBlock(result.thread,state.actor,context.message);if(blocked)throw new Error(blocked);
      context.target=result.thread;dialogError('forward-error','');
      $('forward-destination').textContent=`Destino: ${nameOf(result.thread)} · ${result.thread.phone||'Chat web'} · ${sourceLabel(result.thread)}`;
      $('forward-confirm').textContent=result.thread.owner_id?'Reenviar':'Tomar y reenviar';$('forward-confirm').disabled=false;
      for(const button of $('forward-results').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.key===key));
    }catch(error){if(context===forwardContext&&seq===forwardSequence)dialogError('forward-error',error.message);}
  }
  async function confirmForward(event) {
    event.preventDefault();const context=forwardContext,target=context?.target;
    if(!target||state.actor?.id!==context.actor_id||forwardBlock(target,state.actor,context.message))return;
    if(state.operations.has(target.key)){dialogError('forward-error','Ese chat tiene una operación sin confirmar. Abrilo y verificá su resultado antes de reenviar.');return;}
    $('forward-confirm').disabled=true;
    const operation={phase:'command',state:'pending',actor_id:state.actor.id,forward_preview:messageLabel(context.message),payload:{key:target.key,request_id:uuid(),revision:target.revision,action:'forward',source_key:context.source_key,source_message_id:String(context.message.id),source_version:context.message.reference_version,take_if_unassigned:!target.owner_id}};
    $('forward-dialog').close();forwardContext=null;
    await selectThread(target.key);
    if(state.selected!==target.key||state.actor?.id!==context.actor_id)return;
    await runOperation(target.key,operation);
  }

  function formatBytes(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }
  function makeMessage(message) {
    const note = message.sender === 'note' || message.kind === 'note'; const outbound = ['operator', 'bot', 'agent', 'human'].includes(message.sender); const system = message.sender === 'system';
    const node = element('article', `message${note ? ' note' : outbound ? ' outbound' : system ? ' system' : ''}`); node.setAttribute('role', 'listitem'); node.dataset.id = text(message.id);
    const heading=element('div','message-heading');heading.append(element('span', 'message-author', note ? `Nota privada · ${message.agent_name || 'Equipo'}` : message.sender === 'bot' ? message.agent_name || 'Asistente IA' : outbound ? message.agent_name || 'Atención humana' : system ? 'Actividad' : nameOf(state.thread)));
    appendMessageActions(heading,message);node.append(heading);
    if(message.forwarded&&!message.revoked)node.append(element('span','forwarded-label','↗ Reenviado'));
    if(message.quoted&&!message.revoked){const quote=element('button','message-quote');quote.type='button';quote.disabled=message.quoted.unavailable;quote.append(element('strong','',message.quoted.author),element('span','',message.quoted.text));quote.addEventListener('click',()=>{const original=state.messageNodes.get(String(message.quoted.id));if(original){original.node.scrollIntoView({block:'center',behavior:'smooth'});original.node.classList.add('quote-highlight');setTimeout(()=>original.node.classList.remove('quote-highlight'),1600);}else setNotice('thread-notice','El mensaje citado es anterior. Usá Cargar anteriores para verlo.','info');});node.append(quote);}
    if (!message.revoked && message.media_reading?.text) {
      const reading=element('details','media-reading');reading.append(element('summary','meta',message.media_reading.kind==='audio'?'Transcripción automática':'Descripción automática'));
      reading.append(element('p','message-text',message.media_reading.text));node.append(reading);
    }
    if (message.revoked || message.text && !(message.media_id && /^\[[^\]]{1,100}\]$/.test(message.text))) node.append(element('p', 'message-text', message.revoked ? `Mensaje eliminado en ${channelLabel(state.thread)}.` : message.text));
    if (message.edited && !message.revoked) node.append(element('span', 'meta', `Editado en ${channelLabel(state.thread)}`));
    if (message.media_id && !message.revoked) {
      const url = `${API}/media/${encodeURIComponent(message.media_id)}`; const mime = text(message.mime); const kind = text(message.kind);
      if (mime.startsWith('image/') || kind === 'image') { const link = element('a', 'media-preview'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; const image = element('img', 'message-media'); image.src = url; image.alt = message.file_name || 'Imagen adjunta'; image.loading = 'lazy'; image.referrerPolicy = 'same-origin'; link.append(image); node.append(link); }
      else if (mime.startsWith('audio/') || kind === 'audio' || mime.startsWith('video/') || kind === 'video') { const media = element(mime.startsWith('audio/') || kind === 'audio' ? 'audio' : 'video', 'message-media'); media.controls = true; media.preload = 'none'; media.src = url; if (media.tagName === 'VIDEO') media.playsInline = true; media.setAttribute('aria-label', message.file_name || 'Archivo adjunto'); node.append(media); }
      const download = element('a', 'media-download', mime === 'application/pdf' ? `↓ ${message.file_name || 'Descargar PDF'}` : '↓ Descargar'); download.href = url; download.download = message.file_name || ''; download.target = '_blank'; download.rel = 'noopener'; if(kind!=='audio'&&!mime.startsWith('audio/'))node.append(download);
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
  function switchMode(mode) { if (state.mode === mode) return; saveText(); stopAudioResources(); state.mode = mode; restoreComposer(); if (!$('message-input').disabled) $('message-input').focus(); }
  function operationDescription(operation) {
    const action = operation.payload.action;
    if (operation.phase === 'upload') return `Archivo: ${operation.payload.name}`;
    if (action === 'send') return operation.template_preview ? `Plantilla: ${operation.template_preview}` : `${operation.payload.text || ''}${operation.payload.media_id ? '\nArchivo adjunto' : ''}`.trim();
    if (action === 'forward') return `Reenviar: ${operation.forward_preview || 'Mensaje o archivo seleccionado'}`;
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
    const operation = state.operations.get(key); if (!operation || operation.phase !== 'command' || !['send', 'note','forward'].includes(operation.payload.action)) return;
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
      if(operation.payload.action==='send'&&draft.replyTo?.id===operation.payload.reply_to_id)draft.replyTo=null;
      if (operation.payload.action === 'send' && operation.payload.media_id) { clearAttachment(draft); }
    }
    if (state.selected === key) {
      state.threadSeq++;
      if (result.thread && (!state.thread || Number(result.thread.revision) >= Number(state.thread.revision))) state.thread = result.thread;
      if (result.message) { const wasEmpty = state.messages.length === 0; state.messages = mergeMessages(state.messages, [result.message]); if (wasEmpty) $('history-state').textContent = ''; }
      if (operation.snapshot === $('message-input').value && (operation.payload.action === 'send' && state.mode === 'reply' || operation.payload.action === 'note' && state.mode === 'note')) $('message-input').value = draft[state.mode];
      renderThread(); renderMessages(); renderPending();
      setNotice('thread-notice', ['send','forward'].includes(operation.payload.action) ? 'Mensaje registrado. Su estado de entrega aparece en el historial.' : operation.payload.action === 'note' ? 'Nota privada guardada.' : 'Conversación actualizada.', 'ok');
    }
    persist(); announce(['send','forward'].includes(operation.payload.action) ? 'Mensaje registrado.' : 'Operación confirmada.');
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
        const next = { phase: 'command', state: 'pending', actor_id: operation.actor_id, snapshot: operation.snapshot, payload: { key, request_id: operation.send_request_id, revision: operation.revision, action: 'send', text: operation.snapshot.trim(), media_id: result.media_id,...(operation.replyTo?{reply_to_id:operation.replyTo.id,reply_to_version:operation.replyTo.version}:{}) } };
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
    const mime = operation.payload.recording ? file.type : attachmentType(file);
    if (file.name !== operation.payload.name || file.size !== operation.file_size || mime !== operation.payload.mime) { setNotice('thread-notice', 'El archivo no coincide con la carga pendiente. Elegí el mismo nombre, tipo y tamaño.', 'critico'); return; }
    try { const data = await fileBase64(file); if (operation.file_hash && await contentHash(data) !== operation.file_hash) throw new Error('El contenido no coincide con el archivo original.'); operation.payload.data_base64 = data; draftFor(operation.payload.key).file = file; $('pending-operation').dataset.signature = ''; renderPending(); }
    catch (error) { setNotice('thread-notice', error.message, 'critico'); }
  }
  async function fileBase64(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(text(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('No se pudo leer el archivo.')); reader.readAsDataURL(file); });
  }
  async function contentHash(value) { const bytes = new TextEncoder().encode(value); const hash = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
  async function submitMessage(event) {
    event.preventDefault(); saveText(); const key = state.selected; const thread = state.thread; if (!key || !thread || state.operations.has(key) || state.recordingPhase !== 'idle') return;
    const access = permissions(state.actor, thread); const mode = state.mode; const draft = currentDraft(); const snapshot = mode === 'reply' && audioDraft(draft) ? '' : draft[mode];
    if (!(mode === 'note' ? access.note : access.send) || (!snapshot.trim() && (mode === 'note' || !draft.file && !draft.uploaded))) return;
    if (mode === 'reply' && (draft.file || draft.uploaded) && !mediaAllowed(thread)) { setNotice('thread-notice', 'Este canal no admite archivos. Quitá el adjunto para responder con texto.', 'critico'); return; }
    const invalidCaption = mode === 'note' ? '' : captionError(draft.uploaded?.mime || (draft.file ? attachmentType(draft.file) : ''), snapshot);
    if (invalidCaption) { setNotice('thread-notice', invalidCaption, 'critico'); return; }
    setNotice('thread-notice', '');
    try {
      if (mode === 'reply' && draft.file && !draft.uploaded) {
        const error = draft.recording ? recordingError(draft.file) : attachmentError(draft.file); if (error) throw new Error(error);
        const operation = { phase: 'upload', state: 'pending', actor_id: state.actor.id, snapshot, replyTo:savedReply(draft.replyTo), revision: thread.revision, send_request_id: uuid(), file_size: draft.file.size, payload: { key, request_id: uuid(), name: draft.file.name, mime: draft.recording ? draft.file.type : attachmentType(draft.file), ...(draft.recording ? { recording: true } : {}) } };
        state.operations.set(key, operation); renderPending(); renderPermissions();
        try { operation.payload.data_base64 = await fileBase64(draft.file); operation.file_hash = await contentHash(operation.payload.data_base64); }
        catch (error) { state.operations.delete(key); renderPending(); renderPermissions(); throw error; }
        await runOperation(key, operation);
      } else await runOperation(key, { phase: 'command', state: 'pending', snapshot, payload: { key, request_id: uuid(), revision: thread.revision, action: mode === 'note' ? 'note' : 'send', text: snapshot.trim(),...(mode==='reply'&&draft.replyTo?{reply_to_id:draft.replyTo.id,reply_to_version:draft.replyTo.version}:{}), ...(mode === 'reply' && draft.uploaded ? { media_id: draft.uploaded.media_id } : {}) } });
    } catch (error) { if (state.selected === key) setNotice('thread-notice', error.message, 'critico'); }
  }
  function dialogError(id, message) { $(id).hidden = !message; $(id).textContent = message || ''; }
  function newChatFieldsLocked(locked) { for (const id of ['new-chat-number', 'new-chat-phone', 'new-chat-name']) $(id).disabled = locked; }
  function openNewChat() {
    if (!permissions(state.actor, null).write || state.newChatBusy) return;
    const connected = state.numbers.filter(number => number.connected === true);
    if (!connected.length) { setNotice('global-notice', 'Todavía no hay un número de WhatsApp conectado para iniciar una conversación.', 'atencion'); return; }
    $('new-chat-number').replaceChildren(...connected.map(number => { const option = element('option', '', `${number.number_label || 'WhatsApp'}${number.number ? ` · ${number.number}` : ''}`); option.value = number.number_id; return option; }));
    if (state.newChatOperation) {
      const payload = state.newChatOperation;
      $('new-chat-number').value = payload.number_id; $('new-chat-phone').value = payload.phone; $('new-chat-name').value = payload.name || ''; newChatFieldsLocked(true);
      $('new-chat-confirm').textContent = 'Verificar apertura';
    } else { $('new-chat-phone').value = ''; $('new-chat-name').value = ''; if (state.number && connected.some(item => item.number_id === state.number)) $('new-chat-number').value = state.number; newChatFieldsLocked(false); $('new-chat-confirm').textContent = 'Abrir conversación'; dialogError('new-chat-error', ''); }
    $('new-chat-confirm').disabled = false; $('new-chat-dialog').showModal(); if (!state.newChatOperation) $('new-chat-phone').focus();
  }
  async function startNewChat(event) {
    event.preventDefault(); if (state.newChatBusy || !permissions(state.actor, null).write) return;
    const phone = internationalPhone($('new-chat-phone').value);
    if (!state.newChatOperation && !phone) { dialogError('new-chat-error', errorMessage({ code: 'invalid_international_phone' })); return; }
    try {
      if (!state.newChatOperation) state.newChatOperation = { number_id: $('new-chat-number').value, phone, name: $('new-chat-name').value.trim(), request_id: uuid() };
      const actor = state.actor.id; state.newChatBusy = true; newChatFieldsLocked(true); $('new-chat-confirm').disabled = true; $('new-chat-confirm').textContent = 'Abriendo…'; dialogError('new-chat-error', '');
      const result = await post('/start', state.newChatOperation);
      if (state.actor?.id !== actor) return;
      if (!result.thread?.key) { const error = new Error('No llegó la confirmación del chat. Verificá la apertura con el mismo número.'); error.ambiguous = true; throw error; }
      state.newChatOperation = null; $('new-chat-dialog').close(); await selectThread(result.thread.key); if (state.actor?.id !== actor || state.selected !== result.thread.key) return; loadList().catch(() => {});
      if (!sendWindow(state.thread).allowed && canUseTemplate()) await openTemplate();
      else setNotice('thread-notice', result.created ? 'Conversación abierta. Todavía no se envió ningún mensaje.' : state.thread?.status === 'closed' ? 'Este chat ya existía y está cerrado. Reabrilo para continuar su atención.' : !permissions(state.actor, state.thread).manage ? 'Este chat ya existía. Conserva su responsable; tomalo o pedí una transferencia para atenderlo.' : 'Abrimos el historial existente. Todavía no se envió ningún mensaje.', 'info');
    } catch (error) {
      if (!error.ambiguous) state.newChatOperation = null;
      dialogError('new-chat-error', error.ambiguous ? `${error.message} Verificar apertura consulta la misma operación; no envía mensajes.` : error.message);
    } finally { state.newChatBusy = false; newChatFieldsLocked(Boolean(state.newChatOperation)); $('new-chat-confirm').disabled = false; $('new-chat-confirm').textContent = state.newChatOperation ? 'Verificar apertura' : 'Abrir conversación'; }
  }
  function selectedTemplate() { const context = state.templateContext; return context?.templates?.find(template => `${template.id}:${template.language}` === $('template-choice').value) || null; }
  function currentTemplateParameters() {
    const values = { header: [], body: [] };
    for (const input of $('template-parameters').querySelectorAll('input')) values[input.dataset.section][Number(input.dataset.index)] = input.value;
    return templateParameters(selectedTemplate(), values);
  }
  function templateInputSignature() { const template = selectedTemplate(); return JSON.stringify({ id: template?.id, language: template?.language, parameters: currentTemplateParameters() }); }
  function invalidateTemplatePreview() {
    const context = state.templateContext; if (context) { context.preview = null; context.previewSeq = (context.previewSeq || 0) + 1; }
    $('template-preview').hidden = true; $('template-opt-in').checked = false; $('template-send').disabled = true; dialogError('template-error', '');
  }
  function renderTemplateParameters() {
    invalidateTemplatePreview(); const template = selectedTemplate(); $('template-parameters').replaceChildren(); $('template-preview-button').disabled = !template;
    if (!template) return;
    const instructions = element('p', 'meta', [template.header, template.body, template.footer].filter(Boolean).join('\n\n')); instructions.style.whiteSpace = 'pre-wrap'; $('template-parameters').append(instructions);
    for (const section of ['header', 'body']) for (const [index, variable] of (template.variables?.[section] || []).entries()) {
      const label = element('label'); label.append(element('span', 'ui-label', `${section === 'header' ? 'Encabezado' : 'Mensaje'} · dato ${variable}`)); const input = element('input', 'ui-input'); input.type = 'text'; input.required = true; input.maxLength = 500; input.autocomplete = 'off'; input.dataset.section = section; input.dataset.index = index; input.addEventListener('input', invalidateTemplatePreview); label.append(input); $('template-parameters').append(label);
    }
  }
  async function openTemplate() {
    if (!canUseTemplate()) return;
    state.templateContext = { key: state.thread.key, number_id: state.thread.number_id, revision: state.thread.revision, templates: [], preview: null, previewSeq: 0 };
    $('template-recipient').textContent = `Para ${nameOf(state.thread)} · ${state.thread.phone || ''}\nDesde ${numberLabel(state.thread)}`;
    $('template-dialog').showModal(); await loadTemplates();
  }
  async function loadTemplates() {
    const context = state.templateContext; if (!context) return; const seq = ++state.templateSeq; invalidateTemplatePreview(); context.templates = [];
    $('template-parameters').replaceChildren(); $('template-choice').replaceChildren(element('option', '', 'Consultando Meta…')); $('template-choice').disabled = true; $('template-preview-button').disabled = true; $('template-refresh').disabled = true; $('template-state').textContent = 'Buscando plantillas para este número…';
    try {
      const result = await api(`/templates?${new URLSearchParams({ number_id: context.number_id })}`);
      if (context !== state.templateContext || seq !== state.templateSeq) return;
      const templates = Array.isArray(result.templates) ? result.templates : []; context.templates = templates.filter(template => template.status === 'APPROVED' && template.supported === true);
      const first = element('option', '', context.templates.length ? 'Elegí una plantilla' : 'Sin plantillas disponibles'); first.value = '';
      $('template-choice').replaceChildren(first, ...context.templates.map(template => { const option = element('option', '', `${template.name} · ${template.language}`); option.value = `${template.id}:${template.language}`; return option; }));
      const pending = templates.filter(template => template.status === 'PENDING').length; const unsupported = templates.filter(template => template.status === 'APPROVED' && !template.supported).length;
      $('template-state').textContent = [context.templates.length ? `${context.templates.length} ${context.templates.length === 1 ? 'plantilla disponible' : 'plantillas disponibles'}.` : 'No hay una plantilla aprobada que pueda enviarse desde esta bandeja.', pending ? `${pending} ${pending === 1 ? 'plantilla espera' : 'plantillas esperan'} aprobación de Meta.` : '', unsupported ? 'Las plantillas con archivos, botones o formatos no admitidos no se ofrecen para enviar.' : '', result.more ? 'Meta tiene más resultados que los disponibles en esta consulta.' : '', 'Podés cerrar y continuar cuando esté disponible.'].filter(Boolean).join(' ');
      $('template-choice').disabled = !context.templates.length;
    } catch (error) { if (context === state.templateContext && seq === state.templateSeq) { $('template-state').textContent = 'No se pudo consultar el catálogo.'; dialogError('template-error', error.message); } }
    finally { if (context === state.templateContext && seq === state.templateSeq) $('template-refresh').disabled = false; }
  }
  async function previewTemplate() {
    const context = state.templateContext; const template = selectedTemplate(); if (!context || !template || !canUseTemplate() || context.key !== state.selected) return;
    if (![...$('template-parameters').querySelectorAll('input')].every(input => input.reportValidity())) return;
    invalidateTemplatePreview(); const seq = context.previewSeq; const signature = templateInputSignature(); const parameters = currentTemplateParameters(); $('template-preview-button').disabled = true;
    try {
      const result = await post('/template-preview', { key: context.key, template_id: template.id, language: template.language, parameters });
      if (context !== state.templateContext || seq !== context.previewSeq || signature !== templateInputSignature()) return;
      const preview = templatePreviewText(result.preview);
      if (!preview || !result.fingerprint || String(result.template_id) !== String(template.id) || result.language !== template.language) throw new Error('No se pudo confirmar el contenido completo de la plantilla. Volvé a consultarla.');
      context.preview = { text: preview, fingerprint: result.fingerprint, signature, parameters, id: template.id, language: template.language }; context.revision = state.thread.revision;
      $('template-preview-text').textContent = preview; $('template-preview').hidden = false; $('template-state').textContent = 'Revisá el mensaje completo y confirmá la autorización del cliente para enviarlo.';
    } catch (error) { if (context === state.templateContext && seq === context.previewSeq) dialogError('template-error', error.message); }
    finally { if (context === state.templateContext) $('template-preview-button').disabled = !selectedTemplate(); }
  }
  async function sendTemplate(event) {
    event.preventDefault(); const context = state.templateContext; const preview = context?.preview;
    if (!preview || context.key !== state.selected || !canUseTemplate() || !$('template-opt-in').checked || preview.signature !== templateInputSignature()) return;
    const payload = { key: context.key, request_id: uuid(), revision: context.revision, action: 'send', template: { id: preview.id, language: preview.language, parameters: preview.parameters, fingerprint: preview.fingerprint }, opt_in: true };
    $('template-send').disabled = true; $('template-dialog').close(); state.templateContext = null;
    await runOperation(context.key, { phase: 'command', state: 'pending', template_preview: preview.text, payload });
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
      if (changedActor) { stopAudioResources(true); persist(); state.drafts = new Map(); state.operations = new Map(); state.newChatOperation = null; state.templateContext = null; $('new-chat-dialog').close(); $('template-dialog').close(); $('forward-dialog').close(); forwardContext=null; forwardSequence++; state.storageKey = storageKey; restore(); }
      state.actor = result.actor; if (changedActor) restoreWidth(); state.csrf = result.csrf || ''; state.agents = Array.isArray(result.agents) ? result.agents : [];
      $('actor-name').textContent = state.actor.name; $('actor-role').textContent = ROLES[state.actor.role]; $('presence-field').hidden = !permissions(state.actor, null).write; $('team').hidden = state.actor.role !== 'supervisor'; $('admin-recovery').hidden = !state.actor.can_restore_supervision || state.actor.role === 'supervisor';
      if (state.actor.role !== 'supervisor') $('team-dialog').close();
      if (changedActor) restoreComposer();
      renderPermissions(); renderPending();
    } catch (error) {
      stopAudioResources(true); state.actor = null; state.csrf = ''; clearTimeout(state.pollTimer); $('team-dialog').close(); $('new-chat-dialog').close(); $('template-dialog').close(); $('forward-dialog').close(); forwardContext=null; forwardSequence++; $('team').hidden = true; $('admin-recovery').hidden=true; $('presence-field').hidden = true; $('actor-role').textContent = 'Acceso pendiente de confirmar'; renderPermissions(); renderPending(); setNotice('global-notice', error.message, 'critico');
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
      if (state.storageKey && state.storageKey !== storageKey) { stopAudioResources(true); persist(); state.drafts = new Map(); state.operations = new Map(); state.newChatOperation = null; state.templateContext = null; $('new-chat-dialog').close(); $('template-dialog').close(); $('forward-dialog').close(); forwardContext=null; forwardSequence++; }
      state.storageKey = storageKey; restore(); restoreWidth();
      $('actor-name').textContent = state.actor.name; $('actor-role').textContent = ROLES[state.actor.role]; $('presence-field').hidden = !permissions(state.actor, null).write; $('team').hidden = state.actor.role !== 'supervisor'; $('admin-recovery').hidden = !state.actor.can_restore_supervision || state.actor.role === 'supervisor';
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
  function resetList() { $('source-summary').textContent = state.channel === 'web' ? 'Chat web' : state.number ? `WhatsApp · ${$('number').selectedOptions[0]?.textContent || 'Número seleccionado'}` : state.channel === 'whatsapp' ? 'WhatsApp · Todos los números' : 'Todos los canales y números'; state.listSeq++; state.listPages = 1; state.threads = []; state.listMore = false; state.lastListError = ''; $('thread-list').replaceChildren(); $('list-state').hidden = false; $('list-state').textContent = 'Buscando conversaciones…'; loadList().catch(() => {}); }
  $('filters').addEventListener('click', event => { const button = event.target.closest('[data-filter]'); if (!button || button.dataset.filter === state.filter) return; state.filter = button.dataset.filter; for (const tab of $('filters').querySelectorAll('button')) tab.setAttribute('aria-pressed', text(tab === button)); resetList(); });
  $('load-list').addEventListener('click', () => loadList({ more: true }).catch(() => {}));
  $('load-older').addEventListener('click', () => loadThread({ older: true }).catch(error => setNotice('thread-notice', error.message, 'critico')));
  $('back').addEventListener('click', () => { saveText(); stopAudioResources(); $('workspace').classList.remove('has-selection'); $('inbox').focus({ preventScroll: true }); });
  $('reply-cancel').addEventListener('click',()=>{currentDraft().replyTo=null;persist();renderReplyContext();});
  $('forward-cancel').addEventListener('click',()=>{$('forward-dialog').close();forwardContext=null;forwardSequence++;});
  $('forward-dialog').addEventListener('cancel',()=>{forwardContext=null;forwardSequence++;});
  $('forward-form').addEventListener('submit',confirmForward);
  $('forward-search').addEventListener('input',()=>{clearTimeout(forwardSearchTimer);forwardSearchTimer=setTimeout(searchForward,250);});
  $('reply-mode').addEventListener('click', () => switchMode('reply')); $('note-mode').addEventListener('click', () => switchMode('note'));
  $('message-input').addEventListener('input', () => { saveText(); renderPermissions(); });
  $('message-input').addEventListener('keydown', event => {
    if (shouldSendOnEnter(event, { disabled: $('send').disabled || $('message-input').disabled, pending: state.operations.has(state.selected) || state.recordingPhase !== 'idle', audio: state.mode === 'reply' && audioDraft(currentDraft()) })) { event.preventDefault(); $('composer').requestSubmit($('send')); }
  });
  $('composer').addEventListener('submit', submitMessage);
  for (const kind of ['product', 'invoice', 'tracking']) $(`share-${kind}`).addEventListener('click', () => openShare(kind));
  $('product-search').addEventListener('input', scheduleProductSearch);
  $('product-stock').addEventListener('change', scheduleProductSearch);
  $('product-search').addEventListener('keydown', event => { if (event.key === 'ArrowDown') { const first = $('share-results').querySelector('button'); if (first) { event.preventDefault(); first.focus(); } } });
  $('share-results').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const choices = [...$('share-results').querySelectorAll('button:not(:disabled)')]; const index = choices.indexOf(event.target); if (index < 0) return;
    event.preventDefault(); choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus();
  });
  $('share-back').addEventListener('click', shareBack); $('share-add').addEventListener('click', addSharedDraft);
  $('share-retry').addEventListener('click', () => { const context = state.shareContext; if (currentShare(context) && !context.busy) context.retry?.(); });
  $('share-cancel').addEventListener('click', () => closeShare()); $('share-close').addEventListener('click', () => closeShare());
  $('share-dialog').addEventListener('cancel', () => closeShare()); $('share-dialog').addEventListener('close', () => { if (!$('share-dialog').open) closeShare(); });
  $('attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => { const file = $('file-input').files?.[0]; if (!file || state.operations.has(state.selected) || state.recordingPhase !== 'idle' || !mediaAllowed(state.thread) || !permissions(state.actor, state.thread).send) return; const error = attachmentError(file); if (error) { setNotice('thread-notice', error, 'critico'); $('file-input').value = ''; return; } clearAttachment(currentDraft()); currentDraft().file = file; setNotice('thread-notice', ''); renderPermissions(); });
  $('remove-file').addEventListener('click', () => { if (state.operations.has(state.selected)) return; clearAttachment(currentDraft()); $('file-input').value = ''; renderPermissions(); });
  $('record-audio').addEventListener('click', beginRecording); $('stop-recording').addEventListener('click', () => capture.stop());
  $('discard-recording').addEventListener('click', () => { if (state.operations.has(state.selected)) return; stopAudioResources(); clearAttachment(currentDraft()); renderPermissions(); announce('Audio descartado. Tu texto se conserva.'); });
  $('new-chat').addEventListener('click', openNewChat); $('new-chat-form').addEventListener('submit', startNewChat); $('new-chat-cancel').addEventListener('click', () => $('new-chat-dialog').close());
  $('use-template').addEventListener('click', openTemplate); $('template-refresh').addEventListener('click', loadTemplates); $('template-choice').addEventListener('change', renderTemplateParameters); $('template-preview-button').addEventListener('click', previewTemplate); $('template-form').addEventListener('submit', sendTemplate);
  $('template-form').addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.tagName === 'INPUT') event.preventDefault(); });
  $('template-opt-in').addEventListener('change', () => { const preview = state.templateContext?.preview; $('template-send').disabled = !$('template-opt-in').checked || !preview || preview.signature !== templateInputSignature() || !canUseTemplate(); });
  $('template-cancel').addEventListener('click', () => $('template-dialog').close()); $('template-dialog').addEventListener('close', () => { state.templateContext = null; state.templateSeq++; });
  for (const action of ['take', 'transfer', 'release', 'close', 'reopen', 'pause', 'resume']) $(action).addEventListener('click', () => openAction(action));
  $('dialog-cancel').addEventListener('click', () => $('action-dialog').close());
  $('action-form').addEventListener('submit', event => { event.preventDefault(); const context = state.dialogAction; if (!context) return; const target = context.action === 'transfer' ? state.agents.find(agent => String(agent.id) === $('transfer-target').value) : null; if (context.action === 'transfer' && !target) return; $('action-dialog').close(); issueCommand(context.action, target, context); });
  $('presence').addEventListener('change', async () => { const value = $('presence').value; const previous = $('presence').dataset.confirmed || 'offline'; state.presenceSeq++; state.presencePosting = true; state.presencePostAt = Date.now(); $('presence').disabled = true; try { await sendPresence(value); $('presence').dataset.confirmed = value; announce(`Disponibilidad: ${PRESENCE[value]}`); } catch (error) { $('presence').value = previous; setNotice('global-notice', error.message, 'critico'); } finally { state.presencePosting = false; $('presence').disabled = false; } });
  $('copy-phone').addEventListener('click', async () => { if (!state.thread?.phone) return; try { await navigator.clipboard.writeText(text(state.thread.phone)); announce('Teléfono copiado.'); setNotice('thread-notice', 'Teléfono de contacto copiado.', 'ok'); } catch { setNotice('thread-notice', `Copiá el teléfono desde la ficha: ${state.thread.phone}`, 'info'); } });
  $('restore-supervision').addEventListener('click',async()=>{const b=$('restore-supervision');b.disabled=true;try{await post('/restore-supervision',{});await reloadIdentity();await loadStatus();setNotice('global-notice','Recuperaste la supervisión de Mensajería.','ok');}catch(e){setNotice('global-notice',e.message,'critico');}finally{b.disabled=false;}});
  $('team').addEventListener('click', openTeam); $('team-close').addEventListener('click', () => $('team-dialog').close());
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(state.pollTimer); saveText(); } else if (state.actor) refresh(); });
  window.addEventListener('online', () => { if (state.actor) refresh(); });
  window.addEventListener('pagehide', () => { saveText(); stopAudioResources(true); clearTimeout(state.pollTimer); });
  bootstrap();
}
