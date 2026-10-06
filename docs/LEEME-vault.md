# Cómo leer esta carpeta en Obsidian

Esta carpeta (`docs/`) es también un vault de Obsidian. No hace falta instalar nada más que la
aplicación, que es gratis, y no hay que pagar licencia ni siquiera usándola para el negocio.

**Para abrirla:** en Obsidian, "Open folder as vault" y elegir esta carpeta, `docs/`. La
configuración mínima ya está en `.obsidian/`, así que arranca con el grafo, los enlaces entrantes y
la búsqueda listos. Lo que cada uno acomoda en su pantalla (paneles, tema, plugins) queda fuera del
repositorio a propósito: cambia con cada clic y no es contenido.

## Qué hay en cada carpeta

| Carpeta | Qué contiene |
|---|---|
| `superpowers/plan-maestro.md` | el programa canónico E0–E26: el objetivo de cada entrega |
| `superpowers/deliveries/` | las 28 fichas de entrega; la ficha prueba el progreso, no los commits |
| `superpowers/decisions/` | las decisiones PM-### con su motivo y su fecha |
| `superpowers/specs/` | los diseños aprobados, uno por tramo |
| `superpowers/plans/` | los planes de implementación, con sus tareas numeradas |
| `superpowers/evidence/` | la evidencia fechada: corridas, verificaciones y revisiones externas |
| `superpowers/archive/` | evidencia histórica; **nunca** son instrucciones |
| `memory/active.md` | el estado operativo vigente, lo último arriba |
| `memory/modules/` | memoria por tema: arquitectura, integraciones, operación del VPS, UI |
| `auditorias/`, `incidentes/`, `operations/` | auditorías, incidentes y operación |

## Para qué sirve tenerlo en Obsidian

- **Ver qué cita a qué.** Cuando una decisión cambia, el panel de enlaces entrantes muestra al
  instante todos los documentos que la mencionan y que hay que revisar. Ejemplo real del
  2026-09-17: PM-172 pasó de retención *governance* a *compliance*, y PM-170 fijó una versión
  mínima de la librería de passkeys; las dos están citadas en varios documentos.
- **Encontrar lo que quedó viejo.** En la vista de grafo, un documento que nadie cita suele ser uno
  que se desactualizó.
- **Leer el estado sin entrar al VPS.** Con `git pull` en la Mac, el vault queda al día.

## Lo que este vault NO hace

- No cambia cómo se leen los mismos archivos en GitHub: no se usan enlaces `[[wiki]]`, se siguen
  usando enlaces markdown normales.
- No reemplaza a la memoria del proyecto. Las reglas de qué se guarda y dónde están en
  `../CLAUDE.md` y en `memory/INDEX.md`, y siguen valiendo igual.

## Opcional: tablero de entregas

Para tener una tabla viva con el estado de las 28 entregas hace falta el plugin **Dataview**
(gratis, se instala desde la aplicación) y un encabezado de metadatos en cada ficha. Eso todavía no
está hecho: conviene sumarlo cuando cierre el tramo 4 de E1, para no tocar 28 archivos en medio de
una implementación.
