import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const vista = fs.readFileSync('./public/sync-ml/pausadas/index.html', 'utf8');
const sync = fs.readFileSync('./public/sync-ml/index.html', 'utf8');

describe('Pausadas con stock: vista propia (/sync-ml/pausadas)', () => {
  it('usa los tokens del sistema y no define colores propios', () => {
    expect(vista).toContain('../../lib/theme.css');
    expect(vista).toContain('../../lib/components.css');
    const css = vista.split('<style>')[1].split('</style>')[0];
    // sólo rgba de sombra, la máscara de chips (#000) y nada de hex de paleta
    expect(css.replace(/mask-image:[^;]+;/g, '').match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
  });
  it('lee y reactiva con los endpoints del contrato, un POST por lote de hasta 50', () => {
    expect(vista).toContain("fetch('/api/sync/pausadas-con-stock')");
    expect(vista).toContain("'/api/sync/pausadas-con-stock/reactivar'");
    expect(vista).toContain('MAX_LOTE=50');
    expect(vista).toContain('CONFIRMAR_DESDE=10');
    expect(vista).toContain('slice(0,MAX_LOTE)');
  });
  it('no usa modales nativos ni toasts', () => {
    expect(vista).not.toMatch(/\b(confirm|alert|prompt)\s*\(/);
    expect(vista).not.toMatch(/toast/i);
  });
  it('las bloqueadas no tienen checkbox y llevan un link a dónde resolverlas', () => {
    expect(vista).toMatch(/function row\(i\)\{[\s\S]*?if\(locked\(i\)\)\{[\s\S]*?row--locked[\s\S]*?\}/);
    expect(vista).toContain("go:'Ver aviso'");
    expect(vista).toContain("go:'Ir a Configuración ML'");
    expect(vista).toContain("go:'Ir a Catálogo'");
  });
  it('escapa los textos que vienen de ML', () => {
    expect(vista).toContain('function esc(');
    expect(vista).toMatch(/esc\(i\.titulo\|\|i\.item_id\)/);
  });
  it('tiene los atajos pedidos, estados y hoja móvil', () => {
    for (const k of ["'j'", "'k'", "'x'", "'Enter'", "'r'", "'R'", "'/'", "'?'", "'Escape'"]) expect(vista).toContain(k);
    expect(vista).toContain('Todo al día');
    expect(vista).toContain('class="sk"');
    expect(vista).toContain('Mostrando datos de');
    expect(vista).toContain("setAttribute('role','dialog')");
    expect(vista).not.toMatch(/Deshacer/);
  });
});

describe('Sincronización ML rediseñada', () => {
  it('una sola lista "Para resolver" ordenada por gravedad, con Pausadas y detalle como filas', () => {
    expect(sync).toContain('Para resolver');
    expect(sync).toContain("var SEV={crit:0,warn:1,info:2}");
    expect(sync).toContain('/herramientas/sync-ml/pausadas/');
    expect(sync).toContain('/herramientas/sync-detalle/?cat=errores');
    expect(sync).toContain('/herramientas/sync-detalle/?cat=sin_mapeo');
    expect(sync).toContain('/herramientas/sync-detalle/?cat=remapeo_requerido');
    expect(sync).toContain('/herramientas/sync-detalle/?cat=requiere_atencion_ml');
    expect(sync).toContain('Nada para resolver');
  });
  it('estado arriba y flujos reemplazan las píldoras', () => {
    expect(sync).toContain('La conexión con ML venció');
    expect(sync).toContain('Renovar conexión →');
    expect(sync).toContain("fetch('/api/sync/ml-auth-url')");
    expect(sync).toContain('location.href=d.url');
    expect(sync).toContain('data-renovar');
    expect(sync).not.toContain('config-ml');
    expect(sync).toContain('No se pudo iniciar la renovación');
    expect(sync).toContain('Todo sincronizando');
    expect(sync).toContain('Ventas ML → web');
    expect(sync).toContain('Stock web → ML');
    expect(sync).not.toContain('class="pills"');
  });
  it('sin la sección vieja de reactivar y sin confirm/alert/prompt ni handlers inline', () => {
    expect(sync).not.toContain('reactivar-box');
    expect(sync).not.toContain('/api/sync/reactivables');
    expect(sync).not.toMatch(/\b(confirm|alert|prompt)\(/);
    expect(sync).not.toMatch(/\sonclick=|\sonerror=|\sstyle="/);
  });
  it('Correr ahora conserva las 4 acciones manuales y el resultado va a la franja inferior', () => {
    for (const u of ['/api/sync/ml-wc', '/api/sync/wc-ml', '/api/sync/ml-cancelaciones', '/api/sync/limpiar-variaciones-muertas']) expect(sync).toContain(u);
    expect(sync).toContain('Correr ahora');
    expect(sync).toContain('id="bandx"');
  });
  it('frenadas: plan con checkboxes y mismo endpoint de aplicar; cambios de producto con Es lo mismo / Dejar pausada', () => {
    expect(sync).toContain('/api/precios/objetivo');
    expect(sync).toContain('/api/precios/actualizar-precio');
    expect(sync).toContain('/api/sync/reactivar');
    expect(sync).toContain('/api/sync/frenadas/forzar');
    expect(sync).toContain('Ver precios nuevos');
    expect(sync).toContain('Es lo mismo');
    expect(sync).toContain('Dejar pausada');
    expect(sync).toContain('Comparar productos');
  });
  it('trata los avisos sin pausa como no-error y ofrece reactivar en línea (Reactivar ahora / Ver en Pausadas)', () => {
    expect(sync).toContain('c.nota||c.pausa_error');
    expect(sync).toContain('d.oferta_reactivar');
    expect(sync).toContain('Reactivar ahora');
    expect(sync).toContain('Ver en Pausadas');
    expect(sync).toContain('data-cf-reactivar');
  });
  it('ventas: 2 KPIs y los últimos 5 pedidos en un details plegado', () => {
    expect(sync).toContain('<details class="orders"');
    expect(sync).toContain('slice(0,5)');
  });
  it('mantiene los enlaces antiguos #reactivar, #frenadas y #cambios-formato', () => {
    expect(sync).toContain("'#reactivar'");
    expect(sync).toContain("'#frenadas'");
    expect(sync).toContain("'#cambios-formato'");
  });

  it('defensa en profundidad: el cliente sólo acepta http(s) en permalink/thumbnail, y 403 muestra texto llano sin Reintentar', () => {
    expect(vista).toContain('urlSegura(i.permalink)');
    expect(vista).toContain("urlSegura(i.thumbnail,true)");
    expect(vista).toContain('No tenés permiso para ver esto.');
    expect(sync).toContain('No tenés permiso para ver esto.');
    expect(sync).toContain('.flows span{white-space:normal}');
    expect(sync).toContain('if(!cargaOk.fren)hay.fren=1');
  });

  it('el aviso por pendiente_stock dice la causa real (Woo, otro aviso, solo_local, sin vínculo, ML)', () => {
    expect(sync).toContain('No hay stock en la web (Woo)');
    expect(sync).toContain('d.motivo_pendiente');
    expect(sync).toContain('hasta que se pueda reactivar');
  });
  it('muestra en "Para resolver" las correcciones de identidad encoladas sin ejecutar', () => {
    expect(sync).toContain('D.identidad_encoladas');
    expect(sync).toContain("k:'idq'");
    expect(sync).toContain('más de 2 horas esperando');
    expect(sync).toContain('fuera del canario');
  });
  it('el ítem cuenta también las trabadas en proceso y distingue ambos conteos', () => {
    expect(sync).toContain('iq.procesando_vencidas');
    expect(sync).toContain('nIdq=nEnc+nTrab');
    expect(sync).toContain('encoladas sin ejecutar');
    expect(sync).toContain('trabadas en proceso');
  });
  it('el chip del home usa n + procesando_vencidas y apunta al mismo destino que el ítem', () => {
    const home = fs.readFileSync('./public/home/index.html', 'utf8');
    expect(home).toContain('idq.procesando_vencidas');
    expect(home).toContain('peChip(idEnc + idTrab, idEtiqueta');
    expect(home).toContain("'/herramientas/identidad-productos/', 'matcher'");
    expect(home).not.toContain("encoladas sin ejecutar (más de 2 h)', 'warn', '/herramientas/sync-ml/'");
    expect(sync).toContain("href:'/herramientas/identidad-productos/'");
  });
});
