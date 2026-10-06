#!/bin/bash
# Firma y verificación Ed25519 de registros de E0 (ensayos de restauración y backups).
#
#   firmar-registro.sh firmar   <registro.json> [clave-privada.pem]   → <registro.json>.sig
#   firmar-registro.sh verificar <registro.json> [clave-publica.pem]  → exit 0 si la firma es válida
#
# La privada vive en /root/.config/fusion-pg/firma-ed25519.pem (600, sólo en el VPS). La pública está
# versionada en deploy/postgres/firma-ed25519.pub. La firma prueba integridad, no cifra: si se pierde
# la privada se genera otra y las firmas anteriores siguen verificándose con la pública de su commit.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
accion="${1:-}"; registro="${2:-}"
[ -n "$accion" ] && [ -f "$registro" ] || { echo "Uso: $0 firmar|verificar <registro.json> [clave]" >&2; exit 2; }

case "$accion" in
  firmar)
    clave="${3:-/root/.config/fusion-pg/firma-ed25519.pem}"
    openssl pkeyutl -sign -inkey "$clave" -rawin -in "$registro" -out "$registro.sig"
    echo "firmado: $registro.sig (sha256 del registro $(sha256sum "$registro" | cut -d' ' -f1))"
    ;;
  verificar)
    publica="${3:-$REPO/deploy/postgres/firma-ed25519.pub}"
    openssl pkeyutl -verify -pubin -inkey "$publica" -rawin -in "$registro" -sigfile "$registro.sig"
    ;;
  *) echo "Acción inválida: $accion" >&2; exit 2 ;;
esac
