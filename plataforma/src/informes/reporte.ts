import type pg from 'pg';
import { medianocheArt } from './dia.ts';

export const MOTIVOS_EXPLICADOS = ['recurso_borrado', 'fuera_de_ventana', 'sin_historial', 'descartada_contada'] as const;
export type MotivoExplicado = typeof MOTIVOS_EXPLICADOS[number];
export interface ResumenTopico { senales_legado:number; senales_nucleo:number; faltantes:number; faltantes_sin_explicar:number; cobertura:number; convergencia:number|null; descartadas:number }
export interface Alerta { nivel: 'baja'|'media'|'alta'; codigo: string; mensaje: string; topic?: string }
export interface Reporte { tipo:'reporte'; fecha:string; ventana:{desde:string;hasta:string}; topicos:Record<string,ResumenTopico>; faltantes_sin_explicar:number; alertas:Alerta[]; semaforo:'verde'|'amarillo'|'rojo'; dia_campana:number|null; reporte_anterior:string|null }
export interface Manifiesto { tipo:'manifiesto'; fecha:string; ventana:{desde:string;hasta:string}; primer_chain_seq:string|null; ultimo_chain_seq:string|null; ultimo_hash:string; eventos:number; cadena:{integra:boolean;roto_en:string|null} }

export async function armarReporte(pool: pg.Pool, fecha: string, opciones: { manifiesto?: Manifiesto; ahora?: Date } = {}): Promise<Reporte> {
  const desde = medianocheArt(fecha); const siguiente = new Date(desde); siguiente.setUTCDate(siguiente.getUTCDate()+1); const hasta = medianocheArt(siguiente.toISOString().slice(0,10));
  const rows = (await pool.query(`SELECT topic, source, status, error_detail FROM integrations.reconciliation_signals WHERE received_at >= $1 AND received_at < $2`, [desde, hasta])).rows as {topic:string;source:string;status:string;error_detail:string|null}[];
  const topicos: Record<string,ResumenTopico> = {};
  for (const row of rows) { const t = topicos[row.topic] ??= {senales_legado:0,senales_nucleo:0,faltantes:0,faltantes_sin_explicar:0,cobertura:0,convergencia:null,descartadas:0}; if (row.source === 'ml_missed_feed') t.senales_legado++; if (row.status === 'succeeded') t.senales_nucleo++; if (row.status === 'excluded') t.descartadas++; if (['dead_lettered','retryable','pending','claimed','excluded'].includes(row.status)) { t.faltantes++; if (!row.error_detail || !(MOTIVOS_EXPLICADOS as readonly string[]).includes(row.error_detail)) t.faltantes_sin_explicar++; } }
  for (const t of Object.values(topicos)) t.cobertura = t.faltantes + t.senales_nucleo ? t.senales_nucleo / (t.faltantes+t.senales_nucleo) : 1;
  const faltantes_sin_explicar = Object.values(topicos).reduce((n,t)=>n+t.faltantes_sin_explicar,0); const alertas:Alerta[]=[];
  if (faltantes_sin_explicar) alertas.push({nivel:'alta',codigo:'faltantes_sin_explicar',mensaje:`${faltantes_sin_explicar} faltantes sin explicación`});
  if (opciones.manifiesto && !opciones.manifiesto.cadena.integra) alertas.push({nivel:'alta',codigo:'cadena_rota',mensaje:'La cadena de auditoría está rota'});
  const anterior = (await pool.query<{fecha:string}>(`SELECT fecha::text AS fecha FROM informes.entregas WHERE tipo='reporte' AND fecha < $1 AND estado_aviso='avisado' ORDER BY fecha DESC LIMIT 1`,[fecha])).rows[0]?.fecha ?? null;
  return {tipo:'reporte',fecha,ventana:{desde:desde.toISOString(),hasta:hasta.toISOString()},topicos,faltantes_sin_explicar,alertas,semaforo:alertas.some(a=>a.nivel==='alta')?'rojo':alertas.some(a=>a.nivel==='media')?'amarillo':'verde',dia_campana:anterior?1:null,reporte_anterior:anterior};
}
