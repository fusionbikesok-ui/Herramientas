// Invariantes estructurales del repo. No prueban una feature: impiden que vuelva una clase
// de bug que ya nos pasó y que la suite NO detecta, porque el código falla en runtime solo
// cuando se ejecuta esa rama, o peor, devuelve un resultado falso con los tests en verde.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fuentes() {
  const dirs = ['lib', 'routes', 'db'];
  const out = [];
  const caminar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) caminar(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  for (const d of dirs) caminar(path.join(raiz, d));
  return out.sort();
}

/** Recorta la tupla de VALUES balanceando paréntesis: adentro hay json(), COALESCE(), etc. */
function tupla(texto, desde) {
  let prof = 0;
  for (let j = desde; j < texto.length; j += 1) {
    if (texto[j] === '(') prof += 1;
    else if (texto[j] === ')') { prof -= 1; if (prof === 0) return texto.slice(desde + 1, j); }
  }
  return null;
}

function contarNivelSuperior(lista) {
  if (!lista.trim()) return 0;
  let prof = 0; let n = 1;
  for (const ch of lista) {
    if (ch === '(') prof += 1;
    else if (ch === ')') prof -= 1;
    else if (ch === ',' && prof === 0) n += 1;
  }
  return n;
}

describe('invariantes de esquema y persistencia', () => {
  it('todo INSERT declara tantos valores como columnas', () => {
    // 2026-09-04: dos INSERT de lib/identidadProductos.js declaraban 10 valores para 9
    // columnas y 17 para 16. Reventaban en runtime (SqliteError) y tiraron 7 pruebas de una
    // feature entera. Un desajuste es siempre un bug, nunca una decisión.
    const patron = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:\n\s*)?VALUES\s*\(/gi;
    const desajustes = [];
    let analizados = 0;
    for (const archivo of fuentes()) {
      const texto = fs.readFileSync(archivo, 'utf8');
      for (const m of texto.matchAll(patron)) {
        const valores = tupla(texto, m.index + m[0].length - 1);
        if (valores === null || /\bSELECT\b/i.test(valores)) continue;
        const columnas = m[2].split(',').filter((c) => c.trim()).length;
        const cantidad = contarNivelSuperior(valores);
        analizados += 1;
        if (columnas !== cantidad) {
          desajustes.push(`${path.relative(raiz, archivo)}:${texto.slice(0, m.index).split('\n').length}`
            + ` INSERT INTO ${m[1]} declara ${columnas} columnas y ${cantidad} valores`);
        }
      }
    }
    // Si esto baja mucho, el patrón dejó de reconocer los INSERT y el test no protege nada.
    expect(analizados).toBeGreaterThan(200);
    expect(desajustes).toEqual([]);
  });

  it('ningún camino de pedido habilita escrituras remotas de identidad', () => {
    // El modo `shadow` no puede depender solo de una fila de configuración: ninguna ruta,
    // lib ni el server pueden pasar allowRemoteWrites=true. Habilitarlo es una acción de
    // rollout/canario explícita y externa, con autorización operativa. Ver UM1.1.
    const infractores = [];
    for (const archivo of fuentes().concat([path.join(raiz, 'server.js')])) {
      const texto = fs.readFileSync(archivo, 'utf8');
      for (const m of texto.matchAll(/allowRemoteWrites\s*:\s*true/g)) {
        infractores.push(`${path.relative(raiz, archivo)}:${texto.slice(0, m.index).split('\n').length}`
          + ' habilita escrituras remotas en un camino de pedido');
      }
    }
    expect(infractores).toEqual([]);
  });

  it('la configuración de identidad nace en shadow y sin escrituras remotas', () => {
    // Si alguien cambia el DEFAULT de la migración, una base nueva arrancaría escribiendo en
    // MercadoLibre sin que nadie lo decida.
    const sql = fs.readFileSync(path.join(raiz, 'migrations', '082_identidad_productos.sql'), 'utf8');
    expect(sql).toMatch(/modo\s+TEXT\s+NOT NULL\s+DEFAULT\s+'shadow'/);
    expect(sql).toMatch(/escrituras_remotas_habilitadas\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0/);
    // Y la fila 1 tiene que existir, o el scan nunca puede registrar frescura.
    expect(sql).toMatch(/INSERT OR IGNORE INTO identidad_config \(id, actualizado_en\) VALUES \(1,/);
  });

  it('ninguna migración escribe user_version por encima de 30', () => {
    // `user_version` no numera migraciones en esta base: es la compuerta de la migración
    // Hito 7 (`user_version < 30`, al final de openDb). Subirla saltea Hito 7, deja la base
    // sin device_tokens y tira toda la auth móvil. La idempotencia de cada migración la da
    // su marcador en `_schema_migrations`. Ver PM-034.
    const infractores = [];
    for (const archivo of fuentes()) {
      const texto = fs.readFileSync(archivo, 'utf8');
      for (const m of texto.matchAll(/user_version\s*=\s*(\d+)/g)) {
        if (Number(m[1]) > 30) {
          infractores.push(`${path.relative(raiz, archivo)}:${texto.slice(0, m.index).split('\n').length}`
            + ` escribe user_version = ${m[1]}`);
        }
      }
    }
    expect(infractores).toEqual([]);
  });
});

describe('cableado entre módulos: probar el cable, no solo las puntas', () => {
  // El 2026-09-06 el ramp del scan no gobernaba NADA y los tests estaban verdes.
  // `identidadProductos` llamaba a `frescuraVigenteMs` sin haberla importado; el
  // `try/catch` de respaldo se tragaba el ReferenceError y devolvía el default de 60
  // minutos. Había cobertura en las dos puntas —la función probada en mlScanRamp.test.js,
  // el consumidor probado en identidad-productos.test.js— y CERO en el cable entre ellas.
  //
  // La lección, que vale más allá de este caso: cuando un valor tiene que viajar de un
  // módulo a otro, hay que afirmar el EFECTO, no las piezas. Un test verde en cada extremo
  // no prueba que estén conectados.
  it('la frescura del ramp llega de verdad a la salud de identidad', async () => {
    const { openDb } = await import('../db/index.js');
    const { estadoIdentidadProductos } = await import('../lib/identidadProductos.js');
    const db = openDb(':memory:');
    // Una lectura de hace 90 minutos: vieja para una ventana de 60, fresca para una de 120.
    const hace90 = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    db.prepare('UPDATE identidad_config SET ultimo_scan_confiable_en=? WHERE id=1').run(hace90);

    db.prepare('UPDATE ml_scan_ramp SET intervalo_min=15, frescura_min=60 WHERE id=1').run();
    expect(estadoIdentidadProductos(db).degradado).toBe(true);

    db.prepare('UPDATE ml_scan_ramp SET intervalo_min=60, frescura_min=120 WHERE id=1').run();
    // Si esto vuelve a dar `true`, el cable se cortó otra vez y el ramp no gobierna nada.
    expect(estadoIdentidadProductos(db).degradado).toBe(false);
    db.close();
  });
});
