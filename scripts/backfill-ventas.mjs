#!/usr/bin/env node
// Backfill/incremental manual de ventas_historial (Fase 3). El cron diario en server.js
// hace lo mismo automáticamente; este script es para forzar una corrida a mano.
import 'dotenv/config';
import { openDb } from '../db/index.js';
import { backfillVentas } from '../lib/criticidad.js';

const db = openDb(process.env.DB_PATH || 'data/fusion.sqlite');
const cfg = {
  woo: { url: process.env.WOO_URL, ck: process.env.WOO_CK, cs: process.env.WOO_CS },
  ml: {
    clientId: process.env.ML_CLIENT_ID,
    clientSecret: process.env.ML_CLIENT_SECRET,
    userId: process.env.ML_USER_ID,
  },
};

console.log('backfill-ventas: arrancando...');
const resultado = await backfillVentas(db, cfg);
console.log(JSON.stringify(resultado, null, 2));
process.exit(0);
