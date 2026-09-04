# UM1.2 — Detección y cobertura durable

**Estado:** planificada. **Dependencia:** UM1.1 candidata. **Superficie:** VPS.

## Resultado

Impedir que reaparezca cobertura insegura mediante eventos durables ML/Woo, relectura desde origen, scan completo cada 15 minutos, salud degradada a los 60 minutos, alertas en menos de dos minutos y operaciones recuperables tras reinicios.

## Gates

- Evento perdido, duplicado y fuera de orden convergen mediante scan.
- Claims avisan a los 20 minutos y vencen a los 30.
- Tres fallos o quince minutos terminan en intervención visible.
- Sin despliegue ni activación antes de revisión, tests y piloto.
