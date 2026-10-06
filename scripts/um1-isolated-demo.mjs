#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/index.js';
import {
  escanearGuardiaMl, estadoGuardiaMl, retenerPedidoMl,
  pedidoMlRetenido, resolverRetencionPedidoMl,
} from '../lib/guardiaMl.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fusion-um1-demo-'));
const db=openDb(path.join(dir,'demo.sqlite'));
const ts=new Date().toISOString();
try {
  db.prepare(`INSERT INTO ml_publicaciones_cache
    (clave,item_id,variation_id,titulo,status,seller_sku,available_quantity,atributos_json,actualizado_en)
    VALUES (?,?,?,?,?,?,?,'[]',?)`).run('MLA-DEMO|VAR-1','MLA-DEMO','VAR-1','Bicicleta demo','active','',1,ts);
  const scan=escanearGuardiaMl(db,'demo');
  if(scan.total!==1 || !estadoGuardiaMl(db).degradado) throw new Error('scan local no quedó degradado');
  retenerPedidoMl(db,{orderId:'ORDER-DEMO',items:[{item_id:'MLA-DEMO'}],claves:['MLA-DEMO|VAR-1']});
  if(!pedidoMlRetenido(db,'ORDER-DEMO')) throw new Error('retención no persistió');
  db.prepare("UPDATE guardia_ml_casos SET estado='excepcion',excepcion_vence_en=? WHERE clave=?")
    .run(new Date(Date.now()-1000).toISOString(),'MLA-DEMO|VAR-1');
  escanearGuardiaMl(db,'demo');
  const caso=db.prepare("SELECT estado FROM guardia_ml_casos WHERE clave=?").get('MLA-DEMO|VAR-1');
  if(caso.estado!=='abierto') throw new Error('excepción vencida no reabrió el caso');
  if(!resolverRetencionPedidoMl(db,'ORDER-DEMO','demo','liberado') || pedidoMlRetenido(db,'ORDER-DEMO')) throw new Error('liberación no auditada');
  const eventos=db.prepare("SELECT COUNT(*) n FROM guardia_ml_eventos WHERE caso_id=(SELECT id FROM guardia_ml_casos WHERE clave=? )").get('MLA-DEMO|VAR-1').n;
  console.log(JSON.stringify({ok:true,demo:'UM1',caso_reabierto:true,pedido_liberado:true,eventos}));
} finally { db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
