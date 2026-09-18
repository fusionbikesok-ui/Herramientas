import type pg from 'pg';
import { medianocheArt } from './dia.ts';

export const MOTIVOS_EXPLICADOS = ['recurso_borrado', 'fuera_de_ventana', 'sin_historial', 'descartada_contada'] as const;
export interface ResumenTopico { senales_legado:number; senales_nucleo:number; faltantes:number; faltantes_sin_explicar:number; cobertura:number; convergencia:number|null; descartadas:number }
export interface Alerta { nivel:'baja'|'media'|'alta'; codigo:string; mensaje:string; topic?:string }
export interface Manifiesto { tipo:'manifiesto'; fecha:string; ventana:{desde:string;hasta:string}; primer_chain_seq:string|null; ultimo_chain_seq:string|null; ultimo_hash:string; eventos:number; cadena:{integra:boolean;roto_en:string|null} }
export interface Reporte { tipo:'reporte'; fecha:string; ventana:{desde:string;hasta:string}; topicos:Record<string,ResumenTopico>; faltantes_sin_explicar:number; alertas:Alerta[]; semaforo:'verde'|'amarillo'|'rojo'; dia_campana:number|null; reporte_anterior:string|null }
const FALTANTES = ['dead_lettered','retryable','pending','claimed'];

export async function armarReporte(pool:pg.Pool, fecha:string, opciones:{manifiesto?:Manifiesto}={}):Promise<Reporte> {
  const desde=medianocheArt(fecha); const siguiente=new Date(desde); siguiente.setUTCDate(siguiente.getUTCDate()+1); const hasta=medianocheArt(siguiente.toISOString().slice(0,10)); const params=[desde,hasta];
  const rows=(await pool.query(`SELECT s.topic,s.status,s.error_detail,s.source,a.channel FROM integrations.reconciliation_signals s JOIN core.channel_accounts a ON a.id=s.channel_account_id WHERE s.received_at >= $1 AND s.received_at < $2`,params)).rows as Array<{topic:string;status:string;error_detail:string|null;source:string;channel:string}>;
  const topicos:Record<string,ResumenTopico>={};
  for(const row of rows){const t=topicos[row.topic]??={senales_legado:0,senales_nucleo:0,faltantes:0,faltantes_sin_explicar:0,cobertura:0,convergencia:null,descartadas:0}; if(row.source==='webhook_copy')t.senales_legado++; if(row.status==='succeeded')t.senales_nucleo++; if(row.status==='excluded')t.descartadas++; if(FALTANTES.includes(row.status)||row.status==='excluded'){t.faltantes++;if(!row.error_detail||!(MOTIVOS_EXPLICADOS as readonly string[]).includes(row.error_detail))t.faltantes_sin_explicar++;}}
  const sweeps=(await pool.query(`SELECT topic,strategy,known_resources,swept,converged,enumerated FROM integrations.sweep_runs WHERE started_at >= $1 AND started_at < $2 AND status='succeeded'`,params)).rows as Array<{topic:string;strategy:string;known_resources:number|null;swept:number|null;converged:number|null;enumerated:number|null}>;
  for(const s of sweeps){const t=topicos[s.topic]??={senales_legado:0,senales_nucleo:0,faltantes:0,faltantes_sin_explicar:0,cobertura:0,convergencia:null,descartadas:0};if(s.strategy==='convergence'){t.cobertura=s.known_resources?(s.swept??0)/s.known_resources:1;t.convergencia=s.swept?(s.converged??0)/s.swept:null;}else if(s.enumerated!==null)t.cobertura=s.enumerated?t.senales_nucleo/s.enumerated:1;}
  for(const t of Object.values(topicos))if(t.cobertura===0)t.cobertura=t.senales_nucleo+t.faltantes?t.senales_nucleo/(t.senales_nucleo+t.faltantes):1;
  const faltantes_sin_explicar=Object.values(topicos).reduce((n,t)=>n+t.faltantes_sin_explicar,0); const alertas:Alerta[]=[];
  if(faltantes_sin_explicar)alertas.push({nivel:'alta',codigo:'faltantes_sin_explicar',mensaje:`${faltantes_sin_explicar} faltantes sin explicación`});
  for(const [topic,t] of Object.entries(topicos)){if(t.convergencia!==null&&t.convergencia<1)alertas.push({nivel:'media',codigo:'convergencia_incompleta',mensaje:'Convergencia incompleta',topic});if(t.cobertura<1)alertas.push({nivel:'baja',codigo:'cobertura_incompleta',mensaje:'Cobertura incompleta',topic});}
  if(opciones.manifiesto&&!opciones.manifiesto.cadena.integra)alertas.push({nivel:'alta',codigo:'cadena_rota',mensaje:'La cadena de auditoría está rota'});
  const entregas=(await pool.query<{fecha:string}>(`SELECT fecha::text AS fecha FROM informes.entregas WHERE tipo='reporte' AND fecha < $1 AND estado_aviso='avisado' ORDER BY fecha DESC`,[fecha])).rows; const anterior=entregas[0]?.fecha??null; let dia_campana=anterior?1:null;
  if(anterior){let cursor=new Date(`${fecha}T12:00:00Z`);let consecutivos=0;for(const e of entregas){cursor.setUTCDate(cursor.getUTCDate()-1);if(e.fecha!==cursor.toISOString().slice(0,10))break;consecutivos++;}dia_campana=consecutivos+1;}
  const semaforo=alertas.some(a=>a.nivel==='alta')?'rojo':alertas.some(a=>a.nivel==='media')?'amarillo':'verde'; return {tipo:'reporte',fecha,ventana:{desde:desde.toISOString(),hasta:hasta.toISOString()},topicos,faltantes_sin_explicar,alertas,semaforo,dia_campana,reporte_anterior:anterior};
}
