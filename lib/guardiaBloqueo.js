// Módulo hoja: evita un ciclo entre el worker de Guardia y el motor de escritura ML.
export function claveBloqueadaGuardia(db, clave) {
  return !!db.prepare("SELECT 1 FROM guardia_ml_casos WHERE clave=? AND estado!='resuelto' AND bloquea_sync=1 LIMIT 1").get(clave);
}
