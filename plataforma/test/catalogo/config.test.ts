/*
 * test/catalogo/config.test.ts — E2 T1 tarea 3.
 *
 * El proyector del catálogo necesita su propia configuración, y sobre todo su propio keyring de sobres:
 * hoy el keyring se carga sólo dentro de `if (config.barridos)` (`worker/main.ts`), así que el proyector
 * no se podía encender sin encender barridos. Eso lo marcó la revisión externa como crítico.
 *
 * Todo nace apagado: sin las variables, el worker arranca igual y no consume nada.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorArranqueCatalogo, planDeKeyrings } from '../../src/catalogo/arranque.ts';
import { cargarConfig, ErrorConfig, type ConfigCatalogo } from '../../src/comun/config.ts';

/** El mínimo que cualquier servicio necesita, sin catálogo ni barridos ni informes. */
const base = {
  SERVICIO: 'worker', INSTANCIA: 'w1', VERSION: '1.0.0',
  PG_HOST: 'pg', PG_PORT: '5432', PG_DATABASE: 'plataforma', PG_USER: 'plataforma_app', PG_PASSWORD: 'x',
} as const;

describe('E2-CFG-01 configuración del catálogo', () => {
  it('sin variables de catálogo la configuración queda sin catálogo y el worker puede arrancar', () => {
    const c = cargarConfig({ ...base });
    expect(c.catalogo).toBeUndefined();
  });

  it('el proyector se enciende solo, sin depender de barridos, con su propio keyring', () => {
    const c = cargarConfig({ ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json' });
    expect(c.catalogo).toMatchObject({ proyector: true, keyringFile: '/run/k.json' });
    // Y no arrastra barridos: son dos cosas independientes, que es justamente el arreglo.
    expect(c.barridos).toBeUndefined();
  });

  it('encender el proyector sin keyring frena el arranque y dice qué falta', () => {
    // Sin keyring el proyector no puede descifrar ningún payload: fallar al arrancar es mejor que
    // descubrirlo mensaje por mensaje, con cada uno yendo a la DLQ.
    expect(() => cargarConfig({ ...base, CATALOGO_PROYECTOR: '1' }))
      .toThrow(/CATALOGO_KEYRING_FILE/);
  });

  it('los topes traen valores por omisión pensados para no atropellar a nadie', () => {
    const c = cargarConfig({ ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json' });
    expect(c.catalogo).toMatchObject({
      lote: 20,                 // un lote chico: el backlog son 3.490 mensajes de Woo más 427 de ML
      pausaMs: 1000,
      canario: 0,               // 0 = sin límite; el canario se pide explícitamente
      bootstrapRpm: 10,         // decisión de José: 10 lecturas por minuto, se sube de madrugada
      bootstrapCedeSenales: 20,
      umbralErrorPorciento: 10,
    });
  });

  it('los topes se pueden ajustar y se validan', () => {
    const c = cargarConfig({
      ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json',
      CATALOGO_LOTE: '5', CATALOGO_PAUSA_MS: '2500', CATALOGO_CANARIO: '100',
      CATALOGO_BOOTSTRAP_RPM: '30', CATALOGO_BOOTSTRAP_CEDE_SENALES: '50', CATALOGO_UMBRAL_ERROR: '25',
    });
    expect(c.catalogo).toMatchObject({
      lote: 5, pausaMs: 2500, canario: 100, bootstrapRpm: 30, bootstrapCedeSenales: 50, umbralErrorPorciento: 25,
    });
  });

  it('un lote de cero o un rpm de cero no se aceptan en silencio', () => {
    const conVars = (extra: Record<string, string>) =>
      () => cargarConfig({ ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json', ...extra });
    // Un lote de 0 haría un bucle que no procesa nada y parece sano; un rpm de 0 lo mismo.
    expect(conVars({ CATALOGO_LOTE: '0' })).toThrow(ErrorConfig);
    expect(conVars({ CATALOGO_BOOTSTRAP_RPM: '0' })).toThrow(ErrorConfig);
    // Un umbral de error arriba de 100 no significa nada.
    expect(conVars({ CATALOGO_UMBRAL_ERROR: '150' })).toThrow(ErrorConfig);
  });

  it('el canario admite cero (sin límite) pero no números negativos', () => {
    const conCanario = (v: string) => cargarConfig({
      ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json', CATALOGO_CANARIO: v });
    expect(conCanario('0').catalogo!.canario).toBe(0);
    expect(() => conCanario('-1')).toThrow(ErrorConfig);
  });

  it('el bootstrap se enciende aparte del proyector', () => {
    // Son dos interruptores: en producción el proyector va primero, con canario, y el bootstrap después.
    const c = cargarConfig({
      ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json', CATALOGO_BOOTSTRAP: '1' });
    expect(c.catalogo).toMatchObject({ proyector: true, bootstrap: true });
    const soloProyector = cargarConfig({
      ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json' });
    expect(soloProyector.catalogo).toMatchObject({ proyector: true, bootstrap: false });
  });
});

/*
 * El otro lado de la tarea 3: qué keyring carga el worker. El defecto era que el keyring de sobres salía
 * de dentro de `if (config.barridos)`, así que el catálogo no se podía encender solo.
 */
describe('E2-CFG-01 plan de keyrings del worker', () => {
  const catalogo = (extra: Partial<ConfigCatalogo> = {}): ConfigCatalogo => ({
    proyector: true, bootstrap: false, keyringFile: '/run/catalogo.json',
    lote: 20, pausaMs: 1000, canario: 0, bootstrapRpm: 10, bootstrapCedeSenales: 20, umbralErrorPorciento: 10, compararAtributos: false,
    ...extra,
  });
  const barridos = { registroFile: '/run/registro.json', keyringFile: '/run/sobres.json' };

  it('el catálogo carga su keyring aunque no haya barridos', () => {
    const plan = planDeKeyrings(undefined, catalogo());
    expect(plan).toEqual({ archivos: ['/run/catalogo.json'], sobresFile: null, catalogoFile: '/run/catalogo.json' });
  });

  it('con barridos y catálogo se cargan los dos, sin repetir si comparten archivo', () => {
    expect(planDeKeyrings(barridos, catalogo()).archivos).toEqual(['/run/sobres.json', '/run/catalogo.json']);
    // Mismo archivo para los dos: un solo keyring cargado, que es lo que va a pasar en producción.
    expect(planDeKeyrings(barridos, catalogo({ keyringFile: '/run/sobres.json' })).archivos)
      .toEqual(['/run/sobres.json']);
  });

  it('sin catálogo no se carga ninguno de más', () => {
    expect(planDeKeyrings(barridos, undefined))
      .toEqual({ archivos: ['/run/sobres.json'], sobresFile: '/run/sobres.json', catalogoFile: null });
    expect(planDeKeyrings(undefined, undefined)).toEqual({ archivos: [], sobresFile: null, catalogoFile: null });
  });

  it('el catálogo apagado no pide keyring', () => {
    const plan = planDeKeyrings(undefined, catalogo({ proyector: false, bootstrap: false }));
    expect(plan.catalogoFile).toBeNull();
  });

  it('el catálogo encendido sin keyring frena el arranque', () => {
    // @ts-expect-error keyringFile es obligatorio en el tipo: esto simula una configuración armada a mano.
    expect(() => planDeKeyrings(undefined, catalogo({ keyringFile: undefined })))
      .toThrow(ErrorArranqueCatalogo);
    // Y también con el bootstrap solo, que es el otro interruptor. Acá el tipo se respeta: una cadena
    // vacía es un string válido, y es justo la forma que toma una variable de entorno sin valor.
    expect(() => planDeKeyrings(undefined, catalogo({ proyector: false, bootstrap: true, keyringFile: '' })))
      .toThrow(ErrorArranqueCatalogo);
  });
});

/*
 * E2-CFG-07 — regresión del 2026-09-19, encontrada al encender el proyector en producción.
 *
 * Docker Compose interpola `${VAR}` de una variable que no existe como cadena VACÍA y la pasa igual al
 * contenedor. El esquema declara estos campos `z.string().min(1).optional()`, así que `''` no es "ausente"
 * sino "inválida": el worker no arrancaba con "configuración inválida o incompleta: CATALOGO_BOOTSTRAP"
 * por un flag que estaba apagado. Un flag apagado nunca debe tumbar un servicio.
 */
describe('E2-CFG-07 una variable vacía es una variable ausente', () => {
  it('el proyector se enciende aunque el bootstrap llegue como cadena vacía', () => {
    const c = cargarConfig({
      ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json',
      CATALOGO_BOOTSTRAP: '', CATALOGO_CANARIO: '100',
    });
    expect(c.catalogo).toMatchObject({ proyector: true, bootstrap: false, canario: 100 });
  });

  it('con todas las variables del catálogo vacías no hay catálogo, y no es un error', () => {
    const c = cargarConfig({
      ...base, CATALOGO_PROYECTOR: '', CATALOGO_BOOTSTRAP: '', CATALOGO_KEYRING_FILE: '',
    });
    expect(c.catalogo).toBeUndefined();
  });

  it('una vacía no enmascara lo que de verdad falta: el keyring sigue siendo obligatorio', () => {
    expect(() => cargarConfig({ ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '' }))
      .toThrow(ErrorConfig);
  });

  it('no se come un valor legítimo de otra variable', () => {
    const c = cargarConfig({ ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json', CATALOGO_LOTE: '50' });
    expect(c.catalogo?.lote).toBe(50);
  });
});

describe('E2-CFG-02 CATALOGO_COMPARAR_ATRIBUTOS', () => {
  const con = (v: string) => cargarConfig({
    ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json', CATALOGO_COMPARAR_ATRIBUTOS: v }).catalogo!.compararAtributos;
  it('por defecto está APAGADO; vacío es lo mismo que ausente; solo "1" lo enciende', () => {
    expect(cargarConfig({ ...base, CATALOGO_PROYECTOR: '1', CATALOGO_KEYRING_FILE: '/run/k.json' }).catalogo!.compararAtributos).toBe(false);
    expect(con('')).toBe(false);
    expect(con('0')).toBe(false);
    expect(con('1')).toBe(true);
  });
});

/*
 * E2-CFG-03 — la guarda que faltaba, para los cuatro grupos y no sólo para uno.
 *
 * Historia del defecto: el 2026-09-19 el catálogo quedó inencendible en producción porque `compose.yml`
 * no declaraba las variables `CATALOGO_*` — el worker arrancaba sano y no proyectaba nada. El 2026-09-20,
 * al desplegar el tramo 2, `CATALOGO_COMPARAR_ATRIBUTOS` repitió el hueco. La primera versión de este
 * test cubrió sólo `CATALOGO_*`, y una revisión externa marcó que el defecto es de CLASE y no de prefijo:
 * `BARRIDOS_*`, `SENALES_*` e `INFORMES_*` tienen la misma forma y el mismo riesgo.
 *
 * Compose sólo le pasa al contenedor las variables que DECLARA, así que una variable ausente del bloque
 * `environment` de su servicio no existe, por más que esté en `plataforma.env`.
 *
 * Las listas autoritativas son las del propio `config.ts` (`CAMPOS_BARRIDOS`, `CAMPOS_SENALES`,
 * `CAMPOS_INFORMES` y las `CATALOGO_*` del esquema), no una copia acá: copiarlas dejaría que este test
 * envejezca en silencio, que es justo el modo de falla que vino a cerrar.
 */
const GRUPOS: { nombre: string; servicio: string; variables: () => string[] }[] = [
  { nombre: 'CATALOGO_*', servicio: 'worker', variables: () => delEsquema(/^\s{2}(CATALOGO_[A-Z_]+):/gm) },
  { nombre: 'CAMPOS_BARRIDOS', servicio: 'worker', variables: () => deLista('CAMPOS_BARRIDOS') },
  { nombre: 'CAMPOS_SENALES', servicio: 'api', variables: () => deLista('CAMPOS_SENALES') },
  { nombre: 'CAMPOS_INFORMES', servicio: 'scheduler', variables: () => deLista('CAMPOS_INFORMES') },
];

const fuenteConfig = () => readFileSync(new URL('../../src/comun/config.ts', import.meta.url), 'utf8');

function delEsquema(re: RegExp): string[] {
  return [...fuenteConfig().matchAll(re)].map((m) => m[1]).filter((x): x is string => x !== undefined);
}

/** Los nombres de una lista `const CAMPOS_X = [...] as const;` de config.ts. */
function deLista(nombre: string): string[] {
  const m = new RegExp(`const ${nombre} = \\[([^\\]]*)\\]`, 's').exec(fuenteConfig());
  if (!m) throw new Error(`no encontré la lista ${nombre} en config.ts`);
  return [...m[1]!.matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]).filter((x): x is string => x !== undefined);
}

/**
 * El bloque de un servicio en compose.yml: desde `  nombre:` hasta la próxima clave de dos espacios.
 * Se corta por indentación porque lo que importa es que la variable esté en el bloque de SU servicio;
 * declararla en otro no sirve de nada.
 */
function bloqueServicio(servicio: string): string {
  const compose = readFileSync(new URL('../../deploy/compose.yml', import.meta.url), 'utf8');
  const lineas = compose.split('\n');
  const desde = lineas.findIndex((l) => l === `  ${servicio}:`);
  if (desde === -1) throw new Error(`no encontré el servicio ${servicio} en compose.yml`);
  const resto = lineas.slice(desde + 1);
  const hasta = resto.findIndex((l) => /^ {2}\S/.test(l));
  return (hasta === -1 ? resto : resto.slice(0, hasta)).join('\n');
}

describe('E2-CFG-03 compose declara las variables de cada grupo en su servicio', () => {
  for (const g of GRUPOS) {
    it(`${g.nombre} está completo en el servicio ${g.servicio}`, () => {
      const variables = g.variables();
      // Si el regex o la lista dejan de matchear, esto falla en vez de pasar en verde sobre cero variables.
      expect(variables.length).toBeGreaterThanOrEqual(2);
      const bloque = bloqueServicio(g.servicio);
      expect(variables.filter((v) => !bloque.includes(`${v}: \${${v}`))).toEqual([]);
    });
  }
});
