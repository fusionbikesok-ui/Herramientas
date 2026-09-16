#!/bin/bash
# E1-GW-02: el plano de control interno del legado no es alcanzable por Nginx. Debe correrse desde
# FUERA del VPS para que valga como evidencia pública; desde el VPS sólo prueba la configuración.
# Éxito = cada variante responde 404 SIN `X-Powered-By: Express` (Nginx corta antes del proxy).
set -euo pipefail
HOST="${1:-herramientas.fusionbikes.com.ar}"
IP="${2:-}"
urls=(
  "https://$HOST/internal/v1/channel-read" "https://$HOST/herramientas/internal/v1/channel-read"
  "https://$HOST/INTERNAL/v1/channel-read" "https://$HOST/herramientas//internal/v1/channel-read"
  "https://$HOST/herramientas/%69nternal/v1/channel-read" "https://$HOST/Herramientas/Internal/v1/channel-read"
)
[ -n "$IP" ] && urls+=("http://$IP/internal/v1/channel-read" "http://$IP/herramientas/internal/v1/channel-read" "http://$IP/herramientas/InTeRnAl/v1/channel-read")
fallas=0
for u in "${urls[@]}"; do
  r="$(curl -s -o /dev/null -w '%{http_code}|%header{x-powered-by}' --max-time 10 -X POST "$u" || echo 'ERR|')"
  if [ "${r%%|*}" = 404 ] && [ -z "${r#*|}" ]; then echo "ok    $u"; else echo "FALLA $u -> $r"; fallas=$((fallas+1)); fi
done
# Puerto 3001 del legado (firewall del VPS, 2026-09-16): desde afuera no debe conectar.
if [ -n "$IP" ]; then
  if curl -s -o /dev/null --max-time 6 "http://$IP:3001/healthz"; then echo "FALLA http://$IP:3001 conecta desde afuera"; fallas=$((fallas+1)); else echo "ok    http://$IP:3001 no conecta"; fi
fi
echo "{\"id\":\"E1-GW-02\",\"fecha\":\"$(date -u +%FT%TZ)\",\"variantes\":${#urls[@]},\"fallas\":$fallas}"
[ "$fallas" -eq 0 ]
