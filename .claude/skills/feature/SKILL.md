---
name: feature
description: Inicio forzado del pipeline del equipo de subagentes de FusionBikes (planear con brainstorming/writing-plans → disenador-ux/ui → hard-worker-backend/frontend → revisor → tester → probador-e2e → auditor-despliegue). Úsalo cuando quieras arrancar explícitamente el desarrollo de una función, fix o cambio con todo el equipo.
argument-hint: "qué función o cambio querés construir"
---

# /feature — arrancar el equipo

Dispara explícitamente el pipeline de desarrollo con el equipo de subagentes
(`.claude/agents/`). Sos el orquestador; los subagentes no se llaman entre sí, los encadenás vos.

## Antes de arrancar: calibrá el tamaño

Aplican las reglas de calibración y de traspaso de contexto de `CLAUDE.md` (sección "Equipo
de subagentes"): en **cambios chicos** salteás el documento de plan y los diseñadores, pero
nunca las preguntas al usuario ni `revisor`/`tester`/`auditor-despliegue`. Y en cada
despacho pasale al subagente las rutas de archivo ya ubicadas y el output del agente
anterior, para que no re-explore el repo desde cero.

## Memoria de contexto

Antes de despachar, leé `agents/model-routing.md` y `agents/skill-routing.md`. La primera
tabla define el modelo y esfuerzo de cada rol; la segunda selecciona el paquete de skills de
UX/UI según el riesgo. No cargues todas las skills de diseño por defecto.

Antes de planear, leé `docs/memory/INDEX.md`, `docs/memory/active.md` y únicamente los
módulos que el índice asocie al alcance. No leas toda `docs/memory/` ni planes históricos.

Después de implementar y antes de la revisión final:

- actualizá solo los módulos afectados con hechos verificados por el diff o por evidencia;
- mantené `active.md` breve, reemplazando estado obsoleto en vez de acumular una bitácora;
- cambiá `INDEX.md` solo si aparece, se renombra o se retira un tema;
- no guardes transcripciones, razonamientos, logs, secretos, credenciales ni hipótesis;
- incluí la actualización de memoria dentro del diff que reciben `revisor` y `tester`.
- si una corrección cambia los hechos documentados, actualizá otra vez la memoria antes de
  volver a despachar al `revisor`.

## Pipeline

1. **Planear de verdad.** Invocá `superpowers:brainstorming` → `superpowers:writing-plans`
   para producir un plan escrito (`docs/superpowers/plans/`), no una charla. **No asumas
   nada, ni lo obvio**: confirmá con el usuario quién ejecuta cada paso (manual o
   automático), qué dispara el flujo, casos de error/borde, y origen de cada dato. En
   cambios chicos, resolvé eso en la conversación y salteá el documento escrito.
2. **Diseñar, si toca UX/UI y el cambio es normal/grande.** Despachá `disenador-ux` (flujo,
   con contexto de uso real) y/o `disenador-ui` (sistema visual) antes de que se escriba
   código — solo el que haga falta, no los dos por costumbre.
3. **Desarrollar.** Despachá `hard-worker-backend` y/o `hard-worker-frontend` (según qué
   toque el plan) con el plan concreto.
4. **Actualizar memoria.** Aplicá las reglas anteriores solo sobre los módulos afectados.
5. **Revisar.** Despachá `revisor` sobre el diff resultante, incluida la memoria. Devuelve
   hallazgos priorizados y **no** escribe código.
6. **Corregir (loop).** Si el revisor encontró algo, devolvé al agente de desarrollo
   correspondiente a corregir, sincronizá otra vez los módulos afectados y volvé a revisar.
   Repetí hasta que el revisor dé OK.
7. **Testear.** Despachá `tester` para asegurar que `npm test` (vitest) quede verde, el
   cambio esté cubierto, y (si tocó frontend) axe-core no reporte violations graves.
8. **Probar en navegador, si toca UI.** Despachá `probador-e2e` sobre la(s) página(s)
   tocadas.
9. **Auditar.** Despachá `auditor-despliegue` como gate final: auditoría de código +
   seguridad + todos los tests verdes + UI responsive + conformidad de sistema visual +
   migración pendiente + presupuesto de peso frontend. Devuelve 🟢/🔴. **No abre el
   navegador ni re-revisa el código**: pegale el veredicto final del `revisor` (paso 5) y
   el reporte de `probador-e2e` (paso 8) en el prompt de despacho. Sin esos insumos, 🔴.
10. **Reportar** al usuario en español el resultado y el veredicto del auditor. El deploy a
   producción lo hace el usuario **a mano**.

Usá `explorador` como apoyo cuando necesites ubicar o entender código.

Nunca marques el trabajo como completo si el auditor dio 🔴 o si algún test falla.
