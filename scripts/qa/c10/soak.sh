#!/bin/bash
# E1 T3 C10 — prueba en vivo con la copia de sombra al 100 % (Woo). Cada 5 min mide legado, plataforma y
# alertas; ante una condición crítica aplica el aborto del SOP (SOMBRA_COPIA_ENABLED=false + reinicio del
# legado) y termina. Al final escribe la evidencia. Uso: soak.sh <horas>
set -uo pipefail
RAIZ=/opt/fusionbikes/herramientas; HORAS="${1:-5}"; TS="$(date -u +%Y%m%dT%H%M%SZ)"
DIR="/root/e1-c10/$TS"; mkdir -p "$DIR"; chmod 700 /root/e1-c10 "$DIR"; LOG="$DIR/soak.log"
cd "$RAIZ"; DB="$(realpath "$(grep "^DB_PATH=" "$RAIZ/.env" | cut -d= -f2-)")"; DESDE="$(date -u +%FT%TZ)"
fin=$(( $(date +%s) + HORAS * 3600 )); fallos_legado=0; fallos_plataforma=0; abortado=""
log() { echo "$(date -u +%T) $*" | tee -a "$LOG"; }
sqlpg() { docker exec fusion-pg-pg-1 psql -U postgres -d plataforma -At -c "$1" 2>/dev/null; }
medir() {
  node -e "
const D=require('$RAIZ/node_modules/better-sqlite3');const db=new D('$DB',{readonly:true});
const r={};
for(const f of db.prepare(\"SELECT channel||':'||COALESCE(shadow_status,'-')||':'||COALESCE(shadow_reason,'') k, COUNT(*) n FROM integration_events WHERE received_at>=? GROUP BY 1\").all('$DESDE')) r[f.k]=f.n;
const inc=db.prepare(\"SELECT tipo_error, severidad FROM incidentes_operativos WHERE integracion='sombra' AND estado='activo'\").all();
console.log(JSON.stringify({recibos:r,incidentes:inc}));"
}
abortar() {
  abortado="$1"; log "ABORTO: $1 — apagando la copia (SOP)"
  cp -a "$RAIZ/.env" "$DIR/env-antes-aborto"
  sed -i 's/^SOMBRA_COPIA_ENABLED=true$/SOMBRA_COPIA_ENABLED=false/' "$RAIZ/.env"
  pm2 restart herramientas >/dev/null 2>&1
  for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3001/healthz)" = 200 ] && break; sleep 1; done
  log "legado tras aborto: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/healthz)"
}
log "inicio prueba ${HORAS} h, copia Woo 100 %, desde $DESDE"
while [ "$(date +%s)" -lt "$fin" ]; do
  L="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3001/healthz)"
  PH="$(curl -s --max-time 8 http://127.0.0.1:3201/api/v2/health | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).status)}catch{console.log('sin_respuesta')}})")"
  M="$(medir)"; S="$(sqlpg "select coalesce(string_agg(status||'='||n,','),'') from (select status,count(*) n from integrations.reconciliation_signals group by 1) t")"
  VIEJA="$(sqlpg "select coalesce(max(extract(epoch from now()-received_at))::int,0) from integrations.reconciliation_signals where status in ('pending','claimed','retryable')")"
  log "legado=$L plataforma=$PH señales[$S] señal_activa_mas_vieja_s=$VIEJA $M"
  [ "$L" = 200 ] && fallos_legado=0 || fallos_legado=$((fallos_legado+1))
  [ "$PH" = ok ] && fallos_plataforma=0 || fallos_plataforma=$((fallos_plataforma+1))
  if [ "$fallos_legado" -ge 3 ]; then abortar "legado sin /healthz 200 en 3 mediciones"; break; fi
  if echo "$M" | grep -qE '"tipo_error":"(cola_llena|cola_saturada|perdidas_sin_importar|respuesta_no_terminada)"'; then abortar "alerta de sombra activa: $(echo "$M" | grep -oE '"tipo_error":"[a-z_]+"' | tr '\n' ' ')"; break; fi
  if [ "$fallos_plataforma" -ge 6 ]; then abortar "plataforma no ok durante 30 min"; break; fi
  [ "${VIEJA:-0}" -gt 1800 ] && log "AVISO: señal activa de más de 30 min"
  sleep 300
done
log "fin: ${abortado:-sin aborto}"
{ echo "# C10 — prueba en vivo ${HORAS} h (copia Woo 100 %) $TS"; echo; echo "Resultado: **${abortado:+ABORTADA — $abortado}${abortado:-completada sin aborto}**"; echo;
  echo "Decisión de José 2026-09-17: prueba de ${HORAS} h en lugar de las 24 h de E1-SOAK-01 (no satisface ese ID)."; echo; echo '```'; tail -3 "$LOG"; echo '```'; } > "$DIR/evidencia.md"
