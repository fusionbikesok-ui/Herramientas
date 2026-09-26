#!/usr/bin/env node
import pg from 'pg';
import { cargarKeyring } from '../src/seguridad/keyring.ts';
import { cargarRegistro } from '../src/reconciliacion/registro.ts';
import { crearClienteCanal } from '../src/reconciliacion/cliente-http.ts';
import { crearTransporteGateway } from '../src/reconciliacion/transporte-gateway.ts';
import { crearRelectoresMl } from '../src/reconciliacion/relectura.ts';
import { congelarCanario, correrCanario, cerrarCanario } from '../src/identidad/canario.ts';

const [comando, ...args] = process.argv.slice(2);
const apply = args.includes('--apply');
const valor = (nombre: string): string => { const i = args.indexOf(nombre); return i >= 0 && args[i + 1] ? args[i + 1]! : ''; };
if (!process.env.DATABASE_URL || !process.env.CATALOGO_KEYRING_FILE) throw new Error('faltan DATABASE_URL y/o CATALOGO_KEYRING_FILE');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  if (!apply && comando !== 'estado') { console.log('DRY-RUN: se requiere --apply para escribir'); process.exitCode = 2; }
  else if (comando === 'congelar') {
    const r = await congelarCanario(pool, { empresa: valor('--empresa'), dia: valor('--dia') }); console.log(JSON.stringify({ corridaId: r.corridaId, casos: r.casos, excluidosD5: r.excluidosD5 }));
  } else if (comando === 'correr') {
    const registro = cargarRegistro(valor('--registro') || process.env.BARRIDOS_REGISTRO_FILE!);
    const cuenta = registro.find((c) => c.channel === 'mercadolibre'); if (!cuenta || cuenta.channel !== 'mercadolibre') throw new Error('no hay cuenta ML en el registro');
    const keyring = cargarKeyring(process.env.CATALOGO_KEYRING_FILE);
    // Relectura de E3 por el cupo sombra con consumidor 'identidad' (E1 T5 §2.8): en producción ese cupo está cerrado
    // (GATEWAY_ML_SHADOW_RPM_E2E3=0) hasta que José lo abra, así que el canario no puede leer ML antes de tiempo.
    const transporte = cuenta.transporte === 'gateway' ? crearTransporteGateway({ url: cuenta.base_url, keyring, consumidor: 'identidad', sellerId: cuenta.seller_id }) : crearClienteCanal({ baseUrl: cuenta.base_url });
    const r = await correrCanario(pool, crearRelectoresMl({ transporte })['ml.items']!, { corridaId: valor('--corrida'), bandeja: true }); console.log(JSON.stringify(r));
  } else if (comando === 'cerrar') console.log(JSON.stringify(await cerrarCanario(pool, { corridaId: valor('--corrida') })));
  else if (comando === 'estado') { const r = await pool.query(`SELECT estado, count(*)::int AS casos FROM catalog.e3_canario_casos WHERE corrida_id=$1 GROUP BY estado`, [valor('--corrida')]); console.log(JSON.stringify(r.rows)); }
  else throw new Error('uso: congelar|correr|cerrar|estado');
} finally { await pool.end(); }
