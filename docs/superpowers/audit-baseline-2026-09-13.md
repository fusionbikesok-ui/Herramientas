# Fotografía auditada de referencia — 2026-09-13

Consulta exclusivamente de lectura realizada el 2026-09-13 UTC. Es una fotografía, no estado vivo ni
aceptación de ninguna entrega.

## Git y despliegue

- Backend: `e31484d26ef6f680fe48c1e990cce0bd1e6baa87`, rama `conteo-confiable`, coincidente con origin al medir.
- Proceso observado: `node /opt/fusionbikes/herramientas/server.js`, iniciado 2026-09-13 19:57:53 UTC.
- App: `4f9eec2eaea9bc52025792f8544793fd84ab4c17`, rama `feature/stock-flow-ui`.
- Hallazgo bloqueante para E19: App estaba un commit por delante de
  `origin/feature/stock-flow-ui` (`c5b2430`) al medir. Debe publicarse o descartarse explícitamente.
- Servicios observados relevantes: cron, Docker y nginx activos. No se infiere que un contenedor no
  listado sea inexistente; el inventario se refresca al iniciar cada entrega.

## Base productiva

- Archivo: `data/fusion.sqlite`; modificación `2026-09-13 20:43:01 UTC`; 127.848.448 bytes.
- 161 tablas SQLite.
- `catalogo_cache`: 5.170 filas.
- `ml_publicaciones_cache`: 6.925 filas.
- `identidad_casos`: 1.250 filas; universo conciliado: 1.055 verificadas, 11 esperando operación,
  0 urgentes y 0 conflictos de bolsa `user_product`.
- `gestion_pedidos`: 2.161 filas.
- `preparaciones`: 294 filas.
- `stock_movements`: 0 filas.
- `recepciones`: 16 filas; `inventario_sesiones`: 39 filas.
- `stock_incidents`, `warranty_cases` y `workshop_jobs`: 0 filas.

## Comandos de reproducción

```bash
git status --short --branch
git rev-parse HEAD
git -C /opt/fusionbikes/FusionBikes-App status --short --branch
git -C /opt/fusionbikes/FusionBikes-App rev-parse HEAD
ps -eo pid,lstart,args | rg 'node .*server.js'
systemctl list-units --type=service --all --no-pager
docker ps --format '{{.Names}} {{.Image}} {{.Status}}'
```

Los conteos se ejecutan con `better-sqlite3`, `{readonly:true,fileMustExist:true}`. Nunca se abre una
base productiva sin modo read-only durante una auditoría documental.
