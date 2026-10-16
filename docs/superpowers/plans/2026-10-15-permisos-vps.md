# Administración central de permisos de las aplicaciones del VPS

Solicitud: gestionar desde `/herramientas/usuarios/` el acceso del equipo a todas las aplicaciones disponibles en el VPS.

## Alcance y decisiones

- Conservar las cuentas y permisos actuales. Los permisos nuevos no se asignan automáticamente.
- Publicar siete controles para aplicaciones del VPS: ventas, stock, alertas de stock, clientes/pedidos, Andreani, corrector PDF y copia del taller. Las herramientas existentes y Mensajería siguen en el mismo formulario.
- POS y Facturador operan en la tienda desde el 6/10/2026. Sus dos controles administran únicamente los enlaces desde Herramientas; WordPress conserva la autorización operativa/fiscal. No se reactiva la operación en el VPS.
- Los controles binarios describen todas las acciones que habilitan. Se separa la configuración de alertas del informe de stock. Mensajería y las herramientas que ya distinguen lectura/escritura conservan esos niveles.
- La sesión y sus permisos se consultan en cada solicitud del gateway. La interfaz filtra navegación, pero la denegación efectiva ocurre en el servidor.
- La asignación central sincroniza el rol explícito de Mensajería y su auditoría en una transacción, conservando al último supervisor. No cambia el router de Mensajería que otra tarea está modificando.

## Pasos y aceptación

1. Inventariar el código productivo y el gateway activo; conservar hash por archivo y comprobar que el código versionable coincide con el runtime. No tocar bases productivas durante el desarrollo.
2. Incorporar `integrations/management-migration/permissions.mjs`, compartido por `lib/permisos.js` y `gateway.mjs`. Cubrir cada destino validado, ambos formatos REST, assets y métodos; denegar rutas sin clasificación a usuarios comunes.
3. Actualizar `routes/usuarios.js` para sincronizar y auditar Mensajería. Aceptación: altas/bajas/cambios efectivos sin iniciar otra sesión, sin elevar a administrador y sin retirar al último supervisor.
4. Actualizar `public/usuarios/index.html`, `public/home/index.html` y el inicio de Gestión VPS. Aceptación: buscador de permisos, explicaciones, distinción de enlaces externos y navegación acorde a la asignación; sin desbordes a 390/768/1440 px.
5. Probar en `/opt/fusion-permissions-20261015/repo`, con fuentes copiadas sin `.env` ni bases productivas. Cubrir asignación, revocación, desactivación, aislamiento entre módulos, CSRF, manipulación de parámetros y regresiones existentes.
6. Preparar copia de seguridad, comprobación de hashes y reversión por archivos. La política vigente exige confirmación manual antes de reemplazar código productivo y recargar los dos servicios.

## Publicación y reversión previstas

Aplicar sólo los archivos de este cambio, verificando nuevamente sus hashes. Sin migración de esquema ni modificación masiva de usuarios. El gateway usa `fusion-management-validation.service`; Herramientas usa el proceso PM2 existente. Verificar salud, catálogo nuevo y denegación anónima. Ante error, restaurar sólo los archivos respaldados y recargar esos servicios; nunca restaurar bases viejas ni sobrescribir trabajo concurrente.

## Publicación realizada — 2026-10-15

Publicación autorizada por el usuario y aplicada con respaldo `/opt/fusion-permissions-20261015/backup/20261016T011025Z`. Suite general: 4.637 pruebas aprobadas, ninguna fallida y 52 omitidas por la configuración existente. La versión final volvió a aprobar 27 pruebas de Usuarios/permisos y 104 del gateway (una omitida). Comprobación pública: salud 200, acceso anónimo 401 y nueve aplicaciones rechazadas con 403 para la cuenta limitada de pruebas. No se modificaron permisos productivos durante las verificaciones.
