---
name: feature
description: Inicio forzado del pipeline del equipo de subagentes de FusionBikes (planear → hard-worker → revisor → tester → auditor-despliegue). Úsalo cuando quieras arrancar explícitamente el desarrollo de una función, fix o cambio con todo el equipo.
argument-hint: "qué función o cambio querés construir"
---

# /feature — arrancar el equipo

Dispara explícitamente el pipeline de desarrollo con el equipo de subagentes
(`.claude/agents/`). Sos el orquestador; los subagentes no se llaman entre sí, los encadenás vos.

## Pipeline

1. **Planear.** Entendé con el usuario qué se va a construir. Si el pedido es difuso, hacé
   un grilling ligero (una pregunta a la vez). Si ya está claro por el argumento, seguí.
2. **Desarrollar.** Despachá `hard-worker` con el plan concreto.
3. **Revisar.** Despachá `revisor` sobre el diff resultante. Devuelve hallazgos priorizados
   y **no** escribe código.
4. **Corregir (loop).** Si el revisor encontró algo, devolvé al `hard-worker` a corregir y
   volvé a revisar. Repetí hasta que el revisor dé OK.
5. **Testear.** Despachá `tester` para asegurar que `npm test` (vitest) quede verde y el
   cambio esté cubierto.
6. **Auditar.** Despachá `auditor-despliegue` como gate final: auditoría de código + todos
   los tests verdes + UI responsive sin nada oculto. Devuelve 🟢/🔴.
7. **Reportar** al usuario en español el resultado y el veredicto del auditor. El deploy a
   producción lo hace el usuario **a mano**.

Usá `explorador` como apoyo cuando necesites ubicar o entender código.

Nunca marques el trabajo como completo si el auditor dio 🔴 o si algún test falla.
