// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { customerWindowOpen, templateOffered, sharedDraft, shareContextCurrent, productPrice, productStock, requestTimeout, savedAttachment, invoiceDate } from '../public/mensajeria/app.js';

const now = Date.parse('2026-10-07T15:00:00Z');
const actor = { id: 'herramientas:jose', role: 'agent' };
const thread = { key: 'whatsapp:test', channel: 'whatsapp', owner_id: actor.id, phone: '+5493511234567', number_id: 'line-1', status: 'open', can_send: true, can_send_template: true, last_inbound_at: '2026-10-07T14:00:00Z', capabilities: { media: true } };
const context = { key: thread.key, actor_id: actor.id, epoch: 2, phone: thread.phone, number_id: thread.number_id, kind: 'invoice' };
const current = { actor, thread, selected: thread.key, selectionEpoch: 2, mode: 'reply', pending: false, recording: false };
const pdf = { media_id: 'pdf-safe-id', mime: 'application/pdf', name: 'Factura.pdf' };

describe('Persistencia privada del PDF preparado',()=>{
  it('muestra la fecha fiscal sin desplazarla al día anterior por huso horario',()=>{expect(invoiceDate('2026-10-07')).toBe('07/10/2026');expect(invoiceDate('20261007')).toBe('07/10/2026');});
  it('conserva solo la referencia del PDF al serializar y recuperar la pestaña',()=>{
    const saved=JSON.parse(JSON.stringify({uploaded:savedAttachment({...pdf,data_base64:'secret bytes',phone:'other'})}));
    expect(savedAttachment(saved.uploaded)).toEqual(pdf);
    expect(saved.uploaded).not.toHaveProperty('data_base64');
    expect(saved.uploaded).not.toHaveProperty('phone');
  });
  it.each([null,{...pdf,media_id:'../private'},{...pdf,mime:'text/html'},{...pdf,name:'x'.repeat(181)}])('rechaza referencias inválidas %#',value=>expect(savedAttachment(value)).toBeNull());
});

describe('Plantillas solo cuando cerró la ventana del cliente', () => {
  it('oculta Plantilla durante las 24 horas, aunque Meta permita técnicamente la plantilla', () => {
    expect(customerWindowOpen(thread, now)).toBe(true);
    expect(templateOffered(actor, thread, now)).toBe(false);
  });
  it('a las 24 horas permite Plantilla y no usa el último outbound para renovar la ventana', () => {
    const closedWindow = { ...thread, last_inbound_at: '2026-10-06T15:00:00Z', last_outbound_at: '2026-10-07T14:59:00Z', can_send: false, send_blocked_reason: 'window_closed' };
    expect(customerWindowOpen(closedWindow, now)).toBe(false);
    expect(templateOffered(actor, closedWindow, now)).toBe(true);
    expect(templateOffered(actor, { ...closedWindow, last_inbound_at: '2026-10-06T15:00:00.001Z' }, now)).toBe(false);
  });
  it('un chat nuevo sin inbound puede iniciar con plantilla autorizada', () => {
    expect(templateOffered(actor, { ...thread, last_inbound_at: null }, now)).toBe(true);
  });
  it.each(['invalid', '2026-10-08T15:00:00Z'])('no interpreta una fecha desconocida o futura como ventana cerrada: %s', date => {
    expect(templateOffered(actor, { ...thread, last_inbound_at: date }, now)).toBe(false);
  });
  it.each([{ role: 'reader' }, { id: 'another-agent' }])('exige permiso de atención: %j', change => {
    expect(templateOffered({ ...actor, ...change }, { ...thread, last_inbound_at: null }, now)).toBe(false);
  });
  it.each([{ channel: 'web' }, { status: 'closed' }, { can_send_template: false }])('respeta canal, estado y permiso backend: %j', change => {
    expect(templateOffered(actor, { ...thread, last_inbound_at: null, ...change }, now)).toBe(false);
  });
});

describe('Contenido compartido sin perder el borrador ni enviar', () => {
  it('agrega texto separado y conserva nota privada y adjunto originales sin mutarlos', () => {
    const original = { reply: 'Hola Ana', note: 'Nota privada', uploaded: pdf };
    const merged = sharedDraft(original, { text: 'Este es el producto\nhttps://fusionbikes.com.ar/producto/test/' });
    expect(merged.reply).toBe('Hola Ana\n\nEste es el producto\nhttps://fusionbikes.com.ar/producto/test/');
    expect(merged.uploaded).toBe(pdf);
    expect(original).toEqual({ reply: 'Hola Ana', note: 'Nota privada', uploaded: pdf });
  });
  it('prepara una factura como PDF con el texto existente, sin sobrescribir', () => {
    expect(sharedDraft({ reply: 'Hola' }, { text: 'Tu factura', media: pdf })).toEqual({ reply: 'Hola\n\nTu factura', uploaded: pdf });
  });
  it.each([{ uploaded: pdf }, { file: { name: 'foto.jpg', type: 'image/jpeg' } }])('bloquea reemplazar un adjunto por la factura: %j', draft => {
    expect(sharedDraft(draft, { text: 'Tu factura', media: pdf }).error).toContain('Ya tenés un archivo');
  });
  it('no trunca ni sobrescribe un texto que excede el máximo', () => {
    const draft = { reply: 'a'.repeat(4090) };
    expect(sharedDraft(draft, { text: 'Producto' }).error).toContain('4096');
    expect(draft.reply).toHaveLength(4090);
  });
  it('respeta el máximo de caption de un PDF', () => {
    expect(sharedDraft({ reply: 'a'.repeat(1020) }, { text: 'Tu factura', media: pdf }).error).toContain('1024');
    expect(sharedDraft({ reply: '' }, { text: 'a'.repeat(1024), media: pdf }).reply).toHaveLength(1024);
  });
  it.each([{ uploaded: { mime: 'audio/ogg' } }, { recording: true, file: { name: 'audio.webm', type: 'audio/webm;codecs=opus' } }])('no agrega caption a un audio listo: %j', draft => {
    expect(sharedDraft(draft, { text: 'Producto' }).error).toContain('sin texto');
  });
});

describe('Respuesta asincrónica ligada al contacto y agente', () => {
  it('acepta una respuesta del contexto vigente con permiso', () => expect(shareContextCurrent(context, current)).toBe(true));
  it.each([
    { selected: 'other-thread' }, { selectionEpoch: 3 }, { actor: { ...actor, id: 'other-agent' } },
    { actor: { ...actor, role: 'reader' } }, { mode: 'note' }, { pending: true }, { recording: true },
    { thread: { ...thread, phone: '+5493517654321' } }, { thread: { ...thread, number_id: 'line-2' } },
    { thread: { ...thread, key: 'other-thread' } }, { thread: { ...thread, owner_id: 'other-agent' } },
    { thread: { ...thread, status: 'closed' } }, { thread: { ...thread, can_send: false, send_blocked_reason: 'window_closed' } },
    { thread: { ...thread, capabilities: { media: false } } }, { actor: null }, { thread: null }
  ])('descarta preparación si cambia el contexto o el permiso: %j', change => {
    expect(shareContextCurrent(context, { ...current, ...change })).toBe(false);
  });
  it('el chat web solo permite productos y seguimiento, nunca un PDF fiscal', () => {
    const web = { ...current, thread: { ...thread, channel: 'web', capabilities: { media: false } } };
    expect(shareContextCurrent(context, web)).toBe(false);
    for (const kind of ['product', 'tracking']) expect(shareContextCurrent({ ...context, kind }, web)).toBe(true);
  });
});

describe('Información comercial sin inventar ceros', () => {
  it.each([null, undefined, '', 'unavailable'])('precio desconocido queda a confirmar: %s', value => expect(productPrice(value)).toBe('Precio a confirmar'));
  it('formatea el precio web de ejemplo sin alterarlo', () => expect(productPrice(4450000)).toContain('4.450.000'));
  it.each([null, undefined, '', { quantity: null, status: 'unknown' }])('stock desconocido queda a confirmar: %j', value => expect(productStock(value)).toBe('Stock a confirmar'));
  it('distingue cero, stock positivo y estados', () => {
    expect(productStock(0)).toBe('Sin stock'); expect(productStock(3)).toBe('Stock: 3');
    expect(productStock('instock')).toBe('Disponible'); expect(productStock('onbackorder')).toBe('Por encargo');
  });
  it('da tiempo al PDF sin cambiar el timeout de envío', () => { expect(requestTimeout('/commerce/prepare')).toBe(70000); expect(requestTimeout('/command')).toBe(25000); });
});
