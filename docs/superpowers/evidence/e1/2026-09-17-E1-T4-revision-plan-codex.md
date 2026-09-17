# Evaluación externa del plan de E1 T4 (Codex, gpt-5.6-sol, esfuerzo bajo) — 2026-09-17

Sólo lectura. Plan evaluado: `plans/2026-09-17-e1-tramo4-seguridad-reporte.md` en el commit `00c374a`.

## Críticos

1. **Tarea 10: el estado lineal pierde entregas cuando B2 falla.**  
   En [el plan:1463](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1463), ante fallo de B2 se deja el artefacto en `firmado`, pero luego el email avanza “los dos artefactos” a `avisado`. Eso convierte en terminal un artefacto nunca subido e impide reintentarlo; además contradice el test que espera `firmado` en [el plan:1419](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1419). `upload` y `email` necesitan estados independientes, no `generado→firmado→subido→avisado`.

2. **Tarea 10: `vuelta.test.ts` no compila y sus casos comparten estado.**  
   Usa `afterEach` sin importarlo en [el plan:1366](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1366). Además crea una sola base en `beforeAll` y todos los casos trabajan sobre `2026-09-16` sin limpiar `informes.entregas`; el primer caso deja ambas filas `avisado`, por lo que los casos de fallo B2, subida dudosa e incidente ya no ejecutan esos caminos ([plan:1375](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1375), [plan:1411](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1411)).

3. **Tareas 6/8/10: la retención no se calcula desde el PUT.**  
   `armarManifiesto` fija `retention_until` desde el final del día reportado más 367 días ([plan:975](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:975)); `subir` recibe esa fecha ya firmada ([plan:1135](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1135)). Al recuperar días viejos puede quedar menos de 365 días desde la subida. Recalcularla dentro de `subir` haría que el sobre firmado mintiera. La retención efectiva debe fijarse respecto del intento confirmado de PUT y modelarse separadamente del contenido diario.

4. **Tarea 7: los tests usan una tabla imaginaria.**  
   Los `INSERT` de [el plan:1041](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1041) usan `channel` y `exclusion_reason`, omiten `channel_account_id` y `source`, y emplean el estado `dead`. La tabla real exige la FK y `source`, no tiene esas columnas y el estado es `dead_lettered`: [0005_senales.sql:6](/opt/fusionbikes/herramientas/plataforma/migrations/0005_senales.sql:6). La indicación de “corregir nombres” apunta además a `0001`, aunque la tabla nace en `0005` ([plan:1086](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1086)).

5. **Tarea 6: el fixture de auditoría falla antes de probar el manifiesto.**  
   `evento()` usa una empresa fija que no se crea y `correlationId: "c-1"` ([plan:860](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:860)). `audit_events` exige una FK válida y UUID: [0001_esquema_base.sql:135](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:135). `registrarEvento` no normaliza esos valores.

6. **Tarea 13: el usuario de prueba no puede insertarse.**  
   [El plan:1766](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1766) usa `security.users(email, display_name)`. Esas columnas no existen; son obligatorios `company_id` y `username`, y el email se guarda cifrado con índice ciego: [0001_esquema_base.sql:65](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:65).

7. **Tareas 4 y 12: `migraciones.test.ts` necesariamente falla.**  
   El test compara literalmente la lista `0001…0008` en [migraciones.test.ts:24](/opt/fusionbikes/herramientas/plataforma/test/migraciones.test.ts:24) y nuevamente en [migraciones.test.ts:59](/opt/fusionbikes/herramientas/plataforma/test/migraciones.test.ts:59). Ni la tarea 4 ni la 12 incluyen actualizar ese archivo en sus cambios/commits ([plan:548](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:548), [plan:1626](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1626)).

8. **Tarea 13 necesita una tercera migración que el plan no define ni despliega.**  
   El límite por cuenta/IP/global requiere persistencia; `security.recovery_codes` no tiene intentos ([0001_esquema_base.sql:110](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:110)). “Tabla o columna nueva si hace falta” en [el plan:1812](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1812) no asigna migración, esquema, permisos ni archivo de commit. Tarea 16 sólo aplica `0009` y `0010` ([plan:1933](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1933)). “Cerrar sesiones abiertas” tampoco es implementable: plataforma no posee tabla ni proveedor de sesiones reales; [sesion.ts:6](/opt/fusionbikes/herramientas/plataforma/src/auth/sesion.ts:6) declara explícitamente que E1 sólo tiene una sesión inyectable de tests.

## Altos

9. **Tarea 5 no implementa una máquina de estados ni un fencing suficiente.**  
   `avanzar` verifica únicamente `testigo`: permite saltar, retroceder estados y escribir con un lease vencido ([plan:786](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:786)). `reclamar` tampoco compara el hash nuevo con `hash_contenido`; puede subir contenido B dejando registrado el hash de A ([plan:761](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:761)). Y verificar el testigo sólo después del PUT/email no evita que dos dueños ejecuten el efecto si el lease vence durante la llamada.

10. **Tarea 6 no verifica la cadena hasta el extremo congelado.**  
    El código llama `audit.verify_chain(NULL)` ([plan:971](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:971)), pese a prometer verificar hasta el último `chain_seq` capturado. La función real acepta `desde, hasta`: [0001_esquema_base.sql:185](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:185). El parche sugerido de tipar sólo `NULL` tampoco corrige el límite.

11. **El esquema existente sigue contradiciendo COMPLIANCE.**  
    `audit.audit_daily_manifests.retention_mode` sólo acepta `governance`: [0001_esquema_base.sql:200](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:200). Ninguna tarea migra esa restricción; agregar únicamente `informes.entregas` no corrige el contrato persistente.

12. **Tarea 8 no prueba SigV4.**  
    El test sólo busca el prefijo de `Authorization` y un hash hexadecimal ([plan:1159](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1159)). Pasarían una canonical URI, canonical query, `SignedHeaders`, scope, región o firma incorrectos. `GET ?retention` queda subespecificado: falta probar `retention=`, encoding por segmentos, credencial lectora y `versionId` de la versión concreta. Tampoco valida que la respuesta diga `Mode=COMPLIANCE` ni que la retención alcance la esperada.

13. **Tarea 16 intenta probar retención en un bucket sin Object Lock.**  
    El paso 1 crea el bucket de pruebas sin Object Lock ([plan:1926](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1926)), pero el paso 6 pretende subir allí con retención y leerla ([plan:1936](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1936)). B2/S3 rechazará headers de Object Lock en ese bucket.

14. **Tarea 12 no especifica ni prueba realmente SimpleWebAuthn 14.0.2.**  
    El único test de ceremonia es un cuerpo vacío con comentarios ([plan:1680](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1680)); no existe autenticador virtual ni helper equivalente en `plataforma/test`. Tampoco fija las llamadas y estructuras reales de 14.0.2, `expectedOrigin`, `expectedRPID`, `requireUserVerification`, conversión de `credential_id/public_key`, contador/backup flags o autorización de registro. `pedir()` también queda sin implementar en el snippet.

15. **El test de doble llave puede pasar dejando rutas sin guarda.**  
    Recorre `RUTAS_PASSKEYS`, lista mantenida por la misma implementación ([plan:1670](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1670)). Una ruta Fastify registrada pero omitida de esa constante no se prueba. Debe inspeccionar las rutas reales o registrar todo el prefijo detrás de un único plugin comprobable.

16. **Tarea 11 no conecta el vigilante con la autenticación HMAC que exige.**  
    `revisarInformeDelDia` sólo recibe `{url, fetch, ahora}` ([plan:1505](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1505)), pero la ruta nueva debe llevar “la misma firma HMAC” ([plan:1602](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1602)). No se agrega keyring/orígenes/configuración ni generación de headers en el legado, ni registro de la opción en `OpcionesApi`. La API interna existente no es reutilizable sin más: está acoplada al POST y cuerpo crudo en [senales.ts:50](/opt/fusionbikes/herramientas/plataforma/src/api/senales.ts:50).

17. **Los “incidentes críticos” no tienen destino implementable.**  
    Tarea 10 exige abrirlos ([plan:1470](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1470)), pero plataforma sólo expone una vista de incidentes derivados de inbox/outbox: [0001_esquema_base.sql:352](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:352). No hay tabla o API para incidentes de informes ni tarea que la produzca.

18. **Tarea 14 convierte el gate en evidencia nominal.**  
    El gate sólo busca IDs en títulos y el plan manda renombrar tests ([plan:1861](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1861)). Un único `it` parcial por ID puede poner el tramo verde sin demostrar todos los subcasos enumerados.

## Medios

19. **JCS acepta Unicode inválido.**  
    `texto()` itera y concatena surrogates UTF-16 no apareados ([plan:158](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:158)); al convertir a UTF-8 Node los sustituye por U+FFFD. RFC 8785 exige fallar. Faltan vectores oficiales y tests de lone surrogate en claves y valores.

20. **Los tests del manifiesto no demuestran sus nombres y dependen del reloj.**  
    “Fija los extremos” nunca afirma `primer_chain_seq` ni `ultimo_chain_seq` ([plan:870](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:870)). Usa `clock_timestamp()` y calcula “hoy ART” después, por lo que puede cruzar medianoche. La aserción de retención tampoco mide desde el PUT.

21. **Tareas 5, 7 y 13 tienen estado/reloj compartido.**  
    Tarea 5 sólo borra leases, no filas ([plan:683](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:683)); tarea 7 acumula señales entre casos ([plan:1029](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1029)); tarea 13 deja cinco fallos del usuario para el caso siguiente y usa `Date.now()` únicamente en el sexto intento ([plan:1788](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1788)). Son dependientes del orden y no prueban por separado límites por cuenta, IP y global.

22. **Tarea 9 no prueba SMTP y propone reimplementarlo a mano.**  
    El fake sólo comprueba que se pasó un objeto a una interfaz ([plan:1298](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1298)). No cubre EHLO multiline, STARTTLS/TLS, AUTH, respuestas 4xx/5xx, CRLF/dot-stuffing, MIME/base64 ni header injection. El legado ya usa `nodemailer`: [mailer.js:1](/opt/fusionbikes/herramientas/lib/mailer.js:1). El cliente SMTP manual sobra.

23. **Tarea 4 no prueba todos los permisos que afirma.**  
    El caso “puede leer y escribir” sólo ejecuta `UPDATE` y un `DELETE` denegado ([plan:583](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:583)); el `INSERT` depende de otro test y nunca prueba `SELECT` aisladamente.

## Sobra

- **Tareas 12 y 13 completas:** login, reautenticación y recuperación reales detrás de un interruptor que debe permanecer apagado, sin sesión real, dominio, UI ni usuarios productivos. Es alcance de E4 y obliga a inventar contratos ahora.
- **El cliente SMTP artesanal de la tarea 9**, existiendo una biblioteca madura ya usada por el repo.
- **`retention_until` dentro del manifiesto previo a la subida**: mezcla evidencia del día con un resultado operativo que todavía no existe y causa la contradicción temporal señalada arriba.
tokens used
108,855
## Críticos

1. **Tarea 10: el estado lineal pierde entregas cuando B2 falla.**  
   En [el plan:1463](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1463), ante fallo de B2 se deja el artefacto en `firmado`, pero luego el email avanza “los dos artefactos” a `avisado`. Eso convierte en terminal un artefacto nunca subido e impide reintentarlo; además contradice el test que espera `firmado` en [el plan:1419](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1419). `upload` y `email` necesitan estados independientes, no `generado→firmado→subido→avisado`.

2. **Tarea 10: `vuelta.test.ts` no compila y sus casos comparten estado.**  
   Usa `afterEach` sin importarlo en [el plan:1366](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1366). Además crea una sola base en `beforeAll` y todos los casos trabajan sobre `2026-09-16` sin limpiar `informes.entregas`; el primer caso deja ambas filas `avisado`, por lo que los casos de fallo B2, subida dudosa e incidente ya no ejecutan esos caminos ([plan:1375](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1375), [plan:1411](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1411)).

3. **Tareas 6/8/10: la retención no se calcula desde el PUT.**  
   `armarManifiesto` fija `retention_until` desde el final del día reportado más 367 días ([plan:975](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:975)); `subir` recibe esa fecha ya firmada ([plan:1135](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1135)). Al recuperar días viejos puede quedar menos de 365 días desde la subida. Recalcularla dentro de `subir` haría que el sobre firmado mintiera. La retención efectiva debe fijarse respecto del intento confirmado de PUT y modelarse separadamente del contenido diario.

4. **Tarea 7: los tests usan una tabla imaginaria.**  
   Los `INSERT` de [el plan:1041](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1041) usan `channel` y `exclusion_reason`, omiten `channel_account_id` y `source`, y emplean el estado `dead`. La tabla real exige la FK y `source`, no tiene esas columnas y el estado es `dead_lettered`: [0005_senales.sql:6](/opt/fusionbikes/herramientas/plataforma/migrations/0005_senales.sql:6). La indicación de “corregir nombres” apunta además a `0001`, aunque la tabla nace en `0005` ([plan:1086](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1086)).

5. **Tarea 6: el fixture de auditoría falla antes de probar el manifiesto.**  
   `evento()` usa una empresa fija que no se crea y `correlationId: "c-1"` ([plan:860](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:860)). `audit_events` exige una FK válida y UUID: [0001_esquema_base.sql:135](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:135). `registrarEvento` no normaliza esos valores.

6. **Tarea 13: el usuario de prueba no puede insertarse.**  
   [El plan:1766](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1766) usa `security.users(email, display_name)`. Esas columnas no existen; son obligatorios `company_id` y `username`, y el email se guarda cifrado con índice ciego: [0001_esquema_base.sql:65](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:65).

7. **Tareas 4 y 12: `migraciones.test.ts` necesariamente falla.**  
   El test compara literalmente la lista `0001…0008` en [migraciones.test.ts:24](/opt/fusionbikes/herramientas/plataforma/test/migraciones.test.ts:24) y nuevamente en [migraciones.test.ts:59](/opt/fusionbikes/herramientas/plataforma/test/migraciones.test.ts:59). Ni la tarea 4 ni la 12 incluyen actualizar ese archivo en sus cambios/commits ([plan:548](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:548), [plan:1626](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1626)).

8. **Tarea 13 necesita una tercera migración que el plan no define ni despliega.**  
   El límite por cuenta/IP/global requiere persistencia; `security.recovery_codes` no tiene intentos ([0001_esquema_base.sql:110](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:110)). “Tabla o columna nueva si hace falta” en [el plan:1812](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1812) no asigna migración, esquema, permisos ni archivo de commit. Tarea 16 sólo aplica `0009` y `0010` ([plan:1933](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1933)). “Cerrar sesiones abiertas” tampoco es implementable: plataforma no posee tabla ni proveedor de sesiones reales; [sesion.ts:6](/opt/fusionbikes/herramientas/plataforma/src/auth/sesion.ts:6) declara explícitamente que E1 sólo tiene una sesión inyectable de tests.

## Altos

9. **Tarea 5 no implementa una máquina de estados ni un fencing suficiente.**  
   `avanzar` verifica únicamente `testigo`: permite saltar, retroceder estados y escribir con un lease vencido ([plan:786](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:786)). `reclamar` tampoco compara el hash nuevo con `hash_contenido`; puede subir contenido B dejando registrado el hash de A ([plan:761](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:761)). Y verificar el testigo sólo después del PUT/email no evita que dos dueños ejecuten el efecto si el lease vence durante la llamada.

10. **Tarea 6 no verifica la cadena hasta el extremo congelado.**  
    El código llama `audit.verify_chain(NULL)` ([plan:971](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:971)), pese a prometer verificar hasta el último `chain_seq` capturado. La función real acepta `desde, hasta`: [0001_esquema_base.sql:185](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:185). El parche sugerido de tipar sólo `NULL` tampoco corrige el límite.

11. **El esquema existente sigue contradiciendo COMPLIANCE.**  
    `audit.audit_daily_manifests.retention_mode` sólo acepta `governance`: [0001_esquema_base.sql:200](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:200). Ninguna tarea migra esa restricción; agregar únicamente `informes.entregas` no corrige el contrato persistente.

12. **Tarea 8 no prueba SigV4.**  
    El test sólo busca el prefijo de `Authorization` y un hash hexadecimal ([plan:1159](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1159)). Pasarían una canonical URI, canonical query, `SignedHeaders`, scope, región o firma incorrectos. `GET ?retention` queda subespecificado: falta probar `retention=`, encoding por segmentos, credencial lectora y `versionId` de la versión concreta. Tampoco valida que la respuesta diga `Mode=COMPLIANCE` ni que la retención alcance la esperada.

13. **Tarea 16 intenta probar retención en un bucket sin Object Lock.**  
    El paso 1 crea el bucket de pruebas sin Object Lock ([plan:1926](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1926)), pero el paso 6 pretende subir allí con retención y leerla ([plan:1936](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1936)). B2/S3 rechazará headers de Object Lock en ese bucket.

14. **Tarea 12 no especifica ni prueba realmente SimpleWebAuthn 14.0.2.**  
    El único test de ceremonia es un cuerpo vacío con comentarios ([plan:1680](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1680)); no existe autenticador virtual ni helper equivalente en `plataforma/test`. Tampoco fija las llamadas y estructuras reales de 14.0.2, `expectedOrigin`, `expectedRPID`, `requireUserVerification`, conversión de `credential_id/public_key`, contador/backup flags o autorización de registro. `pedir()` también queda sin implementar en el snippet.

15. **El test de doble llave puede pasar dejando rutas sin guarda.**  
    Recorre `RUTAS_PASSKEYS`, lista mantenida por la misma implementación ([plan:1670](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1670)). Una ruta Fastify registrada pero omitida de esa constante no se prueba. Debe inspeccionar las rutas reales o registrar todo el prefijo detrás de un único plugin comprobable.

16. **Tarea 11 no conecta el vigilante con la autenticación HMAC que exige.**  
    `revisarInformeDelDia` sólo recibe `{url, fetch, ahora}` ([plan:1505](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1505)), pero la ruta nueva debe llevar “la misma firma HMAC” ([plan:1602](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1602)). No se agrega keyring/orígenes/configuración ni generación de headers en el legado, ni registro de la opción en `OpcionesApi`. La API interna existente no es reutilizable sin más: está acoplada al POST y cuerpo crudo en [senales.ts:50](/opt/fusionbikes/herramientas/plataforma/src/api/senales.ts:50).

17. **Los “incidentes críticos” no tienen destino implementable.**  
    Tarea 10 exige abrirlos ([plan:1470](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1470)), pero plataforma sólo expone una vista de incidentes derivados de inbox/outbox: [0001_esquema_base.sql:352](/opt/fusionbikes/herramientas/plataforma/migrations/0001_esquema_base.sql:352). No hay tabla o API para incidentes de informes ni tarea que la produzca.

18. **Tarea 14 convierte el gate en evidencia nominal.**  
    El gate sólo busca IDs en títulos y el plan manda renombrar tests ([plan:1861](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1861)). Un único `it` parcial por ID puede poner el tramo verde sin demostrar todos los subcasos enumerados.

## Medios

19. **JCS acepta Unicode inválido.**  
    `texto()` itera y concatena surrogates UTF-16 no apareados ([plan:158](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:158)); al convertir a UTF-8 Node los sustituye por U+FFFD. RFC 8785 exige fallar. Faltan vectores oficiales y tests de lone surrogate en claves y valores.

20. **Los tests del manifiesto no demuestran sus nombres y dependen del reloj.**  
    “Fija los extremos” nunca afirma `primer_chain_seq` ni `ultimo_chain_seq` ([plan:870](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:870)). Usa `clock_timestamp()` y calcula “hoy ART” después, por lo que puede cruzar medianoche. La aserción de retención tampoco mide desde el PUT.

21. **Tareas 5, 7 y 13 tienen estado/reloj compartido.**  
    Tarea 5 sólo borra leases, no filas ([plan:683](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:683)); tarea 7 acumula señales entre casos ([plan:1029](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1029)); tarea 13 deja cinco fallos del usuario para el caso siguiente y usa `Date.now()` únicamente en el sexto intento ([plan:1788](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1788)). Son dependientes del orden y no prueban por separado límites por cuenta, IP y global.

22. **Tarea 9 no prueba SMTP y propone reimplementarlo a mano.**  
    El fake sólo comprueba que se pasó un objeto a una interfaz ([plan:1298](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:1298)). No cubre EHLO multiline, STARTTLS/TLS, AUTH, respuestas 4xx/5xx, CRLF/dot-stuffing, MIME/base64 ni header injection. El legado ya usa `nodemailer`: [mailer.js:1](/opt/fusionbikes/herramientas/lib/mailer.js:1). El cliente SMTP manual sobra.

23. **Tarea 4 no prueba todos los permisos que afirma.**  
    El caso “puede leer y escribir” sólo ejecuta `UPDATE` y un `DELETE` denegado ([plan:583](/opt/fusionbikes/herramientas/docs/superpowers/plans/2026-09-17-e1-tramo4-seguridad-reporte.md:583)); el `INSERT` depende de otro test y nunca prueba `SELECT` aisladamente.

## Sobra

- **Tareas 12 y 13 completas:** login, reautenticación y recuperación reales detrás de un interruptor que debe permanecer apagado, sin sesión real, dominio, UI ni usuarios productivos. Es alcance de E4 y obliga a inventar contratos ahora.
- **El cliente SMTP artesanal de la tarea 9**, existiendo una biblioteca madura ya usada por el repo.
- **`retention_until` dentro del manifiesto previo a la subida**: mezcla evidencia del día con un resultado operativo que todavía no existe y causa la contradicción temporal señalada arriba.
