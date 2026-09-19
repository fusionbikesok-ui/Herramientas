#!/bin/bash
# Gate contractual de E2 tramo 1 (catálogo canónico): typecheck, las pruebas del catálogo en la plataforma y las
# del legado (outbox, captura por triggers, copia), y el gate de escenarios. Falla si falta un escenario.
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
TRABAJO="$(mktemp -d /tmp/fusion-e2.XXXXXX)"
trap 'rm -rf "$TRABAJO"' EXIT
npm --prefix "$RAIZ/plataforma" run typecheck
(cd "$RAIZ/plataforma" && npx vitest run test/catalogo/ test/migraciones.test.ts --reporter=json --outputFile="$TRABAJO/plataforma.json")
(cd "$RAIZ" && npx vitest run test/outboxPlataforma.test.js test/catalogoCopia.test.js --reporter=json --outputFile="$TRABAJO/legado.json")
node "$RAIZ/scripts/qa/gate-e2.mjs" --reporte "$TRABAJO/plataforma.json" --reporte "$TRABAJO/legado.json"
