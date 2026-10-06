# Chat nativo — ensayo privado de migración

Estado: primera conversación web completa funcionando **sólo en QA**, con datos ficticios y respuestas automáticas simuladas. No es un reemplazo listo para producción. Los plugins de WordPress y Master Control no se modifican.

## Rutas y acceso

- Código desplegado: `/opt/fusion-chat-migration-qa`.
- Proyecto Compose: `fusion-chat-migration-qa`, archivo `compose.qa.json`, variables en `qa.env` con permisos 0600. Ese archivo no debe copiarse a Git ni a reportes.
- Red Docker interna propia, PostgreSQL y Redis propios, sin puertos publicados. El navegador accede por túnel SSH al contenedor API y escucha sólo en `127.0.0.1:8191` de la computadora local. No hay URL pública nueva.
- Pantalla `/qa/`: vistas cliente/asesor, historial, toma, respuesta, liberación y archivo. Bot simulado explícitamente. Actor de ensayo fijo; NO sustituye la sesión ni los permisos reales de Herramientas.
- API de visitante `/v1/web/session`, `/v1/web/messages`: token de capacidad aleatorio 256 bits en Authorization; sólo se guarda su hash. El navegador genera ese token con Web Crypto. Cada mensaje tiene un UUID estable durante el reintento.
- API de operador `POST /v1/internal/chat`: HMAC SHA-256 sobre timestamp, método, ruta, nonce y cuerpo; clave independiente, ventana de 60 s y protección de replay en Redis. El futuro proxy de Herramientas debe autorizar al usuario y aportar su identidad; estas claves nunca deben llegar al frontend.

## Garantías implementadas y comprobadas

Mensaje, comando y trabajo pendiente se graban juntos en PostgreSQL. Reintentos con el mismo UUID y contenido devuelven el resultado anterior; reutilizar UUID con otro contenido produce conflicto. La toma de conversación usa revisión y bloqueo por sesión. Respuestas del bot verifican la revisión, el último mensaje y el control humano al guardar; se descartan cuando la conversación cambió. Los trabajos usan leases y reintentos limitados, recuperables tras interrupción.

Sólo hay bot simulado; el worker nativo no llama a WordPress, WhatsApp, catálogo ni IA. El arranque se niega si el entorno no es migration-test, la base/usuario no son native_chat_qa, o se intenta habilitar IA. La red interna se verificó además con un intento fallido de conexión saliente sin datos.

18 pruebas nativas sobre PostgreSQL y Redis reales pasaron. La suite original del bot tiene **un fallo previo**, reproducido también contra su imagen productiva inalterada sin red: `test_department_from_channel_label` espera posventa_taller para la etiqueta Posventa/Taller, pero `department_for` actual devuelve ventas cuando no hay texto. Esa diferencia de contrato debe resolverse antes de activar el bot real. No se cambió ni se ocultó esa prueba.

La vista es un ensayo operativo, no el widget final: falta migrar leads/carrito abandonado, historial real, horarios, consola de aprendizaje, WhatsApp, permisos/notificaciones y retención. No hay ahorro de PHP en la tienda hasta trasladar tráfico real y retirar el procesamiento equivalente de WordPress. POS, Facturador y Taller siguen pendientes.

## Reproducción y operación

La carpeta app del despliegue combina el snapshot original (hashes en original-source-manifest.json) con los archivos native_*.py y native_preview. Las imágenes de API/PostgreSQL/Redis reutilizan los IDs inmutables existentes; no se descargaron dependencias ni se actualizaron los servicios originales.

`ops/provision.py` configura únicamente el proyecto QA. `ops/test_and_start.py` ejecuta las pruebas nativas, **borra exclusivamente datos ficticios de QA** tras comprobar el guard, y arranca el worker. No ejecutar durante una revisión interactiva que se desee conservar. `ops/check_baseline.py` reproduce las pruebas originales sin red ni volúmenes productivos. `ops/verify_environment.py` verifica aislamiento, persistencia tras reinicio y salud del bot/Herramientas. `ops/test_reconnect.py` interrumpe 14 segundos sólo la API QA y siempre intenta reanudarla.

Detener sin borrar datos:

```sh
docker compose --env-file /opt/fusion-chat-migration-qa/qa.env -f /opt/fusion-chat-migration-qa/compose.qa.json -p fusion-chat-migration-qa stop
```

Reanudar la misma copia:

```sh
docker compose --env-file /opt/fusion-chat-migration-qa/qa.env -f /opt/fusion-chat-migration-qa/compose.qa.json -p fusion-chat-migration-qa up -d --wait
```

Respaldo anterior de código/configuración y PostgreSQL: `/opt/fusionbikes/backups/chat-migration/20261004T220310Z`. gzip y el índice del dump se verificaron; no se ensayó todavía una restauración completa. Los archivos de respaldo permanecen privados en el VPS.

Referencias de implementación: [bloqueos de filas y SKIP LOCKED de PostgreSQL](https://www.postgresql.org/docs/current/sql-select.html), [redes internas de Docker Compose](https://docs.docker.com/reference/compose-file/networks/).
