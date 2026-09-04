import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from './agent-pipeline-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routingFile = path.join(root, 'agents', 'routing.json');

function loadRouting() {
  if (!fs.existsSync(routingFile)) throw new Error(`falta ${path.relative(root, routingFile)}`);
  const parsed = JSON.parse(fs.readFileSync(routingFile, 'utf8'));
  if (!parsed?.roles || typeof parsed.roles !== 'object') throw new Error('agents/routing.json sin roles');
  for (const role of ROLES) if (!parsed.roles[role]) throw new Error(`agents/routing.json no define el rol ${role}`);
  for (const role of Object.keys(parsed.roles)) if (!ROLES.has(role)) throw new Error(`agents/routing.json define un rol inválido: ${role}`);
  return parsed;
}

export function loadRoutingFile() {
  return loadRouting();
}

// Devuelve { engine, model, effort?, sandbox? } para el rol, aplicando la escalera de riesgo
// si se pide escalate. escalate=false|0 usa la fila base; escalate=1 sube al primer escalón
// (sol/high), escalate=2 al segundo, que CAMBIA DE MOTOR: lo escribe Claude Opus. Solo tiene
// efecto sobre roles engine=codex; los roles engine=claude (revisor, auditor-despliegue,
// probador-e2e) no escalan por este mecanismo porque ya corren en el motor de mayor calidad.
// Gates que suben de sonnet a opus. `probador-e2e` queda afuera a propósito: está en Claude por
// restricción de herramienta (el MCP de Playwright vive ahí), no por exigencia de razonamiento,
// y manejar un navegador no mejora con un modelo más caro.
const GATES_ESCALABLES = new Set(['revisor', 'auditor-despliegue']);

export function resolveRouting(role, { escalate = 0, triggersHit = [] } = {}) {
  const config = loadRouting();
  const entry = config.roles[role];
  if (!entry) throw new Error(`rol sin ruteo: ${role}`);
  const routing = { ...entry };

  // Gates en Claude: suben si el diff toca un trigger (automático, por paths) o si se pide a
  // mano. El disparo automático es el punto: con presupuesto semanal, Opus tiene que gastarse
  // donde el riesgo lo justifica, y eso no puede depender de que el orquestador se acuerde.
  if (routing.engine === 'claude' && GATES_ESCALABLES.has(role)) {
    const step = config.escalation?.ladder_gates?.[0];
    if (step && (escalate > 0 || triggersHit.length)) {
      routing.model = step.model;
      routing.escalated = true;
      routing.motivo_escalada = triggersHit.length ? `triggers: ${triggersHit.join(', ')}` : 'solicitado con --escalate';
    }
    return routing;
  }

  if (routing.engine === 'codex' && escalate > 0) {
    const ladder = config.escalation?.ladder || [];
    const step = ladder[Math.min(escalate, ladder.length) - 1];
    if (step) {
      routing.escalated = true;
      routing.escalation_step = Math.min(escalate, ladder.length);
      if (step.engine && step.engine !== routing.engine) {
        // Techo de la escalera: el rol pasa a Claude. `effort` y `sandbox` son conceptos de
        // `codex exec`; dejarlos colgados le pasaría al orquestador de Claude campos que no
        // interpreta, y orchestrate-codex.mjs ya rechaza engine!=codex con el mensaje correcto.
        routing.engine = step.engine;
        routing.model = step.model;
        delete routing.effort;
        delete routing.sandbox;
      } else {
        routing.model = step.model;
        routing.effort = step.effort;
      }
    }
  }
  return routing;
}

export function escalationTriggers() {
  return loadRouting().escalation?.triggers || [];
}
