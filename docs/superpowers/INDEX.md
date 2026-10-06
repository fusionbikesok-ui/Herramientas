# Índice canónico de planificación y operación

**Actualizado:** 2026-09-13

**Programa vigente:** E0–E26

## Fuentes vigentes

- [Plan maestro](plan-maestro.md): única autoridad de alcance, orden, dependencias y gates.
- [Entregas E0–E26](deliveries/README.md): fichas ejecutables y estado vigente.
- [Contrato de una ficha](delivery-contract.md): condiciones para autorizar implementación.
- [Atlas de arquitectura](atlas-arquitectura.md): contexto, DAG, procesos, datos, tecnologías y glosario.
- [Crosswalk histórico](crosswalk-entregas.md): destino de requisitos, planes, líneas y artefactos anteriores.
- [Crosswalk de decisiones](decision-crosswalk.json): dueño único de cada decisión PM.
- [Línea base auditada](audit-baseline-2026-09-13.md): fotografía de Git, despliegue, esquema y volúmenes.
- [Registro de decisiones](decisions/plan-maestro-decisions.md): motivos y decisiones de producto preservadas.
- [SOP operativos](../operations/sops/README.md): procedimientos de operación.
- [Consolidación de herramientas, pausas con sentido y eventos antes que crons (2026-10-03)](specs/2026-10-03-consolidacion-herramientas.md): Fases A y B como correcciones del legado (PM-189); C y D en E3/E4; E en E1/E14.
- [Guía API Mercado Libre](specs/ml-api-guia.md): cómo llamar a ML y qué hacer con cada webhook; toda entrega que toque ML debe cumplirla.

## E1 activa

- [Tramo 1 — diseño](specs/2026-09-15-e1-tramo1-fundacion-design.md) y [plan](plans/2026-09-15-e1-tramo1-fundacion.md): implementado y revisado en aislamiento; no desplegado.
- [Tramo 2 — diseño](specs/2026-09-15-e1-tramo2-barridos-design.md) y [plan](plans/2026-09-15-e1-tramo2-barridos.md): aprobados para implementación exclusivamente efímera; los cinco cortes implementados y verificados con `E1_TRAMO=2 npm run test:e1` el 2026-09-16 (worker real contra el simulador dockerizado, gate de los 26 escenarios del tramo); no desplegado y pendiente de revisión independiente.

## Revisiones abiertas

- [Plan ejecutable: recepción urgente sobre el legado](plans/2026-09-21-recepcion-urgente-legado-implementation.md)
  (2026-09-21). Acota la implementación inmediata a matcher backend, alias por proveedor, alta
  Woo en borrador y UI de excepciones; exige TDD, auditoría read-only de los 22 `sin_match`, E2E
  responsive y suites completas de legado y plataforma. Stock anticipado, E6 y conciliación
  documental canónica permanecen diferidos al plan maestro.

- [Revisión: recepción documental contra el plan maestro](plans/2026-09-21-revision-recepcion-vs-plan-maestro.md)
  (2026-09-21, **con decisiones de José del mismo día**). Revisa
  `plans/2026-09-21-recepcion-documental-stock-anticipado.md` contra el maestro y las 27 fichas.
  - **Autorizado a ejecutar sobre el legado** (bajo PM-160, por pérdida económica): cablear
    `lib/ingresoMatcher.js` en backend, alias por proveedor en SQLite y cerrar el alta con el
    `POST /products` faltante. José acepta que E7 después lo descarte. **Todavía no implementado.**
  - **En suspenso:** si el alta + alias + anticipado reciben número nuevo posterior a E26 o entran
    en una entrega intermedia.
  - **Diferido al plan maestro:** la fórmula de disponibilidad con anticipado. Hasta entonces rige
    `disponible = existencia - reservas - retenciones`.
  - **Pendiente y bloqueante del criterio de salida:** re-derivar de producción el número real de
    casos `sin_match`.
  - Hallazgos que siguen vigentes sin resolver: el alta de productos nuevos no tiene ficha en
    E0–E26; la "Etapa 2" de aquel plan no es E6; la dependencia dura de recepción es E5, no E3/E4;
    y E5/E6/E7/E12 no cumplen `delivery-contract.md` para salir de borrador.

## Archivo

Los planes y fichas anteriores están bajo [`archive/`](archive/) y su integridad se registra en
[el manifiesto de archivo](archive/MANIFEST-2026-09-13.md). Son evidencia; nunca determinan qué
implementar ni el estado de una entrega.

## Precedencia

El código, Git, el despliegue y los datos observados describen el presente. El plan maestro define
el objetivo aprobado; las fichas E definen el contrato ejecutable; las decisiones explican el porqué.
Una discrepancia entre esas fuentes bloquea la ficha afectada hasta documentar su resolución.

## Preparación de migración WordPress (2026-10-04)

- [Especificación](specs/2026-10-04-puente-wordpress-lectura.md) y
  [plan del puente](plans/2026-10-04-puente-wordpress-lectura.md): puente inicial de
  lectura 0.1.0 desplegado y comprobado en WordPress. No cambia E0–E26 ni declara
  terminada la migración de POS, Chat, Taller o Facturador. Master Control queda
  explícitamente fuera de la migración y conserva su lógica/configuración.

### Chat nativo: ensayo QA de migración (2026-10-04)

- `plans/2026-10-04-chat-migracion-qa.md`: vigente para el ensayo privado del chat; integración productiva pendiente. No modifica el estado de aceptación E0–E26.
- Fuente y límites: `integrations/chat-migration-qa/README.md`; operación en `docs/memory/modules/operations-vps.md`.

- `plans/2026-10-04-pos-arca-taller-vps.md`: migración autorizada; copia de consulta desplegada, corte operativo pendiente. No modifica la aceptación del programa E0–E26.
