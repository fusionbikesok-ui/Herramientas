import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importarGestionPedidos, importarVentanaGestionPedidos } from '../lib/gestionPedidos.js';

const root = path.dirname(fileURLToPath(import.meta.url));

function dbPrueba() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '095_gestion_pedidos_relacional.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '099_gestion_pedidos_estado_canal.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '100_gestion_pedidos_shipment_ml.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(root, '..', 'migrations', '101_gestion_pedidos_datos_ml.sql'), 'utf8'));
  db.exec(`CREATE TABLE IF NOT EXISTS ml_shipment_estado (
    shipment_id TEXT PRIMARY KEY, status TEXT, logistic_type TEXT, actualizado_en TEXT)`);
  return db;
}

describe('Gestión de pedidos relacional', () => {
  it('importa Woo y ML, conserva cancelados y es idempotente', () => {
    const db = dbPrueba();
    const ordenes = [
      { canal: 'web', wc_order_id: 1001, numero: '1001', fecha: '2026-09-01T10:00:00Z', estado: 'processing', comprador: { nombre: 'Ana', apellido: 'Demo', email: 'ana@example.com' }, items: [{ product_id: 7, sku: 'FB-7', ean: '7791', nombre: 'Casco', cantidad: 1 }] },
      { canal: 'ml', ml_order_id: 'ML-1', numero: 'ML-1', fecha: '2026-09-02T10:00:00Z', estado: 'cancelled', comprador: { nickname: 'comprador-ml' }, items: [{ seller_sku: 'FB-8', nombre: 'Luces', cantidad: 2 }] },
    ];
    expect(importarGestionPedidos(db, ordenes).map(x => x.created)).toEqual([true, true]);
    expect(importarGestionPedidos(db, ordenes).map(x => x.created)).toEqual([false, false]);
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedidos').get().n).toBe(2);
    expect(db.prepare("SELECT estado_comercial FROM gestion_pedidos WHERE fuente='mercadolibre'").get().estado_comercial).toBe('cancelado');
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedido_items').get().n).toBe(2);
    db.close();
  });

  it('pagina ambos adaptadores y vuelve a importar sin duplicar', async () => {
    const db = dbPrueba();
    const wooPages = [[{ id: 10, number: '10', date_created: '2026-09-01T00:00:00Z', status: 'processing', billing: { first_name: 'W', email: 'w@example.com' }, line_items: [] }], []];
    const mlPages = [[{ id: 'ML-10', date_created: '2026-09-01T00:00:00Z', status: 'paid', buyer: { nickname: 'ml-demo' }, order_items: [] }], []];
    let wooCalls = 0; let mlCalls = 0;
    const options = {
      desde: '2026-09-01T00:00:00Z',
      porPagina: 1,
      listarWoo: async ({ pagina }) => wooPages[pagina - 1] || [],
      listarMl: async ({ offset }) => mlPages[offset / 100] || [],
    };
    const first = await importarVentanaGestionPedidos(db, options);
    expect(first).toHaveLength(2);
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedidos').get().n).toBe(2);
    options.listarWoo = async ({ pagina }) => { wooCalls += 1; return wooPages[pagina - 1] || []; };
    options.listarMl = async ({ offset }) => { mlCalls += 1; return mlPages[offset / 100] || []; };
    await importarVentanaGestionPedidos(db, options);
    expect(wooCalls).toBe(2);
    expect(mlCalls).toBe(2);
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedidos').get().n).toBe(2);
    db.close();
  });

  it('persiste únicamente las cuotas explícitas de Woo y MercadoLibre', async () => {
    const db = dbPrueba();
    await importarVentanaGestionPedidos(db, {
      desde: '2026-09-01T00:00:00Z', porPagina: 10,
      listarWoo: async () => [{ id: 21, number: '21', date_created: '2026-09-01T00:00:00Z', status: 'processing', payment_method: 'tarjeta', meta_data: [{ key: 'installments', value: '6' }], billing: {}, line_items: [] }],
      listarMl: async () => [{ id: 'ML-21', date_created: '2026-09-01T00:00:00Z', status: 'paid', buyer: {}, payments: [{ payment_type: 'credit_card', installments: 3, status: 'approved' }], order_items: [] }],
    });
    const filas = db.prepare('SELECT fuente, pago_metodo, pago_estado, cuotas FROM gestion_pedidos ORDER BY fuente').all();
    expect(filas).toEqual([
      { fuente: 'mercadolibre', pago_metodo: 'credit_card', pago_estado: 'approved', cuotas: 3 },
      { fuente: 'woocommerce', pago_metodo: 'tarjeta', pago_estado: null, cuotas: 6 },
    ]);
    db.close();
  });

  it('persiste importes y entrega de Woo, y distingue el retiro en local', async () => {
    const db = dbPrueba();
    await importarVentanaGestionPedidos(db, {
      desde: '2026-09-01T00:00:00Z', porPagina: 10,
      listarWoo: async () => [
        { id: 31, number: '31', date_created: '2026-09-01T00:00:00Z', status: 'processing',
          currency: 'ARS', total: '150000.00', shipping_total: '5000.00', total_tax: '0',
          billing: { first_name: 'Ana', email: 'ana@x.com' },
          shipping: { first_name: 'Ana', last_name: 'Test', address_1: 'Siempreviva 742', city: 'CABA', state: 'C', postcode: '1425' },
          shipping_lines: [{ method_id: 'flat_rate', method_title: 'Andreani' }],
          line_items: [{ id: 1, product_id: 5, sku: 'FB-1', name: 'Casco', quantity: 2, price: '72500.00' }],
          meta_data: [] },
        { id: 32, number: '32', date_created: '2026-09-01T01:00:00Z', status: 'processing',
          currency: 'ARS', total: '80000.00', shipping_total: '0', total_tax: '0',
          billing: { first_name: 'Luis', email: 'luis@x.com' }, shipping: {},
          shipping_lines: [{ method_id: 'local_pickup', method_title: 'Retiro en local' }],
          line_items: [{ id: 2, product_id: 6, sku: 'FB-2', name: 'Luces', quantity: 1, price: '80000.00' }],
          meta_data: [] },
      ],
      listarMl: async () => [],
    });
    const conDomicilio = db.prepare(`SELECT p.subtotal_centavos, p.envio_centavos, p.total_centavos, p.moneda,
      e.tipo, e.transportista, e.direccion, e.ciudad, e.codigo_postal
      FROM gestion_pedidos p JOIN gestion_pedido_entregas e ON e.pedido_id=p.id WHERE p.external_id='31'`).get();
    expect(conDomicilio).toEqual({
      subtotal_centavos: 14500000, envio_centavos: 500000, total_centavos: 15000000, moneda: 'ARS',
      tipo: 'domicilio', transportista: 'Andreani', direccion: 'Siempreviva 742', ciudad: 'CABA', codigo_postal: '1425',
    });
    // El precio de la línea llega en centavos: sin esto la ficha del pedido no muestra importes.
    expect(db.prepare("SELECT precio_unitario_centavos FROM gestion_pedido_items WHERE sku='FB-1'").get())
      .toEqual({ precio_unitario_centavos: 7250000 });
    // Una venta con retiro en local no puede confundirse con un envío a domicilio: es la
    // que sigue en "Requieren atención" hasta que alguien la registre como retirada.
    expect(db.prepare(`SELECT e.tipo FROM gestion_pedido_entregas e
      JOIN gestion_pedidos p ON p.id=e.pedido_id WHERE p.external_id='32'`).get()).toEqual({ tipo: 'retiro_local' });
    db.close();
  });

  it('reimportar no borra el tracking ya cargado por el embalado', async () => {
    const db = dbPrueba();
    const pedido = () => [{ id: 41, number: '41', date_created: '2026-09-01T00:00:00Z', status: 'processing',
      currency: 'ARS', total: '1000.00', shipping_total: '0', total_tax: '0',
      billing: { email: 'a@x.com' }, shipping: { address_1: 'Calle 1' },
      shipping_lines: [{ method_id: 'flat_rate' }], line_items: [], meta_data: [] }];
    const opciones = { desde: '2026-09-01T00:00:00Z', porPagina: 10, listarWoo: async () => pedido(), listarMl: async () => [] };
    await importarVentanaGestionPedidos(db, opciones);
    db.prepare(`UPDATE gestion_pedido_entregas SET tracking='AND-123'`).run();
    await importarVentanaGestionPedidos(db, opciones);
    expect(db.prepare('SELECT tracking FROM gestion_pedido_entregas').get()).toEqual({ tracking: 'AND-123' });
    db.close();
  });

  it('respeta la semántica de importes de ML y no inventa la entrega', async () => {
    const db = dbPrueba();
    await importarVentanaGestionPedidos(db, {
      desde: '2026-09-01T00:00:00Z', porPagina: 10,
      listarWoo: async () => [],
      // En ML `total_amount` es la suma de los ítems y `paid_amount` es lo pagado con
      // envío incluido. Tomarlos literalmente dejaba subtotal > total.
      listarMl: async () => [{
        id: 'ML-99', date_created: '2026-09-01T00:00:00Z', status: 'paid',
        currency_id: 'ARS', total_amount: 96000, paid_amount: 99000, shipping: { cost: 3000 },
        buyer: {}, payments: [], order_items: [],
      }, {
        // Cancelada y reembolsada: ML deja `paid_amount` en 0. El pedido igual valió lo que
        // valió — mostrar "Total $0" borraba una venta de $34.000 que existió y se devolvió.
        id: 'ML-REF', date_created: '2026-09-01T01:00:00Z', status: 'cancelled',
        currency_id: 'ARS', total_amount: 34000, paid_amount: 0,
        buyer: {}, payments: [], order_items: [],
      }],
    });
    const p = db.prepare("SELECT subtotal_centavos, envio_centavos, total_centavos FROM gestion_pedidos WHERE external_id='ML-99'").get();
    expect(p).toEqual({ subtotal_centavos: 9600000, envio_centavos: 300000, total_centavos: 9900000 });
    expect(p.subtotal_centavos + p.envio_centavos).toBe(p.total_centavos);
    // La dirección de una venta ML vive en su shipment: hasta importarlo no se afirma un
    // tipo de entrega, porque un Flex o un retiro en sucursal quedarían mal clasificados.
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedido_entregas').get().n).toBe(0);
    const reembolsada = db.prepare("SELECT subtotal_centavos, total_centavos FROM gestion_pedidos WHERE external_id='ML-REF'").get();
    expect(reembolsada).toEqual({ subtotal_centavos: 3400000, total_centavos: 3400000 });
    // Ningún pedido puede tener subtotal mayor que su total.
    expect(db.prepare('SELECT count(*) AS n FROM gestion_pedidos WHERE subtotal_centavos > total_centavos').get().n).toBe(0);
    db.close();
  });

  it('guarda el estado crudo del canal y marca el pedido espejo de ML', async () => {
    const db = dbPrueba();
    await importarVentanaGestionPedidos(db, {
      desde: '2026-09-01T00:00:00Z', porPagina: 10,
      listarWoo: async () => [
        // Espejo: lo delata la meta _ml_order_id, y su status Woo propio es 'mercadolibre'.
        { id: 68972, number: '68972', date_created: '2026-09-01T13:53:00', status: 'mercadolibre',
          billing: { email: 'ez@x.com' }, shipping: {}, shipping_lines: [], line_items: [],
          meta_data: [{ key: '_ml_order_id', value: '2000018369254322' }] },
        // Pedido web genuino, con el estado que habilita la cola de envíos.
        { id: 68970, number: '68970', date_created: '2026-09-01T09:00:00', status: 'lpaandreani',
          billing: { email: 'web@x.com' }, shipping: {}, shipping_lines: [], line_items: [], meta_data: [] },
      ],
      listarMl: async () => [{ id: '2000018369254322', date_created: '2026-09-01T12:50:00Z',
        status: 'paid', buyer: {}, payments: [], order_items: [] }],
    });
    const filas = db.prepare('SELECT external_id, estado_canal, espejo_ml, ml_order_id FROM gestion_pedidos ORDER BY external_id').all();
    expect(filas).toEqual([
      { external_id: '2000018369254322', estado_canal: 'paid', espejo_ml: 0, ml_order_id: null },
      { external_id: '68970', estado_canal: 'lpaandreani', espejo_ml: 0, ml_order_id: null },
      { external_id: '68972', estado_canal: 'mercadolibre', espejo_ml: 1, ml_order_id: '2000018369254322' },
    ]);
    db.close();
  });

  it('cierra los pedidos que el canal informa terminados, pero no los ML sólo pagados', async () => {
    const db = dbPrueba();
    const woo = (id, status) => ({ id, number: String(id), date_created: '2026-09-01T00:00:00Z', status,
      billing: { email: id + '@x.com' }, shipping: {}, shipping_lines: [], line_items: [], meta_data: [] });
    await importarVentanaGestionPedidos(db, {
      desde: '2026-09-01T00:00:00Z', porPagina: 10,
      listarWoo: async () => [woo(1, 'enviadoandreani'), woo(2, 'retiradoenfusion'), woo(3, 'completed'),
        woo(4, 'serviceterminado'), woo(5, 'processing'), woo(6, 'lpaandreani')],
      // 'paid' sólo dice que ML cobró, no que salió: saberlo exige el shipment, que no se
      // importa todavía. Cerrarlo escondería una venta sin despachar.
      listarMl: async () => [{ id: 'ML-1', date_created: '2026-09-01T00:00:00Z', status: 'paid', buyer: {}, payments: [], order_items: [] }],
    });
    const porEstado = db.prepare('SELECT estado_operativo, group_concat(external_id) ids FROM gestion_pedidos GROUP BY 1 ORDER BY 1').all();
    expect(porEstado).toEqual([
      { estado_operativo: 'cerrado', ids: '1,2,3,4' },
      { estado_operativo: 'importado', ids: '5,6,ML-1' },
    ]);
    db.close();
  });

  it('una reimportación no pisa el estado operativo que fijó la operación', async () => {
    const db = dbPrueba();
    const pedido = () => [{ id: 77, number: '77', date_created: '2026-09-01T00:00:00Z', status: 'processing',
      billing: { email: 'a@x.com' }, shipping: {}, shipping_lines: [], line_items: [], meta_data: [] }];
    const opciones = { desde: '2026-09-01T00:00:00Z', porPagina: 10, listarWoo: async () => pedido(), listarMl: async () => [] };
    await importarVentanaGestionPedidos(db, opciones);
    // La operación lo manda a preparar…
    db.prepare("UPDATE gestion_pedidos SET estado_operativo='en_preparacion'").run();
    // …y el cron vuelve a correr diez minutos después.
    await importarVentanaGestionPedidos(db, opciones);
    expect(db.prepare('SELECT estado_operativo FROM gestion_pedidos').get()).toEqual({ estado_operativo: 'en_preparacion' });
    db.close();
  });

  it('un cierre informado por el canal sí gana sobre el estado local', async () => {
    // Una venta cancelada o ya entregada no puede seguir figurando en preparación.
    const db = dbPrueba();
    const conEstado = (status) => [{ id: 78, number: '78', date_created: '2026-09-01T00:00:00Z', status,
      billing: { email: 'b@x.com' }, shipping: {}, shipping_lines: [], line_items: [], meta_data: [] }];
    await importarVentanaGestionPedidos(db, { desde: '2026-09-01T00:00:00Z', porPagina: 10, listarWoo: async () => conEstado('processing'), listarMl: async () => [] });
    db.prepare("UPDATE gestion_pedidos SET estado_operativo='en_preparacion'").run();
    await importarVentanaGestionPedidos(db, { desde: '2026-09-01T00:00:00Z', porPagina: 10, listarWoo: async () => conEstado('cancelled'), listarMl: async () => [] });
    expect(db.prepare('SELECT estado_operativo FROM gestion_pedidos').get()).toEqual({ estado_operativo: 'cerrado' });
    db.close();
  });

  it('cierra una venta de ML por el estado del envío, no por el de la orden', async () => {
    const db = dbPrueba();
    // El status de la orden se queda en 'paid' aunque el paquete ya haya salido: es el caso
    // que dejaba ventas despachadas dentro de "Requieren atención".
    const alta = (sid, status) => db.prepare('INSERT INTO ml_shipment_estado (shipment_id,status,actualizado_en) VALUES (?,?,?)').run(sid, status, '2026-09-09T00:00:00Z');
    alta('900001', 'delivered'); alta('900002', 'shipped'); alta('900003', 'ready_to_ship');
    const orden = (id, shipmentId) => ({ id, date_created: '2026-09-01T00:00:00Z', status: 'paid',
      shipping: shipmentId ? { id: shipmentId } : undefined, buyer: {}, payments: [], order_items: [] });
    await importarVentanaGestionPedidos(db, {
      desde: '2026-09-01T00:00:00Z', porPagina: 10, listarWoo: async () => [],
      listarMl: async () => [orden('ML-A', 900001), orden('ML-B', 900002), orden('ML-C', 900003), orden('ML-D', null)],
    });
    const filas = db.prepare('SELECT external_id, estado_operativo, ml_shipment_id FROM gestion_pedidos ORDER BY external_id').all();
    expect(filas).toEqual([
      { external_id: 'ML-A', estado_operativo: 'cerrado', ml_shipment_id: '900001' },
      { external_id: 'ML-B', estado_operativo: 'cerrado', ml_shipment_id: '900002' },
      // Listo para enviar todavía no salió: tiene que seguir a la vista.
      { external_id: 'ML-C', estado_operativo: 'importado', ml_shipment_id: '900003' },
      // Sin envío conocido no se cierra: no saber si salió nunca puede esconder una venta.
      { external_id: 'ML-D', estado_operativo: 'importado', ml_shipment_id: null },
    ]);
    db.close();
  });

  it('sin la tabla de envíos de ML la importación sigue funcionando', async () => {
    const db = dbPrueba();
    db.exec('DROP TABLE ml_shipment_estado');
    await importarVentanaGestionPedidos(db, {
      desde: '2026-09-01T00:00:00Z', porPagina: 10, listarWoo: async () => [],
      listarMl: async () => [{ id: 'ML-X', date_created: '2026-09-01T00:00:00Z', status: 'paid',
        shipping: { id: 123 }, buyer: {}, payments: [], order_items: [] }],
    });
    expect(db.prepare('SELECT estado_operativo FROM gestion_pedidos').get()).toEqual({ estado_operativo: 'importado' });
    db.close();
  });
});
