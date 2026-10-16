# Inventario del VPS

Fuente de verdad de qué corre en el servidor, en qué carpeta del repo vive su código y cómo se despliega.
`scripts/ops/drift-vps.sh` lee este archivo: compara cada directorio en ejecución contra su carpeta del repo
(`origin/master`) y los IDs de imagen de los contenedores contra la tabla «Imágenes esperadas».
**Al desplegar una imagen nueva hay que actualizar esa tabla en el mismo PR.**

Estado al 2026-10-16. Lo marcado «(a documentar)» no tiene un procedimiento escrito en el repo; se dejó lo observado.

## Servicios

| Servicio | Tipo | Directorio / imagen en el VPS | Carpeta del repo | Cómo se despliega |
|---|---|---|---|---|
| `herramientas` (app Node, puerto 3001) | pm2 (`pm2-root.service` → `pm2 resurrect`) | `/opt/fusionbikes/herramientas` (`start.sh` → `server.js`) | raíz del repo (`/`) | Checkout de prod de solo lectura para edición: se hace `git fetch` + `git merge --ff-only` de `master` y `pm2 restart herramientas`. Respaldo previo con tag `rollback/prod-pre-*`. |
| `fusion-plataforma-api-1`, `-scheduler-1` | docker compose | imágenes locales `fusion-plataforma` · `/opt/fusionbikes/herramientas/plataforma/deploy/compose.yml` | `plataforma/` (`plataforma/deploy`) | Construir imagen desde `plataforma/` y `docker compose up -d`. Hoy corren con imágenes **sin tag** (ver nota bajo «Imágenes esperadas»). |
| `fusion-plataforma-worker-1` (sombra) | docker compose | imagen `fusion-plataforma:sombra-mensajes-20261016-r4` · override `/opt/fusionbikes/plataforma-prod/sombra-worker.override.yml` | `plataforma/` + `deploy/servidor/plataforma-prod/sombra-worker.override.yml` | Imagen armada a mano como overlay (`FROM` imagen previa + `COPY` de los archivos cambiados); se cambia el tag en el override y `docker compose up -d worker`. |
| `fusion-pg-pg-1` (PostgreSQL + pgBackRest) | docker compose | imagen `fusion-pg:local` · `/opt/fusionbikes/herramientas/deploy/postgres/compose.prod.yml` | `deploy/postgres/` | `docker compose -f compose.prod.yml up -d`; backup diario por cron (`deploy/servidor/cron.d/fusion-backup`). |
| `fusion-management-validation` (gateway de gestión) | systemd (+ drop-ins) | `/opt/fusion-management-migration` (`gateway.mjs`) | `integrations/management-migration/` y `deploy/systemd/` | Copiar archivos al directorio (rsync desde el repo) y `systemctl restart fusion-management-validation`. |
| `fusion-management-migration-php-1`, `-db-1` | docker compose | `fusion-management-migration:20261004` y `mysql:8.0` · `/opt/fusion-management-migration/compose.json` | `integrations/management-migration/` | `docker compose` con `compose.json`; plugins mu en `mu-plugins/` montados de solo lectura. |
| `fusion-pdf-corrector` | systemd | `/opt/fusion-management-migration` (`pdf-worker.py`) | `integrations/management-migration/` (`fusion-pdf-corrector.service`) | Copiar archivos y `systemctl restart fusion-pdf-corrector`. |
| Timers de gestión: `fusion-management-directory-sync`, `-metrics-sync`, `fusion-stock-whatsapp`, `fusion-arca-backup` | systemd (timer + service) | `/opt/fusion-management-migration` | `integrations/management-migration/` y `deploy/systemd/` | Copiar la unidad a `/etc/systemd/system/`, `systemctl daemon-reload`, `enable --now` del timer. |
| ARCA: `fusion-arca-egress`, `-source`, `-outbox` | systemd | `/opt/fusion-management-migration`, secretos en `/etc/fusion-arca-private` (no versionado) | `integrations/management-migration/arca/` y `deploy/systemd/` | Igual que los timers de gestión. |
| Chatbot: `fusion-chatbot-api-1`, `-worker-1`, `-outbox-1`, `-catalog-exporter-1`, `-ollama-1`, `-postgres-1`, `-redis-1` | docker compose | `/opt/fusion-chatbot` · imagen `fusion-chatbot-attention:20261015` | `integrations/mensajeria/bot/` | Hoy por zips copiados al VPS + `docker compose build/up -d`. Con el versionado: rsync desde el repo y el mismo compose. |
| Respaldo de mensajería a Drive: `fusion-mensajeria-drive`, `fusion-mensajeria-prospects` | systemd (timers) | `/opt/fusion-chatbot/ops/drive-backup` | `integrations/mensajeria/bot/ops/drive-backup/` | Copiar unidad y `enable --now` del timer. |
| Migración de chat (QA): `fusion-chat-migration-qa-*` (api, worker, postgres, redis) | docker compose | `/opt/fusion-chat-migration-qa` (`compose.qa.json`) | `integrations/chat-migration-qa/` | Entorno aislado de pruebas (sin red saliente); `docker compose -f compose.qa.json up -d`. |
| POS de prueba: `fbpos-test-wp`, `fbpos-test-db` | docker compose | `/opt/fusionbikes-pos-test` · `wordpress:php8.2-apache`, `mysql:8.0` | `integrations/pos-test/` | `docker compose up -d`; el plugin `fusion-bikes-pos` se monta desde `wp-content/plugins/`. |
| Backup de herramientas-app y PostgreSQL | cron | `/etc/cron.d/fusion-backup`, `/opt/fusionbikes/backups/backup.sh` | `deploy/servidor/cron.d/`, `deploy/servidor/backups/` | Copiar a las rutas del VPS. Claves de B2 y passphrase fuera del repo. |
| nginx (herramientas, fusionbikes, bot, vision) | nginx del host | `/etc/nginx/sites-enabled/*` (symlinks a `sites-available`) | `deploy/servidor/nginx/sites-available/` | Copiar el sitio, `nginx -t && systemctl reload nginx`. Certificados de Let's Encrypt fuera del repo. |
| Firewall del puerto 3001: `fusion-firewall-3001` | systemd (oneshot) | `/usr/local/sbin/fusion-firewall-3001.sh`, unidad en `/etc/systemd/system/` | `deploy/servidor/sbin/fusion-firewall-3001.sh` y `deploy/servidor/systemd/fusion-firewall-3001.service` | Copiar script (modo 755) y unidad, `systemctl daemon-reload`, `enable --now`. Idempotente: cadena `FUSION_3001` que solo deja pasar loopback y 172.16.0.0/12. |
| Copia de estado PG: `fusion-estado-pg-copia` | systemd (service + timer cada 1 min) | copia `/opt/fusionbikes/backups/estado-pg-archivo.json` a `/opt/fusionbikes/estado-pg/` | `deploy/servidor/systemd/fusion-estado-pg-copia.{service,timer}` (el archivo lo genera `scripts/postgres/estado-archivo.sh`) | Copiar service y timer, `daemon-reload`, `enable --now` del timer. |

## Imágenes esperadas

`scripts/ops/drift-vps.sh` busca las filas de esta tabla (contenedor, imagen y ID `sha256:…` completo o prefijo de 12).
Si un contenedor no está en la tabla, se informa como «sin anotar».

| Contenedor | Imagen | ID de imagen |
|---|---|---|
| fusion-plataforma-worker-1 | fusion-plataforma:sombra-mensajes-20261016-r4 | sha256:549542828674ab2966951bd6bbb1de3e17cb2fc024fe8ef17426b15bccd2acb1 |
| fusion-plataforma-api-1 | (sin tag; la config dice `fusion-plataforma:local`) | sha256:8b785766dbdf91b0f3baf6dd9c807c2ed9eab176bd1e2bfdacd46703dcf944b3 |
| fusion-plataforma-scheduler-1 | (sin tag; la config dice `fusion-plataforma:local`) | sha256:b91861153819e90c8dac339ca4531e64d661ae0241e6645d62c87824acd29125 |
| fusion-pg-pg-1 | fusion-pg:local | sha256:4ecf8f68e1aafff1b51ed4a2a3d9ba87ffcda59161cdafe34131a58abb55f7b6 |
| fusion-management-migration-php-1 | fusion-management-migration:20261004 | sha256:de6b51dd8fb0efaba9baf4407b69ade9b1f2faa2c1d228af668b7fbe220b1571 |
| fusion-management-migration-db-1 | mysql:8.0 | sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b |
| fusion-chatbot-api-1 | fusion-chatbot-attention:20261015 | sha256:73642f79d198873f283afebc8bde17808c69a92ca30ff573886e20229863d0ab |
| fusion-chatbot-worker-1 | fusion-chatbot-attention:20261015 | sha256:73642f79d198873f283afebc8bde17808c69a92ca30ff573886e20229863d0ab |
| fusion-chatbot-outbox-1 | fusion-chatbot-attention:20261015 | sha256:73642f79d198873f283afebc8bde17808c69a92ca30ff573886e20229863d0ab |
| fusion-chatbot-catalog-exporter-1 | fusion-chatbot-catalog-exporter | sha256:f31313935ce63f6904b19a55ed7175833efa52c96631ba0d461541cb48985b32 |
| fusion-chatbot-ollama-1 | ollama/ollama:latest | sha256:9d30908e41144b1f1da89b9d8e33c07e4aeb43ff41a8660241b1686e2cc330ad |
| fusion-chatbot-postgres-1 | postgres:16-alpine | sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685 |
| fusion-chatbot-redis-1 | redis:7-alpine | sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2 |
| fusion-chat-migration-qa-api-1 | (imagen QA) | sha256:0524e75d9eb1e424945fffb9d27bb187a372dceb5337f51892ccf7c7bd0fce9b |
| fusion-chat-migration-qa-worker-1 | (imagen QA) | sha256:0524e75d9eb1e424945fffb9d27bb187a372dceb5337f51892ccf7c7bd0fce9b |
| fusion-chat-migration-qa-postgres-1 | (imagen QA) | sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685 |
| fusion-chat-migration-qa-redis-1 | (imagen QA) | sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2 |
| fbpos-test-wp | wordpress:php8.2-apache | sha256:eb3f6cc56445dadea9c5cc6442fb60fbacfc433b2d253a96b6d8ffd4c5b2c0cf |
| fbpos-test-db | mysql:8.0 | sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b |

**Nota api/scheduler (2026-10-16):** esos IDs ya no existen como imágenes locales: el tag `fusion-plataforma:local` fue
reasignado y hoy apunta a otra imagen (`e67761ded868`, = `sombra-prev-20261015`). Los contenedores siguen corriendo
con la imagen vieja sin tag. Al reconstruirlos hay que **retaguearlos desde un commit** (p. ej. `fusion-plataforma:<fecha>-<sha>`),
actualizar esta tabla y no volver a usar `:local`. Tags locales actuales: `sombra-mensajes-20261016-r4` (549542828674),
`sombra-capacidad-20261015-r3` (aa2f621cf537), `sombra-recuperacion-20261015-r2` (20ee28ac7896), `sombra-recuperacion-20261015` (73bf9a7cf75a).

## Carpetas comparadas por `drift-vps.sh`

El script compara archivo por archivo (ignorando fin de línea CRLF y lo que cubra un `.gitignore`):
`/opt/fusionbikes/herramientas` ↔ raíz · `/opt/fusion-management-migration` ↔ `integrations/management-migration` ·
`/opt/fusion-chatbot` ↔ `integrations/mensajeria/bot` · `/opt/fusion-chat-migration-qa` ↔ `integrations/chat-migration-qa` ·
`/opt/fusionbikes-pos-test` ↔ `integrations/pos-test` · y los archivos sueltos de `deploy/servidor/` y `deploy/systemd/`.

## Cómo leer la deriva de `herramientas`

- «Solo en repo» de `integrations/*`, `deploy/*` y `scripts/ops/`: es normal hasta que se actualice el checkout de prod
  (`/opt/fusionbikes/herramientas`) a un `master` que ya incluya esos PR; después de ese `git merge --ff-only` desaparece.
- `test-results/` (salida de corridas de test) está en el `.gitignore` raíz y no cuenta como deriva.

## Pendiente de versionar (trabajo de Astra, solo en el VPS)

Existen en `/opt/fusionbikes/herramientas` pero no están en ningún commit; no se subieron porque son trabajo en curso de Astra:

- `public/mensajeria/attention.css`
- `public/mensajeria/attention.js`
- `public/privacidad/fusion-backup/*` (varios archivos)
- `test/mensajeria-attention.test.js`

Mientras no se versionen, `drift-vps.sh` los informa como «solo en VPS». Cuando Astra los commitee y se despliegue, la deriva se cierra.
