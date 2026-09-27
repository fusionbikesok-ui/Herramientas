# Noche 2026-09-27: supuestos, conclusiones y preguntas para José

José se fue a dormir alrededor de las 02:30 UTC con esta indicación: "seguí hasta que vuelva, sin parar con E3".

Reglas que sigo durante la noche:
- Sin despliegues y sin escrituras en producción.
- Todo lo que asumo queda anotado acá para que lo confirmes.

## Listo para desplegar (espera tu OK y tus comandos con `!`)

- **`fix/bandeja-atributos-variante`, `6f310673`**
  - Aprobaciones: Codex sol, revisor sin bloqueantes, auditor en verde y Playwright OK.
  - Tests: 103/103.
  - No trae migración.
  - Los comandos están en el chat (bloques 1 a 4, más el rollback).

## En curso

- **`fix/ml-atributos-sin-modelo`**: migraciones 0028/0029 más el backfill. Va por la ronda 3 de arreglos: el checksum de la 0028 y la reparación de estados heredados.
- **E3 corte 3**: segunda opinión de Codex sol sobre el diff completo del corte (tarea 8, paso 3).
- **Snapshot anonimizado**: clasificar las 2 columnas nuevas.
- **Deuda menor de la bandeja** y actualización del plan maestro.

## Supuestos que tomé (confirmá o corregí)

1. **La 0028 nunca se aplicó en un entorno persistente**, así que editarla es seguro. Producción está en la 0027. La otra sesión lo verifica en QA y en los contenedores de test.
2. **La bandeja compara solo esta lista cerrada de atributos**:
   - marca
   - modelo
   - color
   - talle / tamaño del cuadro
   - rodado
   - material / material del cuadro
   - tipo de producto / tipo de bicicleta
   - género
   - edad
   - cantidad de velocidades

   Quedan fuera paquete, IVA, ids, guía de talles y similares. **¿Falta alguno que uses para decidir?**
3. **Si falla la clasificación al vincular, el vínculo se mantiene** (fail-open) y queda registrado el evento `catalogo.clasificacion_fallida`. La alternativa sería rechazar la decisión completa.
4. **El rollback de la API usa las imágenes `antes-bandeja` y `antes-atributos`**, porque la imagen original de la API ya no existía en Docker.
5. **Los representantes que estaban vinculados y después se omitieron conservan hoy los atributos del modelo viejo en producción.** Lo deduzco del código; falta contarlos con una consulta de solo lectura. El nuevo modo `--reparar-extras` del backfill los corrige.

6. **Cupo de Codex sol (vos preguntaste a las ~02:40):** para no agotarlo, sol se usa solo en entregas de riesgo alto: esquema y migraciones, scripts que escriben en producción, lógica de vínculos y E3. En diffs chicos va con effort medium. Lo de riesgo bajo (snapshot, deuda de UI, tests, docs) pasa solo por el revisor y lleva una única revisión sol en lote al final. Si el cupo se agota, lo no revisado queda como "pendiente de revisión" y no se ofrece para deploy. No reemplazo sol por Claude.

## Preguntas abiertas

### Migración 0028: decisión tomada por mí (03:30 UTC)

Codex sol pide no editar una migración que pueda estar aplicada. La edité igual, porque verifiqué en modo solo lectura que **ninguna base la tiene aplicada**:
- producción está en la 0027;
- los contenedores `plataforma-test-*` llegan como máximo a la 0024.

La evidencia está en el mensaje del commit `6a50e285`.

**Pregunta 3:** ¿aceptás este criterio, o preferís la regla estricta de "nunca editar una migración ya escrita" (en ese caso, 0028 original + 0029 + 0030)?

### Cupo de Codex (03:50 UTC)

A las 03:50 la ventana de 5 horas llegó al 87 %. Frené todo uso de Codex hasta las 06:46 UTC, cuando se renueva.

La última corrección de la 0028 (reclasificar el modelo C cuando se mueve una `categoria_canal` desalineada) es de una línea más su test. La hace la otra sesión a mano, sin Codex, y la reviso con sol después de las 06:46.

### E3 corte 3: segunda opinión de Codex sol (03:00 UTC)

**Veredicto: todavía no se puede encender el canario.** Codex encontró 10 defectos. La otra sesión los arregla esta noche en `fix/e3c3-segunda-opinion`.

Los altos:
- Con variaciones, el paso de verified a intervention no funciona.
- D6 no cuenta como error de canario cuando corregís el vínculo con "omitir" o "sin candidato".
- El replay evalúa 30 casos y no los 299.
- Una corrida abortada puede seguir vinculando.
- El lease vence durante un Retry-After.
- Se usa la misma cuenta ML para todos los casos.

**Pregunta 1:** con los flags E3 apagados, producción igual registra observaciones de formato en `catalog.format_observations`. Es una tabla interna: no pausa nada ni toca ML. Supongo que **está bien mantenerlo** como línea base en sombra para cuando se encienda el canario. ¿Lo confirmás, o lo apagamos detrás de un flag?

**Pregunta 2:** la migración 0027, ya aplicada en producción, no tiene `lock_timeout`. No se puede editar porque cambiaría el checksum. Supongo que **alcanza con exigir `lock_timeout` a las migraciones nuevas**, con un test que lo verifique. ¿OK?

**Pregunta 4:** el replay contractual necesita la muestra canónica de **299 casos congelados**. En el repo hay solo `muestra-30.json`. ¿Dónde está el artefacto de 299, o lo generamos? Mientras tanto, el CLI falla cerrado: nunca da "apto" sin la muestra completa y con hash verificado.

**Pendientes tuyos para encender el canario (fuera del código):**
- validar `ATRIBUTOS_PACK` contra payloads reales;
- declarar `E3_CANARIO` y `E3_AUTO_SKU` en api y worker, y `E3_INTERVENTION` en worker, dentro de `compose.yml`;
- correr el replay de 7 días con la muestra de 299.
