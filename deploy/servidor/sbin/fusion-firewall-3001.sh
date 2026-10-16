#!/bin/sh
# E1 T3 (2026-09-16, decisión de José): el legado escucha en *:3001 y respondía desde Internet sin pasar por
# Nginx. Sólo se admite loopback (Nginx) y las redes de Docker (plataforma → gateway). Idempotente.
set -e
for T in iptables ip6tables; do
  $T -N FUSION_3001 2>/dev/null || $T -F FUSION_3001
  $T -A FUSION_3001 -i lo -j ACCEPT
  if [ "$T" = iptables ]; then
    $T -A FUSION_3001 -s 127.0.0.0/8 -j ACCEPT
    $T -A FUSION_3001 -s 172.16.0.0/12 -j ACCEPT
  else
    $T -A FUSION_3001 -s ::1/128 -j ACCEPT
  fi
  $T -A FUSION_3001 -j DROP
  $T -C INPUT -p tcp --dport 3001 -j FUSION_3001 2>/dev/null || $T -I INPUT 1 -p tcp --dport 3001 -j FUSION_3001
done
