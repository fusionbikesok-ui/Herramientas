# E1 T4 · tarea 16 — avance de la puesta en producción (2026-09-18)

Estado: **a mitad de camino y detenido a pedido de José**. Nada de esto emite informes todavía: el scheduler
sigue sin la configuración de informes, así que la vuelta diaria no corre.

## Lo que ya está hecho

| Paso | Estado |
|---|---|
| Buckets en B2 | `bucket-produccion` y `bucket-verificacion`, privados, región `us-east-005`, endpoint `https://s3.us-east-005.backblazeb2.com`. Object Lock **habilitado** en los dos y cifrado por omisión SSE-B2 |
| Credenciales de B2 | `e1-escritura` (`listBuckets,listFiles,writeFiles,readFileRetentions,writeFileRetentions`) y `e1-lectura` (`listBuckets,listFiles,readFiles,readFileRetentions`), las dos acotadas a `bucket-produccion`, **sin** `deleteFiles` ni `bypassGovernance`. En `/opt/fusionbikes/plataforma-prod/secretos/b2-{escritura,lectura}-{id,clave}`, 0600 |
| Clave de firma | `kid e1-2026-09`, privada en `/opt/fusionbikes/plataforma-prod/keyring/firma-informes.pem` (0600, root); pública commiteada en `specs/e1/firma-informes/e1-2026-09.pub`, huella SHA-256 `vxWdZOUP21/br6qbfukLe50pNE76GAwjBo50krnYYoE=` |
| Verificación contra B2 real | hecha en `bucket-verificacion` con una credencial temporal, ya borrada |
| Email | remitente y destinatario: los mismos del canal de alertas del legado (`SMTP_FROM` y `ALERTAS_EMAIL`) |

## Lo que la verificación contra B2 real encontró

Las dos cosas se corrigieron en `4929051`, con sus tests.

**1. Backblaze rechaza la subida con Object Lock si no lleva suma de verificación.** Respuesta textual:
`400 InvalidRequest — Content-MD5 OR x-amz-checksum- HTTP header is required for Put Object requests with
Object Lock parameters`. Nuestro código no la mandaba y el simulador de los tests no la exigía: **el primer
informe de producción habría fallado**. Es el caso que justifica que esta verificación no se haga con un doble.

**2. La credencial de escritura puede OCULTAR un objeto.** Un `DELETE` con esa credencial devolvió 204, aunque
no tiene `deleteFiles`: en B2 el permiso de escritura incluye ocultar. Comprobado qué pasa en realidad:

- `b2_list_file_versions` muestra dos entradas para la clave: `hide` (0 bytes, sin retención) y `upload`
  (52 bytes, `lock: compliance`). O sea que **no se destruyó nada**.
- Un `GET` sin versión devuelve **404**; el mismo `GET` con `versionId` explícito devuelve **200** y el
  contenido completo, con la credencial de lectura.

Conclusión: la evidencia es indestructible, pero se puede volver invisible para quien no sepa pedir la versión.
No se puede prevenir con permisos. Decisión de José: **hacerlo detectable**. La vuelta diaria lista las versiones
de los últimos 7 días, marca la entrega oculta (`informes.entregas.oculto_en`, migración 0012) y la ruta interna
`/internal/v1/informes/estado` la expone.

Lo que **sí** quedó verificado como rechazado: acortar la retención con la credencial de escritura devuelve
`405 MethodNotAllowed`.

## Lo que falta para terminar la tarea 16

1. **El vigilante del legado todavía no alerta por informes ocultos.** La ruta interna ya los expone; falta que
   `lib/vigilanteInformes.js` los lea y abra incidente, con su test. Es lo único que quedó a medias del cambio.
2. **Configurar el scheduler**: las quince variables de `CAMPOS_INFORMES` en `plataforma.env` y los montajes del
   keyring y del directorio de pendientes en `deploy/compose.yml`, que hoy no los pasa al servicio.
3. **Aplicar las migraciones** 0009 a 0012 con `npm run migrar` y recrear los contenedores.
4. **Un envío real de email** y la primera vuelta diaria observada.
5. **Arrancar la campaña de 7 días** verdes seguidos.

## Limpieza hecha

- Credencial temporal `e1-verificacion-temporal` **borrada** de B2.
- Quedó un objeto de prueba en `bucket-verificacion` y dos en `bucket-produccion`, bajo `e1/verificacion/`, con
  retención compliance hasta 2027-09-20: no se pueden borrar, y no molestan (son 52 bytes cada uno).
- La clave maestra de Backblaze está en el `.env` del legado y **apareció completa en la salida de un comando
  durante esta sesión**: conviene rotarla desde el panel de B2.
