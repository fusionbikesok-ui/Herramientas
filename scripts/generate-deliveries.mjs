import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const programPath = path.join(root, 'docs/superpowers/delivery-program.json');
const outDir = path.join(root, 'docs/superpowers/deliveries');
const program = JSON.parse(fs.readFileSync(programPath, 'utf8'));
const details = JSON.parse(fs.readFileSync(path.join(root, 'docs/superpowers/delivery-details.json'), 'utf8')).deliveries;

const one = (value) => `- ${value}`;
const cell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (headers, rows) => `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n${rows.map((row) => `| ${row.map(cell).join(' | ')} |`).join('\n')}`;
const node = (value) => value.replace(/[^A-Za-z0-9_]/g, '_');
function renderDetail(id) {
  const detail = details[id];
  if (!detail) return '';
  const componentDiagram = detail.components.map((component) => `  ${node(component.id)}[${component.id}]`).join('\n');
  const stateDiagram = detail.transitions.map((transition) => `  ${node(transition.from)} -->|${transition.event}| ${node(transition.to)}`).join('\n');
  const targetFile = detail.components.find((component) => component.status === 'future')?.path || detail.components[0].path;
  const traceRows = detail.requirements.map((requirement, index) => [requirement, 'entidades/transiciones/API de esta ficha', targetFile, 'migración E' + id.slice(1) + ' aún no creada', detail.tests[index] || detail.tests.at(-1), requirement, 'salida literal + commit + fecha']);
  return `
## Vista de arquitectura de la entrega

\`\`\`mermaid
flowchart LR
${componentDiagram}
\`\`\`

${table(['Componente', 'Estado', 'Ruta', 'Responsabilidad'], detail.components.map((item) => [item.id, item.status, item.path, item.purpose]))}

## Actores, tecnologías y dependencias externas

- **Actores:** ${detail.actors.join(', ')}.
- **Tecnologías:** ${detail.technologies.join(', ')}.

${table(['Servicio', 'Estado', 'Finalidad'], detail.external_services.map((item) => [item.name, item.status, item.purpose]))}

` + 'Un servicio `candidate` no autoriza contratación, instalación ni uso de credenciales.' + `

## Casos de uso y guía operativa

${table(['ID', 'Actor', 'Precondición', 'Disparador', 'Flujo principal', 'Alternativas', 'Errores', 'Postcondición', 'Prueba', 'Evidencia'], detail.use_cases.map((item) => [item.id, item.actor, item.pre, item.trigger, item.main, item.alternatives, item.errors, item.post, item.test, item.evidence]))}

La guía operativa para cada caso es: verificar precondiciones; registrar commit, actor y hora; ejecutar
el flujo sin saltar guardas; ante una alternativa seguir su rama; ante error detener ampliación,
preservar evidencia y aplicar el SOP; comprobar postcondición y adjuntar la evidencia indicada.

## Modelo relacional detallado

${table(['Entidad', 'PK', 'Restricciones', 'Índices', 'Dueño', 'Retención', 'PII'], detail.entities.map((item) => [item.name, item.pk, item.constraints, item.indexes, item.owner, item.retention, item.pii]))}

Las entidades objetivo son \`future\`: su nombre y contrato quedan fijados para el diseño, pero ninguna
tabla se declara existente hasta observar su migración aplicada y consultar su esquema.

## Máquina de estados y transiciones

\`\`\`mermaid
stateDiagram-v2
${stateDiagram}
\`\`\`

${table(['Desde', 'Evento', 'Guarda', 'Hasta', 'Efecto', 'Error', 'Prueba'], detail.transitions.map((item) => [item.from, item.event, item.guard, item.to, item.effect, item.error, item.test]))}

## Secuencias normal, degradada e incierta

\`\`\`mermaid
sequenceDiagram
  participant A as Actor
  participant S as Sistema E${id.slice(1)}
  participant D as Dependencia
  A->>S: solicitud con precondiciones
  S->>D: lectura o efecto autorizado
  D-->>S: resultado verificable
  S-->>A: postcondición y evidencia
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant A as Actor
  participant S as Sistema E${id.slice(1)}
  participant D as Dependencia degradada
  A->>S: solicitud
  S-xD: timeout o error clasificado
  S-->>A: bloqueado/reintentable sin efecto duplicado
  S->>S: métrica, auditoría y SOP
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant W as Worker
  participant D as Dependencia remota
  W->>D: operación idempotente
  D--xW: respuesta perdida
  W->>W: estado uncertain; no repetir
  W->>D: GET de reconciliación
  D-->>W: estado observado
  W->>W: confirmar o compensar
\`\`\`

## Contratos API

${detail.apis.length ? table(['Método', 'Ruta', 'Autenticación', 'Entrada', 'Salida', 'Errores', 'Idempotencia', 'Concurrencia'], detail.apis.map((item) => [item.method, item.path, item.auth, item.input, item.output, item.errors, item.idempotency, item.concurrency])) : 'Esta entrega no expone API de negocio.'}

## Fallos, recuperación y SOP

${detail.failure_modes.map((item) => `- ${item}`).join('\n')}

El SOP común es: congelar ampliación; conservar payloads redactados, hashes y correlation ID; comprobar
fuente remota sin escribir; clasificar retryable/uncertain/terminal; reparar mediante replay idempotente
o compensación; demostrar conciliación; sólo entonces reanudar.

## Integraciones, observabilidad, rollout y rollback

${detail.integrations.map((item) => `- **Integración:** ${item}`).join('\n')}
${detail.observability.map((item) => `- **Observación:** ${item}`).join('\n')}
- **Rollout:** ${detail.rollout}
- **Rollback:** ${detail.rollback}

## Plan de implementación por cortes revisables

1. Congelar línea base, fuentes y fixture sin PII; commit sólo documental/evidencia.
2. Crear migraciones y restricciones con pruebas fallando; commit de esquema aislado.
3. Implementar dominio y máquinas de estado sin efectos remotos; commit unitario.
4. Añadir contratos, adaptadores y simulador; commit de integración.
5. Añadir UI/SOP/observabilidad y pruebas contractuales; commit operable.
6. Ensayar sombra, canario, aborto y rollback; adjuntar evidencia sin mezclar cambios.

## Matriz de trazabilidad

${table(['Requisito', 'Diseño', 'Archivo', 'Migración', 'Prueba', 'Métrica', 'Evidencia'], traceRows)}

## Fuentes y decisiones abiertas

${detail.sources.map((source) => `- ${source.url} — consultada ${source.consulted}.`).join('\n')}

**Decisiones abiertas que mantienen la ficha en borrador:** ${detail.open_decisions.join('; ')}.
`;
}
const e1EvidencePath = path.join(root, 'docs/superpowers/archive/plans-legacy-2026-09-13/2026-09-13-p1-fundacion-sombra.md');
const e1Detail = fs.readFileSync(e1EvidencePath, 'utf8')
  .slice(fs.readFileSync(e1EvidencePath, 'utf8').indexOf('## Decisiones fijadas'))
  .replace(/^## /gm, '### ')
  .replace(/^### /gm, '#### ')
  .replaceAll('P0', 'E0')
  .replaceAll('P1', 'E1')
  .replaceAll('P2–P5', 'E2–E13')
  .replaceAll('P2+', 'E2+')
  .replaceAll('P2', 'E2')
  .replace('1. Confirmar este plan corregido (y el presupuesto de RAM), después de que E0 quede cerrado.', '1. Esta especificación fue confirmada el 2026-09-13; E1 sólo puede iniciar después de aceptar E0 y crear su contrato ejecutable.');

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
${d.id === 'E1' ? `\n## Especificación vinculante incorporada\n\nEste contenido forma parte de E1. Su copia archivada sólo acredita procedencia.\n\n${e1Detail}` : ''}
${renderDetail(d.id)}
`;
  fs.writeFileSync(file, `${body.trimEnd()}\n`);
}

const decisionFile = path.join(root, 'docs/superpowers/decisions/plan-maestro-decisions.md');
const decisionText = fs.readFileSync(decisionFile, 'utf8');
const decisionIds = [...new Set(decisionText.match(/PM-\d{3}/g) || [])].sort();
const decisionRows = new Map([...decisionText.matchAll(/^\| (PM-\d{3}) \| (.+) \| (.+) \|$/gm)].map((match) => [match[1], `${match[2]} ${match[3]}`]));
const ownerFor = (id) => {
  const n = Number(id.slice(3));
  const row = decisionRows.get(id) || '';
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
  if (n === 159 || n === 160) return n === 159 ? 'E26' : 'E14';
  if (n === 161) return 'E6';
  if (n === 162) return 'E19';
  if (n === 163) return 'E16';
  if (n >= 165 && n <= 168) return 'E0';
  if (/webhook|barrido|scan|pregunta|mensaje|reclamo|dead.?letter|pipeline de eventos|frescura/i.test(row)) return 'E1';
  if (/GTIN|EAN|UPC|Producto Fusion|producto Woo|variaci[oó]n|familia|atributo|cat[aá]logo/i.test(row)) return 'E2';
  if (/escritor|escritura remota|canario|saga|operaci[oó]n.*ML|stock cero|SELLER_SKU.*PUT/i.test(row)) return 'E4';
  if (/stock|sobreventa|user_product/i.test(row)) return 'E5';
  if (/pedido|preparaci[oó]n|tracking|despacho/i.test(row)) return 'E9';
  if (/pantalla|responsive|buscador|detalle|chip|componente|foto|miniatura|accesibilidad/i.test(row)) return 'E3';
  if (/SQLite|ESLint|Git|repo|test|transversal|rendimiento|operaci[oó]n/i.test(row)) return 'E26';
  return 'E3';
};
const consumersFor = (id, owner) => {
  // PM-165–168 (infraestructura y DR de E0) no tienen consumidores: sus textos mencionan
  // "migración" o "producto" como contexto y las reglas por palabra los asignarían por error.
  if (Number(id.slice(3)) >= 165 && Number(id.slice(3)) <= 168) return [];
  const row = decisionRows.get(id) || '';
  const consumers = new Set();
  if (/identidad|matcher|seller_sku|GTIN|EAN|UPC|Producto Fusion|publicaci[oó]n/i.test(row)) ['E2', 'E3', 'E4'].forEach((value) => consumers.add(value));
  if (/stock|inventario|recepci[oó]n|conteo|user_product/i.test(row)) ['E5', 'E6', 'E7'].forEach((value) => consumers.add(value));
  if (/pedido|preparaci[oó]n|tracking|despacho|cancelaci[oó]n/i.test(row)) ['E8', 'E9', 'E10', 'E11'].forEach((value) => consumers.add(value));
  if (/App|iPhone|m[oó]vil|offline|\/api\/v1/i.test(row)) ['E19', 'E20', 'E21', 'E22', 'E23'].forEach((value) => consumers.add(value));
  if (/webhook|inbox|mensaje|pregunta|reclamo|scheduler|worker|auditor[ií]a/i.test(row)) consumers.add('E1');
  consumers.delete(owner);
  return [...consumers];
};
const decisionCrosswalk = {
  schema_version: 1,
  rule: 'Un dueño vigente por decisión; consumidores adicionales se declaran aquí y en las fichas.',
  decisions: decisionIds.map((id) => {
    const owner = ownerFor(id);
    return { id, owner, consumers: consumersFor(id, owner), basis: 'contenido y dominio de la decisión' };
  })
};
fs.writeFileSync(path.join(root, 'docs/superpowers/decision-crosswalk.json'), `${JSON.stringify(decisionCrosswalk, null, 2)}\n`);

for (const d of program.deliveries) {
  const file = path.join(outDir, `${d.id}-${d.slug}.md`);
  const owned = decisionCrosswalk.decisions.filter((entry) => entry.owner === d.id).map((entry) => entry.id);
  const consumed = decisionCrosswalk.decisions.filter((entry) => entry.consumers.includes(d.id)).map((entry) => entry.id);
  const appendix = `\n## Decisiones PM asignadas\n\n- **Dueña:** ${owned.length ? owned.join(', ') : 'ninguna'}\n- **Consumidora:** ${consumed.length ? consumed.join(', ') : 'ninguna'}\n`;
  fs.appendFileSync(file, appendix);
}

const deliveryRows = program.deliveries.map((d) => `| ${d.id} | ${d.title} | ${d.depends.join(', ') || '—'} | ${d.state} | [${d.id}](${d.id}-${d.slug}.md) |`).join('\n');
const deliveryIndex = `# Entregas vigentes E0–E26

Esta es la única lista operativa. Los números son identidades estables; la columna Dependencias
define el DAG. El archivo histórico sólo se consulta mediante el crosswalk.

| Entrega | Resultado | Dependencias | Estado | Ficha |
|---|---|---|---|---|
${deliveryRows}

Antes de cambiar una ficha se ejecuta \`npm run docs:validate-deliveries\`. El generador sólo se usa
cuando cambió deliberadamente \`delivery-program.json\` y el diff resultante siempre se revisa.
`;
fs.writeFileSync(path.join(outDir, 'README.md'), deliveryIndex);
