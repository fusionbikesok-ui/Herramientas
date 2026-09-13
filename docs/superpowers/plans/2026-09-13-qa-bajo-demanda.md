# Plan: entorno de pruebas (QA) bajo demanda

**Fecha:** 2026-09-13 · **Estado:** aprobado por el usuario 2026-09-13 (acceso solo local) · **Entrega:** P0 Gate 0 (ficha
`deliveries/PLAT-0-gate0.md`) · **Marco:** plan de plataforma §2.2 y §8.

## Decisiones fijadas

| Tema | Decisión | Origen |
|---|---|---|
| Dónde | Mismo VPS, stack y base propios, prioridad de recursos menor que producción | plan §2.2, §8 |
| Encendido | **Bajo demanda**: se levanta para probar y se apaga | usuario 2026-09-13 |
| Acceso | **Solo local en el VPS** (`127.0.0.1`), sin publicar; lo opera el asistente | usuario 2026-09-13 (Cloudflare no se puede modificar por ahora; reemplaza "subdominio con clave") |
| Quién lo levanta | El asistente, cuando una prueba lo necesita | usuario 2026-09-13 |
| Canales | MercadoLibre y WooCommerce **simulados**; ninguna credencial real en QA | usuario 2026-09-13, plan §2.2 |
| Anonimización | **Clientes** y **usuarios internos** obligatoria; fotos y precios no | usuario 2026-09-13 |

## Hechos medidos que condicionan el diseño

- VPS: 2 CPU, 7,8 GB RAM (3,7 GB disponibles con chatbot, Ollama y fusion-vision corriendo).
- El dominio pasa por **Cloudflare** y por ahora no se puede modificar: no hay subdominio para QA.
  Si más adelante hace falta que el equipo lo vea, la vía preferida es `qa-herramientas.fusionbikes.com.ar`
  (el certificado gratis de Cloudflare no cubre `qa.herramientas…`).
- La app ya soporta `DISABLE_CRONS=true` y `DB_PATH`, `PORT` por entorno.
- Datos personales en la base (medido): columnas directas en `gestion_pedido_clientes`
  (18.255), `gestion_pedido_entregas`, `preparaciones`, `pedidos_cache`, `users`; y **dentro de
  JSON** en `gestion_pedidos.datos_ml_json`, `ordenes_ml_wc_pedidos.comprador_json`,
  `gestion_pedido_eventos.datos_json`, `integration_events`, `identidad_evidencias`, entre otras.
  Secretos en base: `ml_oauth_token`, `device_tokens`, `mobile_refresh_tokens`,
  `password_reset_tokens`.

## Pasos

### 1. Snapshot anonimizado (`scripts/qa/snapshot-anonimizado.mjs`) — automático, lo corre quien levanta QA

1. Copia consistente con `backup-db.mjs` a un archivo temporal fuera de `data/`.
2. **Secretos:** vacía `ml_oauth_token`, `device_tokens`, `mobile_refresh_tokens`,
   `password_reset_tokens`, sesiones.
3. **Usuarios internos:** conserva ids, roles y permisos; reemplaza `username` por `usuario<id>`,
   `email` por `usuario<id>@qa.invalid` y `pass_hash` por el hash de una clave de QA común.
4. **Clientes, columnas directas:** reemplazo determinístico por id (`Cliente 1234`,
   `cliente1234@qa.invalid`, teléfono y DNI falsos con formato válido, dirección genérica
   conservando ciudad y código postal para no romper lógica de envíos).
5. **Clientes dentro de JSON:** recorre cada JSON de una **lista cerrada de columnas** y reemplaza
   claves conocidas (`first_name`, `last_name`, `nickname`, `email`, `phone`, `address_line`,
   `street_name`, `doc_number`, `receiver_name`, `billing`, `shipping`…). Si una columna JSON no
   está en la lista, **el script falla** (lista cerrada, no "mejor esfuerzo").
6. **Verificación obligatoria:** busca en toda la base los emails, teléfonos y DNI reales de una
   muestra tomada antes de anonimizar; si aparece alguno, borra el snapshot y falla.
7. Test vitest con una base sembrada que contiene datos personales en columnas y en JSON.

**Implementado 2026-09-13** (`scripts/qa/snapshot-anonimizado.mjs`, `test/qa-snapshot-anonimizado.test.js`).
Ajustes respecto del diseño, decididos al implementar:
- Usuarios internos: se **conserva `username`** (la auditoría de preparaciones, conteos y
  etiquetas guarda nombres de usuario en texto); se reemplazan `email` y `pass_hash`.
- Teléfono y documento falsos llevan prefijo `QA-TEL-` / `QA-DOC-` en lugar de un formato
  numérico válido: así nunca colisionan con un dato real de la muestra.
- La verificación trata los valores sólo numéricos como número completo (sin dígitos pegados):
  la primera corrida real dio falso positivo con teléfonos contenidos en números largos de
  atributos de publicaciones ML.
- Sesiones: `data/sessions.sqlite` es otro archivo y nunca se copia. `direccion` en `sync_log`,
  `identidad_casos` y `cobertura_sesion` es sentido de sincronización, no dato personal.
- Corrida real contra producción: 80 s, 121 MB, 1.021 valores de muestra verificados, 18.269
  clientes anonimizados, tokens y emails internos eliminados, `quick_check` ok.
- Clave común de QA generada en `/root/.config/fusion-qa/clave` (600).

### 2. Simuladores de canales (`scripts/qa/simulador-canales.mjs`)

- Servidor local que responde las rutas de ML y Woo que usa la app con datos derivados del
  snapshot. Permite forzar errores (401, 403, 429, 5xx, timeout) para probar fallos.
- QA arranca con `ML_*`/`WOO_*` apuntando al simulador y `PUSH_REAL_ENABLED=false`, SMTP a un
  buzón falso local. Ningún secreto de producción se copia al `.env` de QA.
- **Pendiente de verificar al implementar:** si las URLs base de ML y Woo son configurables por
  entorno; si no lo son, agregar esa opción es parte de este paso.

**Implementado 2026-09-13** (`scripts/qa/simulador-canales.mjs`, `test/qa-simulador-canales.test.js`).
- Verificado: toda llamada del servidor a ML pasa por `lib/mlClient.js`; se agregó `ML_API_BASE`
  (producción no la define → API real; test en `test/mlClient.test.js`). Woo ya usa `WOO_URL`.
- Woo exige `https://` en tres lugares (`routes/woo.js`, `lib/gtinWoo.js`, `lib/wooWebhooks.js`):
  el simulador sirve HTTPS con certificado propio y el contenedor QA confía sólo en él con
  `NODE_EXTRA_CA_CERTS` (no se desactiva la verificación TLS).
- Resto de salidas: SMTP sin `SMTP_HOST` no envía; push real sólo con `PUSH_REAL_ENABLED=true`;
  `NODE_ENV` sólo afecta la validación de push → QA usa `NODE_ENV=qa` y `PUSH_PROVIDER=mock`;
  Gemini sin `GEMINI_KEY`. `fusion-pricing` de WordPress responde 503 en el simulador.
- Control de pruebas: `GET /__qa/llamadas`, `POST|DELETE /__qa/fallas` (regex de ruta, status,
  veces, `retryAfter`).

### 3. Stack QA (`deploy/qa/docker-compose.yml`)

- Contenedores `qa-app` (Node 24, código de la rama a probar, `PORT` interno, `DB_PATH` al
  snapshot) y `qa-simulador`. `DISABLE_CRONS=true` por defecto; se pueden activar para probar
  crons porque solo hablan con el simulador.
- Límites: `cpus: 0.75`, `mem_limit: 768m`, `cpu_shares` bajos. Uploads: carpeta vacía propia.

### 4. Acceso

- Puertos publicados sólo en `127.0.0.1` (app QA en `127.0.0.1:3101`, simulador sin publicar,
  sólo en la red interna del stack). Sin cambios en Nginx ni en Cloudflare.
- El asistente prueba con curl y Playwright desde el propio VPS. Si el usuario quiere mirar,
  túnel SSH (`ssh -L 3101:127.0.0.1:3101 root@VPS`) y abre `http://localhost:3101`.
- Cuentas de QA: las generadas por el paso 1.3, con la clave de QA guardada en
  `/root/.config/fusion-qa/clave` (600), nunca la de producción.

### 5. Comandos (`scripts/qa/qa.sh`)

- `qa.sh up [rama]`: genera snapshot anonimizado, construye, levanta, verifica `/healthz`.
- `qa.sh down`: baja el stack y **borra el snapshot**.
- `qa.sh status`. Apagado automático tras 8 h encendido (cron del sistema).

## Criterios de aceptación

1. `qa.sh up` levanta QA en < 5 min, `http://127.0.0.1:3101/healthz` responde y el puerto no es
   alcanzable desde afuera del VPS (verificado contra la IP pública).
2. La verificación del paso 1.6 pasa; un test demuestra que falla si queda un dato real.
3. En QA no existe ninguna variable con credenciales reales (verificado por script contra los
   nombres de `.env` de producción).
4. Con crons activados en QA, producción no registra ninguna llamada extra a ML ni Woo.
5. Con QA encendido, `/healthz` de producción sigue < 50 ms y QA no pasa sus límites.
6. `qa.sh down` deja el disco como estaba (sin snapshot ni imágenes colgadas).

## Qué necesita el usuario

- Aprobar este plan (el plan de plataforma exige aprobación antes de instalar servicios).
- Nada en Cloudflare ni en Nginx.
