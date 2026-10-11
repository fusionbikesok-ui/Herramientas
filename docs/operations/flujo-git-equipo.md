# Flujo git del equipo

Vigente desde 2026-10-06. Decisiones de José en esa fecha:

- La rama principal es `master`.
- Los PR se mezclan sin aprobación humana, con los gates de agentes en verde.
- Cualquiera puede desplegar, pero siempre con el OK de José.

## Por qué existe

En el VPS ya no trabajan solo José y sus agentes de Claude. Codex Astra lleva la migración de POS, Gestión VPS y
Facturador. Hasta ahora todos usaban la identidad `root`, editaban el checkout de producción sin commitear y había
trabajo fuera de git (`/opt/fusion-management-migration`).

El 2026-10-05 eso trabó un despliegue y borró de producción una tarjeta del inicio que nadie había commiteado.

## Reglas

1. **El checkout de producción no se edita.** `/opt/fusionbikes/herramientas` solo recibe despliegues.
   - Antes de desplegar se corre `git status`. Si hay cambios sin commitear, el despliegue se frena y se le pregunta
     a José.
   - Nadie guarda aparte ni descarta trabajo ajeno por su cuenta.
2. **Cada persona o agente trabaja en su propio worktree y su propia rama.**
   - Los worktrees van en `/opt/fusionbikes/worktrees/<tema>`.
   - Las ramas se nombran `feat/…`, `fix/…` o `docs/…`.
   - La rama se sube a GitHub el mismo día.
3. **Identidad propia en cada commit.** Cada worktree configura `git config user.name` y `user.email` de quien
   trabaja, por ejemplo "Codex Astra" o "Claude (sesión X)". Se acaban los commits como `root`.
4. **GitHub es la fuente de verdad.**
   - `master` es la rama protegida: sin push directo y sin force-push. Se integra por PR.
   - El PR se mezcla con los gates en verde: revisor, tests dirigidos y suite completa, más probador-e2e si toca
     `public/`.
5. **Despliegue.** Se despliega solo un commit de `master` que ya esté en GitHub.
   - Se etiqueta `prod-AAAA-MM-DD[-n]` y se sube la etiqueta.
   - Volver atrás es pasar a la etiqueta anterior.
   - Antes va el backup, con `better-sqlite3`, porque el VPS no tiene el binario `sqlite3`. Si el backup no existe,
     el despliegue no sigue.
   - Cada despliegue lleva el OK de José.
6. **Todo el código va en git.** Lo que vive fuera del repo, como `/opt/fusion-management-migration`, entra al repo
   como módulo (`integrations/…`) o como repositorio propio.
   - Secretos y `.env` quedan fuera, en `.gitignore`.
7. **Trabajo modular.** Cada área tiene un responsable de referencia (tabla de abajo; sin `CODEOWNERS` por decisión de José del 2026-10-06).
   - Se tocan solo las rutas del área propia.
   - Si hace falta cambiar algo de otra área, se avisa a su dueño y se hace en un commit separado.
8. **Archivos compartidos con cuidado.** `server.js`, `db/`, `migrations/`, `public/lib/`, `public/home/`,
   `docs/memory/active.md` y `docs/superpowers/INDEX.md` se cambian en commits chicos y aislados.
   - Las migraciones toman el siguiente número libre de `master` al momento del PR. Si dos chocan, renumera el
     último en mezclar.
9. **Recursos compartidos de prueba.**
   - Antes de levantar QA o correr `npm test` completo se corre `pgrep -af "vitest|node.*server"`, que incluye los
     procesos de otras personas.
   - La suite completa no se corre en paralelo con otra corrida.
10. **Memoria.** Cada uno actualiza solo el módulo de `docs/memory/modules/` de su área. `active.md` recibe una línea
    corta por entrega.

## Áreas y responsables (guía informal)

| Área | Rutas | Responsable |
|---|---|---|
| ML / Sincronización / Identidad | `routes/sync.js`, `lib/ml*`, `lib/vigia*`, `lib/identidad*`, `public/sync-ml/`, `public/matcher/`, `public/guardia-ml/`, `public/identidad-productos/`, `public/bandeja-identidad/` | José + Claude |
| Depósito | `public/preparacion/`, `public/recepcion/`, `public/inventario/`, `public/gestion-pedidos/` y sus rutas | José + Claude |
| Plataforma (Postgres) | `plataforma/` | José + Claude |
| Migración WordPress / Gestión VPS / POS / Chat | `integrations/`, `gestion-vps` | Codex Astra |
| App móvil | `openapi/`, `mobile/` | por definir |
| Núcleo compartido | `server.js`, `db/`, `migrations/`, `public/lib/`, `public/home/`, `CLAUDE.md` | José |

## Transición (pendiente, coordinar con José y Astra)

1. ~~Subir `conteo-confiable` a GitHub.~~ Hecho.
2. ~~Llevar `master` a lo que corre producción.~~ Hecho el 2026-10-06 (PR #1, merge `1891af6e`; la nota obsoleta de `master` del 26/08 se integró con `-s ours`). Falta:
   - archivar `conteo-confiable`;
   - cambiar el checkout de producción a `master`. **En pausa desde el 2026-10-07** (decisión de José): Astra sigue
     editando Mensajería directo en producción. `master` tiene Mensajería al 07/10 (PRs #5 y #6); el PR #7 (canal Web)
     quedó en borrador. Cuando Astra termine, se rehace el PR desde producción y recién después se pasa el checkout,
     repitiendo antes `git status` y el diff contra el `master` de ese momento.
3. Proteger `master` en GitHub.
4. Darle a Astra un usuario SSH propio con clave, en lugar de `root` con contraseña. También:
   - crear su worktree;
   - versionar `/opt/fusion-management-migration`;
   - decidir qué pasa con la rama `wip/checkout-prod-2026-10-05`, que tiene `openapi/mobile-v1.yaml`.
