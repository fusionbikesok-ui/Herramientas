// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sendWindow, permissions, mergeMessages, oldestMessageId, reconcileHistoryPage, attachmentType, attachmentError, captionError, deliveryLabel, errorMessage } from '../public/mensajeria/app.js';

const now = Date.parse('2026-10-07T15:00:00.000Z');
const actor = { id: 'herramientas:agent-a', name: 'Agente de prueba', role: 'agent' };
const thread = { key: 'whatsapp:test', owner_id: actor.id, status: 'open', last_inbound_at: '2026-10-07T14:00:00.000Z' };
const file = (name, type, size = 100) => ({ name, type, size });

describe('Mensajería UI: permisos basados en la sesión', () => {
  it('un lector no puede operar aunque sea el propietario o can_send sea true', () => {
    const result = permissions({ ...actor, role: 'reader' }, { ...thread, can_send: true }, now);
    expect(result).toMatchObject({ write: false, manage: false, control: false, take: false, send: false, note: false });
  });
  it('un agente dueño puede responder y guardar notas durante la ventana', () => {
    expect(permissions(actor, thread, now)).toMatchObject({ owner: true, manage: true, send: true, note: true });
  });
  it('un agente no puede responder ni gestionar la conversación de otro', () => {
    expect(permissions(actor, { ...thread, owner_id: 'herramientas:agent-b', can_send: true }, now)).toMatchObject({ owner: false, manage: false, control: false, send: false, note: false, take: false });
  });
  it('la supervisión puede atender o reasignar conversaciones de otro', () => {
    expect(permissions({ ...actor, role: 'supervisor' }, { ...thread, owner_id: 'herramientas:agent-b' }, now)).toMatchObject({ supervisor: true, manage: true, control: true, send: true });
  });
  it('sin responsable permite tomar y controlar IA, pero no enviar como dueño', () => {
    expect(permissions(actor, { ...thread, owner_id: null }, now)).toMatchObject({ take: true, control: true, manage: false, send: false, note: false });
  });
  it('una conversación cerrada permite notas del dueño pero no envío ni toma', () => {
    expect(permissions(actor, { ...thread, status: 'closed', can_send: true }, now)).toMatchObject({ send: false, take: false, note: true, control: true });
  });
  it('roles desconocidos, sesión ausente y conversación ausente no habilitan envíos', () => {
    expect(permissions({ ...actor, role: 'admin' }, thread, now).write).toBe(false);
    expect(permissions(null, thread, now).send).toBe(false);
    expect(permissions(actor, null, now).send).toBe(false);
  });
});

describe('Mensajería UI: ventana de atención conservadora', () => {
  it('acepta el límite anterior a 24 h y bloquea exactamente 24 h', () => {
    expect(sendWindow({ last_inbound_at: new Date(now - 86400000 + 1).toISOString() }, now).allowed).toBe(true);
    expect(sendWindow({ last_inbound_at: new Date(now - 86400000).toISOString() }, now).allowed).toBe(false);
  });
  it.each([undefined, '', 'fecha inválida', '2026-10-08T00:00:00Z'])('bloquea una fecha ausente, inválida o futura: %s', value => {
    expect(sendWindow({ last_inbound_at: value }, now).allowed).toBe(false);
  });
  it('respeta can_send explícito del servidor y traduce el motivo', () => {
    expect(sendWindow({ can_send: true }, now).allowed).toBe(true);
    const blocked = sendWindow({ ...thread, can_send: false, send_blocked_reason: 'number_not_connected' }, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.label).toContain('no está conectado');
    expect(blocked.label).not.toContain('number_not_connected');
  });
  it('un motivo desconocido no habilita envíos ni filtra códigos internos', () => {
    expect(sendWindow({ can_send: false, send_blocked_reason: 'internal_unconfirmed_state' }, now)).toMatchObject({ allowed: false });
    expect(sendWindow({ can_send: false, send_blocked_reason: 'internal_unconfirmed_state' }, now).label).not.toContain('internal_unconfirmed_state');
  });
  it('supervisión también respeta la ventana de 24 horas', () => {
    expect(permissions({ ...actor, role: 'supervisor' }, { ...thread, last_inbound_at: '2026-10-01T00:00:00Z' }, now).send).toBe(false);
  });
});

describe('Mensajería UI: historial y entrega', () => {
  it('mezcla páginas, elimina duplicados y ordena por fecha sin mutar las entradas', () => {
    const previous = [{ id: '2', text: 'Dos', created_at: '2026-10-07T12:00:00Z', status: 'sent' }];
    const incoming = [{ id: '1', text: 'Uno', created_at: '2026-10-07T11:00:00Z' }, { id: '2', created_at: '2026-10-07T12:00:00Z', status: 'delivered' }];
    const merged = mergeMessages(previous, incoming);
    expect(merged.map(message => message.id)).toEqual(['1', '2']);
    expect(merged[1]).toMatchObject({ text: 'Dos', status: 'delivered' });
    expect(previous[0].status).toBe('sent');
  });
  it('ordena IDs numéricos cuando comparten fecha', () => {
    expect(mergeMessages([], [{ id: '10', created_at: '2026-10-07T12:00:00Z' }, { id: '2', created_at: '2026-10-07T12:00:00Z' }]).map(message => message.id)).toEqual(['2', '10']);
  });
  it.each([['read', 'sent', 'read'], ['delivered', 'queued', 'delivered'], ['delivered', 'unknown', 'delivered'], ['unknown', 'queued', 'unknown'], ['failed', 'sending', 'failed'], ['cancelled', 'queued', 'cancelled'], ['unknown', 'delivered', 'delivered'], ['sent', 'failed', 'failed'], ['queued', 'sent', 'sent']])('estado %s con actualización %s resulta %s', (oldStatus, status, expected) => {
    expect(mergeMessages([{ id: '1', status: oldStatus }], [{ id: '1', status }])[0].status).toBe(expected);
  });
  it('pagina desde la fecha más antigua aunque un histórico importado tenga el ID mayor', () => {
    expect(oldestMessageId([{ id: '9007199254740993', created_at: '2020-01-01' }, { id: '9007199254740992', created_at: '2026-10-01' }])).toBe('9007199254740993');
    expect(oldestMessageId([])).toBeNull();
  });
  it('el cursor coincide con el primer mensaje de una cronología mixta con históricos tardíos', () => {
    const messages = mergeMessages([{ id: '12', created_at: '2026-10-07T12:00:00Z' }, { id: '13', created_at: '2026-10-07T13:00:00Z' }], [{ id: '110', created_at: '2026-10-01T10:00:00Z' }, { id: '109', created_at: '2026-10-01T10:00:00Z' }, { id: '111', created_at: '2026-10-06T10:00:00Z' }]);
    expect(messages.map(message => message.id)).toEqual(['109', '110', '111', '12', '13']);
    expect(oldestMessageId(messages)).toBe('109');
    expect(oldestMessageId([...messages].reverse())).toBe('109');
  });
  it('desempata fechas iguales con IDs completos sin perder precisión', () => {
    expect(oldestMessageId([{ id: '9007199254740993', created_at: '2020-01-01' }, { id: '9007199254740992', created_at: '2020-01-01' }])).toBe('9007199254740992');
  });
  it.each(['queued', 'sent', 'delivered', 'read', 'failed', 'unknown', 'cancelled'])('muestra texto de entrega para %s', status => {
    expect(deliveryLabel(status)).not.toBe('Estado pendiente de confirmar');
    expect(deliveryLabel(status)).not.toBe('');
  });
  it('un estado cancelado es final y no se presenta como en cola', () => {
    expect(deliveryLabel('cancelled')).toContain('Cancelado');
    expect(deliveryLabel('cancelled')).not.toContain('cola');
  });
  it('no expone códigos internos en errores desconocidos', () => {
    expect(errorMessage({ code: 'unknown_internal', error: 'unknown_internal' })).not.toContain('unknown_internal');
    expect(errorMessage({ code: 'revision_conflict', error: 'revision_conflict' })).toContain('cambió');
    expect(errorMessage({ error: 'Tu sesión venció.' })).toBe('Tu sesión venció.');
  });
});

describe('Mensajería UI: páginas del historial después de reconectar', () => {
  const messages = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => {
    const id = first + index;
    return { id: String(id), created_at: new Date(now + id * 60000).toISOString(), text: `Mensaje ${id}` };
  });
  it('reinicia una página sin solapamiento y permite recuperar el hueco 21..40', () => {
    const refreshed = reconcileHistoryPage(messages(1, 20), messages(41, 90), { more: true, knownMore: false });
    expect(refreshed.reset).toBe(true);
    expect(refreshed.more).toBe(true);
    expect(refreshed.messages.map(message => message.id)).toEqual(messages(41, 90).map(message => message.id));
    expect(oldestMessageId(refreshed.messages)).toBe('41');
    const previousPage = reconcileHistoryPage(refreshed.messages, messages(1, 40), { older: true, more: false, knownMore: true });
    expect(previousPage.messages.map(message => message.id)).toEqual(messages(1, 90).map(message => message.id));
    expect(previousPage.more).toBe(false);
  });
  it('conserva páginas anteriores cuando el refresco tiene solapamiento', () => {
    const refreshed = reconcileHistoryPage(messages(1, 60), messages(31, 80), { more: true, knownMore: true });
    expect(refreshed.reset).toBe(false);
    expect(refreshed.messages.map(message => message.id)).toEqual(messages(1, 80).map(message => message.id));
    expect(refreshed.more).toBe(true);
  });
  it('habilita anteriores cuando una conversación corta recibe más de 50 mensajes históricos', () => {
    const recent = messages(1, 20);
    const lateImport = Array.from({ length: 60 }, (_, index) => ({ id: String(101 + index), created_at: new Date(now - (60 - index) * 60000).toISOString() }));
    const latestPage = [...lateImport.slice(30), ...recent];
    const refreshed = reconcileHistoryPage(recent, latestPage, { more: true, knownMore: false });
    expect(refreshed.reset).toBe(false);
    expect(refreshed.more).toBe(true);
    expect(refreshed.probeBefore).toBeNull();
    expect(oldestMessageId(refreshed.messages)).toBe('131');
    const earlier = reconcileHistoryPage(refreshed.messages, lateImport.slice(0, 30), { older: true, more: false, knownMore: true });
    expect(earlier.messages).toHaveLength(80);
    expect(oldestMessageId(earlier.messages)).toBe('101');
    expect(earlier.more).toBe(false);
  });
  it('no vuelve a anunciar páginas ya cargadas después de llegar al principio', () => {
    const previous = messages(1, 90);
    const incoming = messages(41, 90);
    const plan = reconcileHistoryPage(previous, incoming, { more: true, knownMore: false });
    expect(plan.probeBefore).toBe('1');
    expect(plan.more).toBe(false);
    const confirmed = reconcileHistoryPage(previous, incoming, { more: true, knownMore: false, earlierExists: false });
    expect(confirmed.more).toBe(false);
    expect(confirmed.probeBefore).toBeNull();
    expect(confirmed.messages).toHaveLength(90);
  });
  it('detecta una nueva importación anterior al cursor de un historial que ya estaba completo', () => {
    const refreshed = reconcileHistoryPage(messages(1, 90), messages(41, 90), { more: true, knownMore: false, earlierExists: true });
    expect(refreshed.more).toBe(true);
    expect(refreshed.reset).toBe(false);
    expect(oldestMessageId(refreshed.messages)).toBe('1');
    const imported = [{ id: '500', created_at: new Date(now - 60000).toISOString() }];
    const earlier = reconcileHistoryPage(refreshed.messages, imported, { older: true, more: false, knownMore: true });
    expect(oldestMessageId(earlier.messages)).toBe('500');
    expect(earlier.messages).toHaveLength(91);
    expect(earlier.more).toBe(false);
  });
});

describe('Mensajería UI: archivos y texto adjunto', () => {
  it.each([['foto.jpg', 'image/jpeg'], ['foto.png', 'image/png'], ['foto.webp', 'image/webp'], ['documento.pdf', 'application/pdf'], ['audio.mp3', 'audio/mpeg'], ['audio.ogg', 'audio/ogg'], ['audio.m4a', 'audio/mp4'], ['audio.aac', 'audio/aac'], ['video.mp4', 'video/mp4']])('admite el tipo declarado %s', (name, type) => {
    expect(attachmentType(file(name, type))).toBe(type);
    expect(attachmentError(file(name, type))).toBe('');
  });
  it('rechaza ejecutables, extensiones desconocidas y MIME no permitido', () => {
    expect(attachmentType(file('programa.exe', 'image/png'))).toBe('');
    expect(attachmentType(file('documento.html', 'text/html'))).toBe('');
    expect(attachmentType(file('documento.pdf', 'text/html'))).toBe('');
  });
  it('normaliza los MIME alternativos comunes de grabaciones', () => {
    expect(attachmentType(file('audio.m4a', 'audio/x-m4a'))).toBe('audio/mp4');
    expect(attachmentType(file('audio.ogg', 'application/ogg'))).toBe('audio/ogg');
    expect(attachmentType(file('documento.pdf', ''))).toBe('application/pdf');
  });
  it('limita imágenes a 5 MB y el resto a 16 MB, incluidos los límites exactos', () => {
    expect(attachmentError(file('foto.png', 'image/png', 5 * 1024 * 1024))).toBe('');
    expect(attachmentError(file('foto.png', 'image/png', 5 * 1024 * 1024 + 1))).toContain('5 MB');
    expect(attachmentError(file('video.mp4', 'video/mp4', 16 * 1024 * 1024))).toBe('');
    expect(attachmentError(file('video.mp4', 'video/mp4', 16 * 1024 * 1024 + 1))).toContain('16 MB');
    expect(attachmentError(file('vacío.pdf', 'application/pdf', 0))).toContain('vacío');
  });
  it('los audios no admiten caption; las imágenes y PDF admiten hasta 1024 caracteres', () => {
    expect(captionError('audio/ogg', 'Texto')).toContain('sin texto');
    expect(captionError('audio/mp4', ' ')).toBe('');
    expect(captionError('image/png', 'x'.repeat(1024))).toBe('');
    expect(captionError('application/pdf', 'x'.repeat(1025))).toContain('1024');
    expect(captionError('', 'x'.repeat(4096))).toBe('');
  });
});
