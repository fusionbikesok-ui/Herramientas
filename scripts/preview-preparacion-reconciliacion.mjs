#!/usr/bin/env node
import 'dotenv/config';
import Database from 'better-sqlite3';
import { reconciliarPreparacionesAbiertas } from '../routes/preparacion.js';

const dbPath = process.env.DB_PATH;
if (!dbPath) throw new Error('Definí DB_PATH para consultar la base a previsualizar.');

const db = new Database(dbPath);
try {
  db.prepare('SELECT 1 FROM preparacion_reconciliaciones LIMIT 0').get();
  const totalAbiertas = db.prepare("SELECT COUNT(*) n FROM preparaciones WHERE estado='en_preparacion'").get().n;
  const config = {
    woo: { url: process.env.WOO_URL, ck: process.env.WOO_CK, cs: process.env.WOO_CS },
    ml: {
      clientId: process.env.ML_CLIENT_ID,
      clientSecret: process.env.ML_CLIENT_SECRET,
      userId: process.env.ML_USER_ID,
    },
    enviadoAndreaniStatus: process.env.ANDREANI_ENVIADO_STATUS || 'enviadoandreani',
  };
  const vistas = [];
  const limite = 50;
  for (let offset = 0; offset < totalAbiertas; offset += limite) {
    const lote = await reconciliarPreparacionesAbiertas(db, config, { simular: true, limite, offset });
    vistas.push(...lote.previsualizacion);
  }
  process.stdout.write(`${JSON.stringify({
    modo: 'simulacion_sin_cambios_de_preparaciones',
    total_abiertas_al_inicio: totalAbiertas,
    consultadas: vistas.length,
    previstas: vistas,
  }, null, 2)}\n`);
} finally {
  db.close();
}
