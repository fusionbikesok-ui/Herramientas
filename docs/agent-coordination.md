# Continuidad y coordinación entre agentes

Este protocolo permite que varios agentes trabajen en paralelo sin compartir archivos ni
dar por vigente una revisión hecha sobre un diff anterior. `AGENTS.md`, `CLAUDE.md` y el
pipeline `feature` siguen siendo normativos; este documento define la coordinación diaria.

## Una tarea, una rama, un worktree

- Cada entrega o fix tiene una rama y un worktree propios. No se implementa desde el checkout
  principal ni desde el worktree de otra entrega.
- El coordinador registra para cada tarea: objetivo, rama, worktree, commit base, archivos
  permitidos, estado y siguiente acción.
- Un archivo tiene un solo agente escritor a la vez. Backend (`routes/`, `lib/`, migraciones),
  frontend (`public/`) y tests pueden separarse solo si sus rutas no se superponen.
- Los revisores, testers E2E y auditores trabajan en modo solo lectura, salvo que el rol de
  Tester agregue exclusivamente tests.

## La suite completa flakea por contención, no por el diff (confirmado repetidas veces)

Corriendo `npm test` (vitest, ~1560 tests, ~11-12 min) con la suite entera en paralelo
(73 archivos), aparecen 1-3 fallas que rotan entre corridas idénticas del MISMO diff —
nunca las mismas dos veces seguidas — y cada archivo pasa 100% verde corriendo solo
(`npx vitest run test/<archivo>.test.js`). Confirmado en la sesión del 2026-08-27 sobre el
mismo diff, en 4 corridas completas distintas: `test/matcherPush.test.js`,
`test/reactivar-automatico.test.js` y `test/preparacion.test.js` aparecieron y desaparecieron
sin que nadie tocara esos archivos ni su lógica.

**Actualizado 2026-08-28**: `test/auditoria.test.js` YA NO es una falla conocida — se corrigió
(commit `be2baf9`, `reservarCupo` recibía un string en vez de un array). Si vuelve a fallar,
tratalo como regresión real, no lo descartes por este párrafo. Las fallas reales confirmadas
hoy (reproducidas también en aislado y sobre `conteo-confiable` limpio, auditoría del Hito 6
de confiabilidad) son `test/recepciones.test.js` (assert de timing frágil, `duracion < 60ms`)
y `test/sync.test.js` (`atencion/:cat: total es el COUNT real...`) — ver `plan-maestro-v2.md`
para el detalle. No confundir ninguna de las dos con contención.

**Antes de investigar una falla nueva en la suite completa como regresión real**: corré ese
archivo solo. Si pasa aislado, es contención — anotalo en el reporte como tal (con el nombre
del archivo y que pasó 100% solo) y seguí; no persigas el fantasma de nuevo cada vez que
cambia cuál archivo rota. Si vuelve a fallar aislado, ahí sí es del diff.

## Coordinación Codex ↔ Claude

- El coordinador mantiene el registro activo y asigna a cada agente una tarea con rutas
  exclusivas. Si Claude toma una ruta, Codex no la edita hasta recibir su handoff.
- Cada handoff de Claude/Codex debe indicar rama, worktree, commit base, archivos tocados,
  pruebas frescas y si dejó procesos activos. Un mensaje de chat no reemplaza ese registro.
- Para trabajo paralelo se usa un worktree por agente. No se comparten cambios sin commit ni
  se trabaja sobre el checkout principal.
- La integración se hace por commits seleccionados sobre la rama coordinadora; después de cada
  integración se repiten `git diff --check` y los gates afectados. Un cambio posterior invalida
  cualquier aprobación anterior.
- Si dos tareas necesitan el mismo archivo, se serializan: primero se termina y congela una,
  luego se entrega la otra con el diff actualizado como base.

## Modelos y skills

- La matriz de modelos está en `agents/model-routing.md`; no se cambia el modelo de un rol en
  un despacho sin registrarlo en el handoff.
- El router de diseño está en `agents/skill-routing.md`. Los diseñadores deben aplicar el
  paquete mínimo correspondiente, sumar extensiones por riesgo y reportar lo que usaron.
- Las skills de plugins de Claude permanecen instaladas fuera del repositorio. Si Codex no
  tiene una capacidad equivalente, conserva el criterio verificable y lo marca como no
  ejecutado; no inventa resultados de una skill ausente.

## Estados y gates

Una tarea avanza solamente en este orden:

1. `DIAGNOSTICO` o `DISENO`
2. `IMPLEMENTANDO`
3. `CONGELADO_PARA_REVISION`
4. `REVISION_APROBADA`
5. `TESTER_APROBADO`
6. `E2E_APROBADO` si toca UI
7. `AUDITORIA_APROBADA`
8. `PUBLICABLE_LOCAL`
9. `INTEGRADO_LOCAL`

`PUBLICADO` y `DESPLEGADO` son estados manuales y nunca se infieren de un commit o merge.

### Bloqueos y reanudación

- `BLOQUEADO` siempre lleva un código: `FALTA_ENTORNO`, `FALTA_DATOS`, `FALTA_DECISION`,
  `PERMISO` o `FALLO_REPRODUCIBLE`.
- Un agente bloqueado no elige una rama alternativa ni cambia el alcance. Escribe el handoff
  con la decisión exacta que necesita y queda detenido.
- El orquestador resuelve el bloqueo, actualiza el paquete de tarea y vuelve a despachar al
  mismo agente. No se salta el gate ni convierte un bloqueo en aprobado.

## Contrato obligatorio para E2E

La preparación del entorno es responsabilidad exclusiva del orquestador; el probador E2E no
debe adivinar URLs, puertos, ramas ni bases.

Antes de despachar E2E, Codex debe entregar estos campos completos:

```text
Entorno: local-aislado | staging
URL exacta:
Rama/worktree servido:
HEAD/base:
DB temporal:
DISABLE_CRONS=true:
Puerto:
Sesión Playwright:
Directorio de artefactos:
PID/sesión del servidor:
Acciones autorizadas: solo lectura / datos de prueba / otras
```

Para `local-aislado`, Codex crea una copia temporal de la base, elimina `ml_oauth_token`,
arranca el servidor con `DISABLE_CRONS=true` y verifica la URL con una petición HTTP antes de
despachar. La instancia nunca usa `data/fusion.sqlite` ni el checkout principal.

El probador E2E solo verifica navegador, consola, red, responsive y flujo. Si la URL no
responde o sirve otra rama, devuelve `BLOQUEADO (FALTA_ENTORNO)` con la evidencia y no intenta
staging, nginx ni otro puerto por cuenta propia.

Al terminar, el probador entrega el reporte en `/tmp/claude-to-codex-handoff.md`. El
orquestador cierra el servidor temporal y recién entonces avanza al gate siguiente.

## Controlador automático

Para que el usuario no copie contexto entre sesiones, Codex invoca Claude con:

```bash
npm run agent:claude -- \
  --role probador-e2e \
  --task-file /tmp/codex-to-claude-task.md \
  --handoff-file /tmp/claude-to-codex-handoff.json
```

`scripts/orchestrate-claude.mjs` valida el rol, el worktree, el entorno E2E y el modelo antes
de llamar a `claude -p`. Le pasa el task file, conserva la política de permisos seleccionada
y rechaza cualquier respuesta que no tenga el esquema mínimo de handoff. Codex lee luego el
archivo estructurado y decide el gate siguiente.

Para E2E, el lanzador prepara todo el entorno de forma reproducible y aislada:

```bash
npm run agent:e2e -- \
  --task-file /tmp/codex-to-claude-task.md \
  --handoff-file /tmp/claude-to-codex-handoff.json \
  --port 3199 --playwright-session entrega2e2e
```

`agent:e2e` copia la base, elimina únicamente `ml_oauth_token`, arranca el worktree indicado
con `DISABLE_CRONS=true`, espera la URL exacta, agrega PID/HEAD/base/DB/sesión al task y
limpia servidor, SQLite y logs temporales al terminar. Usa `acceptEdits` para que el agente
pueda usar navegador/Bash sin prompts interactivos; la tarea y el rol prohíben editar. El
smoke local validó handoff y limpieza; requiere autorización de binding local en entornos que
bloqueen sockets.

El modo predeterminado es `dontAsk`: una tarea que necesite otra autorización queda bloqueada
con evidencia, no espera indefinidamente ni salta controles. Para una implementación, el
orquestador debe elegir explícitamente `--permission-mode acceptEdits` y mantener el worktree
aislado.

## Congelar un diff antes de revisarlo

- El implementador termina, corre pruebas dirigidas y deja un commit local o informa el
  commit base más la lista exacta de cambios sin commit.
- El coordinador declara el diff congelado. Desde ese momento nadie edita ese worktree hasta
  que Standards y Spec terminen.
- Toda corrección invalida el veredicto anterior. Se vuelve a congelar y el revisor confirma
  el diff final. Un E2E o una auditoría tampoco valen si hubo cambios posteriores.
- Antes de cada gate se registran `git status --short`, `git diff --check`, HEAD y base. Para
  WIP sin commit se agrega una huella reproducible del diff.

## Entrega de contexto

El agente que termina no vuelca la conversación. Entrega un handoff breve que referencia los
artefactos existentes e incluye:

- objetivo y alcance fuera de alcance;
- rama, worktree, HEAD/base y estado Git;
- decisiones ya tomadas que no deben volver a preguntarse;
- archivos tocados y contratos cambiados;
- pruebas ejecutadas con conteos reales;
- último veredicto y hallazgos abiertos;
- procesos temporales levantados y confirmación de que fueron detenidos;
- siguiente acción exacta, con comando o archivo inicial;
- skills sugeridas para continuar.

El handoff transitorio se guarda en `/tmp`; las decisiones durables van al módulo de
`docs/memory/` correspondiente. Nunca se guardan secretos, credenciales, cookies, tokens,
transcripciones ni logs extensos.

## Evitar colisiones de pruebas y servidores

- Solo el coordinador autoriza la suite completa. Antes comprueba que no haya otro Vitest y
  que no existan SQLite temporales abandonados.
- Las pruebas dirigidas se serializan cuando comparten nombres `test/tmp-*.sqlite*`.
- E2E usa una copia de base, token ML eliminado, `DISABLE_CRONS=true` y un puerto no
  productivo. El agente informa PID/sesión y el coordinador confirma su cierre.
- Nunca se inicia una segunda instancia contra `data/fusion.sqlite` ni se mata un proceso que
  pertenezca a otro agente.

## Integración

- Antes de integrar se compara la rama con el `master` local actual, no solo con
  `origin/master`. Una rama atrasada se actualiza y repite los gates afectados.
- El coordinador resuelve conflictos; los agentes de una entrega no mezclan por su cuenta
  commits de otra.
- Artefactos (`output/`, `.playwright-cli/`, enlaces `node_modules`, SQLite temporales) nunca
  entran al commit de producto.
- No hay push, deploy, reinicio de pm2 ni migración productiva sin autorización explícita.

## Plantilla mínima del registro activo

```text
Tarea:
Estado:
Código de bloqueo (si aplica):
Rama / worktree:
Base / HEAD:
Dueño escritor y rutas:
Entorno E2E (URL/puerto/PID, si aplica):
Decisiones vigentes:
Pruebas frescas:
Último gate:
Bloqueos:
Siguiente acción exacta:
```
