#!/usr/bin/env node
// Genera scripts/schemas/handoff-<rol>.json a partir del contrato de agent-pipeline-policy.mjs.
// Se corre a mano cuando cambia el contrato (nuevo rol, nuevo campo); orchestrate-codex.mjs lee
// los archivos ya generados, no genera nada en runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES } from './agent-pipeline-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'schemas', '_base.json'), 'utf8'));
const { $comment, ...baseProps } = base;

// Los campos por rol son opcionales según el estado del handoff (por ej. un BLOQUEADO de
// hard-worker-backend no lleva resultado_suite). additionalProperties:false exige que estén
// declarados igual, así que van con type nullable — el modelo escribe null cuando no aplican.
const roleExtra = {
  revisor: {
    veredicto: { type: ['string', 'null'] },
    hallazgos: { type: ['array', 'null'], items: { type: 'string' } },
  },
  tester: {
    resultado_suite: { type: ['string', 'null'] },
  },
  'probador-e2e': {
    evidencia: { type: ['object', 'null'], additionalProperties: true },
    anchos_riesgos: { type: ['array', 'null'], items: { type: 'string' } },
  },
  'auditor-despliegue': {
    referencias_evidencia: { type: ['object', 'null'], additionalProperties: true },
    requiere_e2e: { type: ['boolean', 'null'] },
  },
};

for (const role of ROLES) {
  const properties = { ...baseProps, ...(roleExtra[role] || {}) };
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `handoff-${role}`,
    type: 'object',
    properties,
    // El proveedor de Codex exige additionalProperties:false en structured outputs. Como
    // consecuencia todo campo que un handoff pueda llevar (hallazgos legacy, alias, etc.)
    // tiene que estar en `properties`, no colarse por afuera — por eso el generador incluye
    // todos los campos conocidos por agent-pipeline-policy.mjs, no solo los obligatorios.
    required: Object.keys(properties),
    additionalProperties: false,
  };
  const file = path.join(root, 'scripts', 'schemas', `handoff-${role}.json`);
  fs.writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`escrito ${path.relative(root, file)}`);
}
