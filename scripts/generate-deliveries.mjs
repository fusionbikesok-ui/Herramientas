import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const programPath = path.join(root, 'docs/superpowers/delivery-program.json');
const outDir = path.join(root, 'docs/superpowers/deliveries');
const program = JSON.parse(fs.readFileSync(programPath, 'utf8'));

const one = (value) => `- ${value}`;

for (const d of program.deliveries) {
  const dependencies = d.depends.length ? d.depends.join(', ') : 'ninguna';
  const file = path.join(outDir, `${d.id}-${d.slug}.md`);
  const body = `# ${d.id} — ${d.title}

**Estado:** ${d.state}

**Dependencias:** ${dependencies}

**Responsable operativo:** José

**Responsable técnico:** asistente

**Fuente canónica:** \`docs/superpowers/plan-maestro.md\`

## Resultado y límites

${one(d.result)}
- **Incluye:** ${d.scope}
- **No incluye:** ${d.non_goals}
- **Evidencia histórica absorbida:** ${d.absorbs.join(', ')}. Es evidencia, no aceptación automática.

## Línea base verificada

${one(d.baseline)}
- Fotografía común: \`docs/superpowers/audit-baseline-2026-09-13.md\`. Al iniciar se debe refrescar con los mismos comandos y registrar fecha, commit y origen.
- Toda diferencia entre Git, despliegue y base se registra como hallazgo bloqueante; no se rellena por inferencia.

## Decisiones e invariantes

- PostgreSQL es destino canónico; cambios de negocio son transaccionales, auditados y atribuibles.
- Ningún efecto remoto se considera exitoso hasta releer y verificar el recurso; respuesta incierta bloquea repetición ciega.
- Un solo escritor remoto por vertical; idempotencia, versión esperada, leases y DLQ son obligatorios.
- ${d.risks}

## Diseño, datos e interfaces

- **Modelo:** ${d.data}
- **Interfaces:** ${d.interfaces}
- Los endpoints nuevos viven bajo \`/api/v2\`, usan errores \`{code,message,correlation_id,details?}\`, autorización por capacidad y paginación por cursor.
- Las mutaciones requieren \`Idempotency-Key\`; las actualizaciones concurrentes requieren \`expected_version\` y responden 409 sin efecto parcial.
- Eventos/auditoría son append-only; correcciones agregan un evento compensatorio y nunca reescriben historia.

## Integraciones, migración y recuperación

- **Migración:** ${d.migration}
- ML/Woo se releen desde origen; los cursores tienen solape, deduplicación y cobertura observable. Límites de la API se documentan con fuente oficial y fecha.
- Fallos 403/408/429/5xx usan clasificación estable, backoff con jitter, límite de intentos y DLQ visible.
- El rollback vuelve consumidores o UI a sombra/read-only; no deshace efectos remotos confirmados y usa comandos compensatorios cuando corresponda.

## UI, operación y observabilidad

- Toda UI cubre cargando, vacío, degradado, error recuperable, conflicto y sólo lectura; web cumple 390/768/1440 y WCAG 2.2 AA.
- La App conserva contrato v1 mediante fachada mientras migra por OTA; offline nunca oculta conflictos.
- Métricas mínimas: entradas, procesadas, duplicadas, bloqueadas, reintentos, DLQ, latencia p95/p99, frescura y diferencias de conciliación.
- Cada alerta tiene umbral, canal, responsable, acuse y SOP; ningún \`pending\` queda fuera del scheduler.

## Pruebas y evidencia

- **Comando contractual:** ${d.tests}
- El comando \`npm run test:${d.id.toLowerCase()}\` debe existir antes de pasar a \`desarrollo\`; no puede ser un alias vacío y debe fallar si falta un escenario obligatorio.
- Registrar salida literal, commit, fixture, fecha, duración y omisiones. Tests existentes sólo cuentan si cubren el contrato nuevo.
- Revisión independiente sin críticos/altos, suite global serial, restauración aplicable y E2E/dispositivo/hardware según superficie.

## Rollout, rollback y aceptación

- **Despliegue:** ${d.rollout}
- Todo corte de autoridad dura <15 minutos, comienza con backup/restauración vigentes y se aborta ante discrepancia crítica, doble escritor, cola ciega o disco fuera de umbral.
- **Aceptación técnica y operativa:** ${d.acceptance}
- Código construido pero no usado no cuenta como observado; publicación no equivale a aceptación.

## Continuidad

- **Próxima acción exacta:** ${d.next}
- Esta ficha queda bloqueada si contiene decisiones abiertas, cifras sin consulta reproducible, interfaces supuestas o rollback genérico.
- No registrar secretos, tokens, PII, volcados de producción ni razonamiento privado.
`;
  fs.writeFileSync(file, body);
}

const decisionFile = path.join(root, 'docs/superpowers/decisions/plan-maestro-decisions.md');
const decisionText = fs.readFileSync(decisionFile, 'utf8');
const decisionIds = [...new Set(decisionText.match(/PM-\d{3}/g) || [])].sort();
const ownerFor = (id) => {
  const n = Number(id.slice(3));
  if (n <= 2) return 'E26';
  if (n <= 8) return 'E10';
  if (n === 9) return 'E24';
  if (n <= 12) return 'E5';
  if (n <= 14) return 'E6';
  if (n === 15 || n === 20 || n === 22) return 'E19';
  if (n === 16) return 'E21';
  if (n === 17) return 'E20';
  if (n === 18) return 'E16';
  if (n === 19) return 'E25';
  if (n === 21 || n === 35 || n === 41 || n === 47 || n === 148 || n === 149) return 'E26';
  if (n >= 23 && n <= 28) return 'E10';
  if (n === 150 || n === 151 || n === 164) return 'E2';
  if (n === 153) return 'E4';
  if (n === 159 || n === 160) return 'E26';
  if (n === 161) return 'E6';
  if (n === 162) return 'E19';
  if (n === 163) return 'E16';
  return 'E3';
};
const decisionCrosswalk = {
  schema_version: 1,
  rule: 'Un dueño vigente por decisión; consumidores adicionales se declaran en las fichas.',
  decisions: decisionIds.map((id) => ({ id, owner: ownerFor(id) }))
};
fs.writeFileSync(path.join(root, 'docs/superpowers/decision-crosswalk.json'), `${JSON.stringify(decisionCrosswalk, null, 2)}\n`);
