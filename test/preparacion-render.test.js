import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function extraerScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return scripts.reduce((a, b) => (b.length > a.length ? b : a));
}

function documentoFake() {
  const elementos = new Map();
  return {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, {
        innerHTML: '', textContent: '', classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {}, removeEventListener() {}, focus() {}, contains() { return false; },
      });
      return elementos.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

let ctx;

beforeEach(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
  const document = documentoFake();
  const sandbox = {
    document, window: null, console, Date, Math, JSON, setTimeout, clearTimeout,
    setInterval() { return 1; }, clearInterval() {},
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: { href: '', pathname: '/preparacion/', search: '' },
    fetch: vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, is_admin: 1, user: 'tester' }) })),
    alert() {}, confirm() { return true; },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/format.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/lib/api.js'), 'utf8'), ctx);
  vm.runInContext(extraerScript(html), ctx, { filename: 'preparacion-inline.js' });
  ctx.PEND_BASELINE_LISTA = false;
  ctx.PEND_NUEVOS = {};
  ctx.PEND_CACHE = [];
});

describe('preparacion/index.html — render de pedidos nuevos', () => {
  it('ofrece recarga explícita cuando guardar horarios recibe VERSION_CONFLICT', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(html).toContain("r.status===409 && r.body.code==='VERSION_CONFLICT'");
    expect(html).toContain("recargar.textContent='Recargar horarios'");
    expect(html).toContain('recargar.onclick=cargarHorarios');
  });
  it('no marca la carga inicial y marca un pedido aparecido en el polling con tiempo transcurrido', () => {
    const pedido = { canal: 'web', wc_order_id: 901, numero_pedido: '901', comprador: 'Ana', fecha: '2026-08-28T12:00:00Z', items: [] };
    ctx.registrarPendientesNuevos([pedido], false);
    ctx.PEND_CACHE = [pedido];
    expect(ctx.cardPendiente(pedido, 0)).not.toContain('NUEVO');

    ctx.PEND_CACHE = [];
    ctx.registrarPendientesNuevos([pedido], true);
    const html = ctx.cardPendiente(pedido, 0);
    expect(html).toContain('class="ped nuevo"');
    expect(html).toContain('NUEVO · hace menos de 1 min');
    expect(html).toContain('aria-label="Pedido nuevo, ingresado menos de 1 min"');
  });

  it('conserva el estado nuevo por clave y elimina pedidos que ya no están en la cola', () => {
    const pedido = { canal: 'ml', ml_order_id: 'ML-1', numero_pedido: 'ML-1', items: [] };
    ctx.registrarPendientesNuevos([], false);
    ctx.PEND_CACHE = [];
    ctx.registrarPendientesNuevos([pedido], true);
    expect(ctx.PEND_NUEVOS['ml:ML-1']).toBeTypeOf('number');
    ctx.PEND_CACHE = [pedido];
    ctx.registrarPendientesNuevos([], true);
    expect(ctx.PEND_NUEVOS['ml:ML-1']).toBeUndefined();
  });
  it('mantiene error visible y ofrece reintento en vez de presentar cola vacía', () => {
    ctx.PEND_STATUS = 'error';
    ctx.PEND_CACHE = [];
    ctx.renderPendientes();
    const html = ctx.document.getElementById('cuerpo').innerHTML;
    expect(html).toContain('No se pudo cargar la cola');
    expect(html).toContain('cargarPendientes()');
  });
  it('abre por clave estable y conserva controles de accesibilidad de la jornada', () => {
    const pedido = { canal: 'ml', ml_order_id: 'ML-9', numero_pedido: 'ML-9', items: [] };
    expect(ctx.cardPendiente(pedido)).toContain("prepararClave('ml:ML-9')");
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('min-height:44px');
  });
  it('descarta claims locales expirados y permite tomar olas en búsqueda', () => {
    ctx.JORNADA = { estado: 'abierta', jornada: { id: 1 }, olas: [{ id: 7, tipo: 'inicial', estado: 'en_picking', items: [] }], error: null, busy: false, claims: { 7: { usuario: 'tester', expires_at: '2020-01-01T00:00:00Z' } } };
    const html = ctx.jornadaCard(ctx.JORNADA.olas[0]);
    expect(ctx.JORNADA.claims[7]).toBeUndefined();
    expect(html).toContain('>Tomar ola</button>');
  });
  it('muestra el aviso operativo del claim próximo a vencer con texto accesible', () => {
    ctx.JORNADA = { estado: 'ready', jornada: { id: 1 }, olas: [{ id: 8, tipo: 'inicial', estado: 'en_picking', items: [], claim: { usuario: 'tester', por_vencer: true, segundos_restantes: 540 } }], error: null, busy: false, claims: {} };
    const html = ctx.jornadaCard(ctx.JORNADA.olas[0]);
    expect(html).toContain('role="alert"');
    expect(html).toContain('vence en 9 min');
    expect(html).toContain('Terminá o liberá la ola.');
  });
  it('mantiene controles visibles de pausa y reanudación de la ola', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(source).toContain("onclick=\"pausarOla(");
    expect(source).toContain("onclick=\"reanudarOla(");
    expect(source).toContain("'/pausar'");
    expect(source).toContain("'/reanudar'");
  });
  it('restaura foco visible para controles de jornada', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(html).toContain('.jornada-form input:focus-visible');
    expect(html).toContain('.jornada-panel button:focus-visible');
  });
  it('anuncia cambios en la región live persistente', () => {
    ctx.anunciarJornada('Ola reclamada.');
    expect(ctx.document.getElementById('foto-live').textContent).toBe('Ola reclamada.');
  });
  it('muestra ambos límites para ML/Andreani sin inventar horarios', () => {
    const pedido = { canal: 'ml', logistic_type: 'cross_docking', shipment_limite_original: '2026-09-02T15:30:00-03:00', fecha_despacho_limite: '2026-09-02T15:00:00-03:00', estado_despacho: 'activo', items: [] };
    const html = ctx.cardPendiente(pedido);
    expect(html).toContain('Entrega en acopio:');
    expect(html).toContain('Límite interno:');
    expect(html).not.toContain('17:00');
    expect(ctx.cardPendiente({ canal: 'ml', logistic_type: 'cross_docking', estado_despacho: 'activo', items: [] })).not.toContain('Límite interno:');
    expect(html).toContain('02/09/2026, 15:30');
  });
  it('muestra las reglas operativas de Flex y Web y el diferimiento', () => {
    expect(ctx.cardPendiente({ canal: 'ml', logistic_type: 'self_service', estado_despacho: 'activo', items: [] })).toContain('Salida máxima Flex: 17:00');
    expect(ctx.cardPendiente({ canal: 'web', estado_despacho: 'activo', items: [] })).toContain('Preparar antes de las 15:00');
    const diferido = ctx.cardPendiente({ canal: 'ml', estado_despacho: 'diferido', despacho_motivo: 'SLA_SHIPMENT_HORA_FALTANTE', items: [] });
    expect(diferido).toContain('Despacho diferido');
    expect(diferido).toContain('MercadoLibre no informó una hora límite');
    expect(diferido).toContain('Ver código para diagnóstico');
    expect(diferido).toContain('SLA_SHIPMENT_HORA_FALTANTE');
    expect(diferido).toContain('Queda para el siguiente día');
    expect(ctx.cardPendiente({ canal: 'ml', estado_despacho: 'diferido', despacho_motivo: 'MARGEN_30_MIN_SUPERADO', items: [] })).toContain('margen operativo de 30 minutos');
    expect(ctx.cardPendiente({ canal: 'ml', logistic_type: 'self_service', estado_despacho: 'diferido', despacho_motivo: 'FLEX_SALIDA_17:00_SUPERADA', items: [] })).toContain('salida máxima de Flex');
  });
  it('muestra reglas canónicas y preflight antes y después de abrir', () => {
    ctx.JORNADA = { estado: 'ready', jornada: null, olas: [], error: null, busy: false, claims: {} };
    let html = ctx.renderJornada();
    expect(html).toContain('Web: preparar antes de <b>15:00</b>');
    expect(html).toContain('ML/Andreani: entregar según el límite de cada paquete, con <b>30 min</b>');
    expect(html).toContain('Flex: salida máxima <b>17:00</b>');
    expect(html).toContain('ML Full: <b>fuera del flujo</b>');
    expect(html).toContain('desconocido · no_verificado');
    expect(html).not.toContain('jornada-hora');
    expect(html).not.toContain('jornada-ventana');

    ctx.JORNADA.jornada = { id: 1, estado: 'abierta', fecha: '2026-09-02' };
    ctx.JORNADA.reglas = { zona_horaria: 'America/Argentina/Buenos_Aires', web: { hora: '15:00' }, ml_andreani: { margen_minutos: 30 }, flex: { hora: '17:00' }, full: { estado: 'excluido' } };
    ctx.JORNADA.preflight = { estado: 'abierta_con_advertencias', integraciones: { mercadolibre: { estado: 'desconocido', verificacion: 'no_verificado' }, woocommerce: { estado: 'verificado', verificacion: 'verificado' } }, agente_impresora: { estado: 'desconocido', verificacion: 'no_verificado' }, operaciones_no_afectadas: 'continuan' };
    html = ctx.renderJornada();
    expect(html).toContain('WooCommerce: <b>verificado · verificado</b>');
    expect(html).toContain('Agente/impresora: <b>desconocido · no_verificado</b>');
  });
  it('envía body vacío y deja error accionable si se mandan overrides', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(source).toContain("body:'{}'");
    expect(source).toContain("r.status===400&&d.code==='OPENING_RULES_SERVER_CONTROLLED'");
    expect(source).toContain('Las reglas de apertura son canónicas y se calculan en el servidor');
  });
  it('actualiza el polling sin repintar la cola ni interrumpir la apertura', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    const silencioso = html.match(/async function cargarPendientesSilencioso\(\)\{([\s\S]*?)\n\}/)?.[1] || '';
    expect(silencioso).not.toContain('renderPendientes()');
    expect(html).toContain('if(!jornadaEdicionActiva())renderPendientesSinInterrumpir();');
    expect(html).toContain('async function cargarDatosSilenciosos()');
    expect(html).toContain('Promise.all([api(\'/pendientes\'),fetch(\'/api/jornada/hoy\')])');
    expect(html).toContain('document.getElementById(foco.id)');
    expect(html).toContain('setSelectionRange(seleccion.inicio,seleccion.fin)');
    expect(html).toContain('--focus-ring:#67e8f9');
    expect(html).not.toContain('data-poll-focus');
  });
  it('renderiza la ola con estados objetivo y acciones de búsqueda, mesa y ayuda', () => {
    ctx.USERNAME = 'tester';
    ctx.JORNADA.zonas = [{ id: 2, nombre: 'Estante B', verificada: 0 }];
    const html = ctx.renderDetalleOla({ id: 4, tipo: 'inicial', estado_operativo: 'en_busqueda', expected_version: 3,
      claim: { usuario: 'tester' }, items: [{ pedido_clave: 'ml:22', sku: 'ABC', cantidad: 1 }] });
    expect(html).toContain('Recorriendo zonas');
    expect(html).toContain('Pasar a mesa');
    expect(html).toContain('Pedir ayuda por zona');
    expect(html).toContain('Mesa de asignación');
    expect(html).toContain('Estante B · ubicación sugerida');
  });
  it('mantiene la separación E1/E2 y muestra faltantes sin ocultarlos', () => {
    ctx.USERNAME = 'tester';
    const html = ctx.renderDetalleOla({ id: 5, tipo: 'mini', estado_operativo: 'en_mesa', expected_version: 1,
      claim: { usuario: 'tester' }, items: [{ pedido_clave: 'web:91', sku: 'XYZ', cantidad: 2 }] });
    expect(html).toContain('Escanear unidad en mesa');
    expect(html).toContain('Registrar faltante');
    expect(html).toContain('La búsqueda no escanea unidades');
    expect(html).not.toContain('Aprobar preparación');
  });
  it('usa requests E1 con idempotencia, versión esperada y feedback accesible', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(source).toContain("body.expected_version=ola.expected_version||1");
    expect(source).toContain("body.operation_id=E1_OPERATION_IDS[opKey]||(E1_OPERATION_IDS[opKey]=operationId())");
    expect(source).toContain("'/api/jornada/zonas'");
    expect(source).toContain('role="status" aria-live="polite"');
  });
  it('ofrece escaneo de unidad en mesa sin pedir el SKU en el flujo normal', () => {
    ctx.USERNAME = 'tester';
    ctx.JORNADA = { estado: 'ready', jornada: { id: 1 }, zonas: [], olas: [], claims: {}, busy: false };
    const html = ctx.renderDetalleOla({ id: 12, tipo: 'inicial', estado_operativo: 'en_mesa', expected_version: 4,
      claim: { usuario: 'tester' }, items: [{ pedido_clave: 'ml:200', sku: 'ABC-1', cantidad: 1 }] });
    expect(html).toContain('Escanear unidad en mesa');
    expect(html).toContain('Todavía no hay una unidad leída');
    expect(html).not.toContain('onclick="asignarMesa(');
    expect(html).toContain('buscarUnidadMesaManual');
    const source = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(source).toContain('window.Scanner.open');
    expect(source).toContain('onCode:function(v){mesaLectura(id,v);}');
    expect(source).toContain('Pedido prioritario sugerido');
  });
  it('mantiene feedback accesible y fallback manual con motivo', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../public/preparacion/index.html'), 'utf8');
    expect(source).toContain('role="status" aria-live="polite"');
    expect(source).toContain('role="alert"');
    expect(source).toContain('La búsqueda manual requiere un motivo.');
    expect(source).toContain('E1_OPERATION_IDS[opKey]||(E1_OPERATION_IDS[opKey]=operationId())');
    expect(source).toContain('Código leído. Confirmá el pedido sugerido en la mesa.');
  });
});
