# Proyecto FusionBikes — herramientas

App Node/Express (ESM, better-sqlite3, vitest) en VPS **staging**; a producción se pasa **a
mano**. Git local sin remoto. Integración MercadoLibre ↔ WooCommerce. Responder en español.

## Equipo de subagentes — flujo de trabajo

Hay un equipo de subagentes en `.claude/agents/`. **La sesión principal es el orquestador**:
planea con el usuario, despacha a los subagentes y los encadena (los subagentes no se llaman
entre sí).

**Disparador automático:** cuando el usuario pide **crear o cambiar una función/feature/fix
de código**, seguí este pipeline sin esperar un comando:

1. **Planear** con el usuario qué se va a construir (grilling ligero si hace falta).
2. Despachar **`hard-worker`** con el plan → hace el desarrollo.
3. Despachar **`revisor`** sobre el diff → hallazgos priorizados (no escribe código).
4. Si hay hallazgos, volver al **`hard-worker`** a corregir; repetir hasta que el revisor dé OK.
5. Despachar **`tester`** → asegura vitest verde y cobertura del cambio.
6. Despachar **`auditor-despliegue`** → gate obligatorio (auditoría + tests verdes + UI
   responsive sin nada oculto). Devuelve 🟢/🔴.
7. Reportar al usuario. **El deploy a prod lo hace el usuario a mano.**

Usá **`explorador`** como apoyo cuando necesites ubicar o entender código sin ensuciar tu
contexto.

**Inicio forzado:** el comando `/feature` dispara este mismo pipeline explícitamente.

**Regla de despliegue OBLIGATORIA** (la aplica el auditor, pero vale siempre): antes de
desplegar o dar por completo un cambio → auditoría de código + todos los tests verdes
(`npm test`) + UI responsive sin nada oculto.
