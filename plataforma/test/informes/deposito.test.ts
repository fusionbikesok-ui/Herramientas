import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearDeposito, firmarSigV4 } from '../../src/informes/deposito.ts';

const CFG = (dir: string, fetchSimulado: typeof fetch) => ({
  endpoint: 'https://s3.us-west-000.backblazeb2.com', region: 'us-west-000', bucket: 'fusion-e1-pruebas',
  prefijo: 'e1/', escritura: { id: 'w', clave: 'kw' }, lectura: { id: 'r', clave: 'kr' },
  dirPendientes: dir, fetch: fetchSimulado,
});

const VACIO = createHash('sha256').update('').digest('hex');

describe('firmarSigV4', () => {
  it('da la firma del ejemplo publicado por AWS (GET Object con Range)', () => {
    // Vector de "Signature Calculations for the Authorization Header", documentación de S3. Es la única
    // prueba independiente posible: si el test reimplementara SigV4, un error común pasaría en los dos.
    const auth = firmarSigV4({
      metodo: 'GET', ruta: '/test.txt', consulta: '',
      cabeceras: {
        host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9',
        'x-amz-content-sha256': VACIO, 'x-amz-date': '20130524T000000Z',
      },
      hashCuerpo: VACIO, region: 'us-east-1',
      credencial: { id: 'AKIAIOSFODNN7EXAMPLE', clave: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    });
    expect(auth).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
      + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
      + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

describe('deposito', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dep-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('la retención se calcula sobre el momento del PUT, no sobre el día reportado', async () => {
    const pedidos: Array<Record<string, string>> = [];
    const fetchSimulado = (async (_u: string | URL, init: RequestInit = {}) => {
      pedidos.push(Object.fromEntries(new Headers(init.headers).entries()));
      return new Response('', { status: 200, headers: { 'x-amz-version-id': 'v1' } });
    }) as unknown as typeof fetch;
    // Se sube el 2026-09-20 un informe del 2026-09-14: la retención cuenta desde la subida.
    await crearDeposito(CFG(dir, fetchSimulado)).subir('e1/reportes/2026-09-14.json', '{}', new Date('2026-09-20T10:00:00Z'));
    const retener = Date.parse(pedidos[0]!['x-amz-object-lock-retain-until-date']!);
    expect(retener - Date.parse('2026-09-20T10:00:00Z')).toBeGreaterThanOrEqual(365 * 86400e3);
  });

  it('la subida manda Object Lock en modo COMPLIANCE y firma todas sus cabeceras', async () => {
    const pedidos: Array<{ url: string; metodo: string; cuerpo: unknown; headers: Record<string, string> }> = [];
    const fetchSimulado = (async (url: string | URL, init: RequestInit = {}) => {
      pedidos.push({ url: String(url), metodo: String(init.method), cuerpo: init.body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return new Response('', { status: 200, headers: { 'x-amz-version-id': 'v42' } });
    }) as unknown as typeof fetch;
    const dep = crearDeposito(CFG(dir, fetchSimulado));
    const r = await dep.subir('e1/reportes/2026-09-16.json', '{"a":1}', new Date('2026-09-17T10:00:00Z'));
    expect(r.versionId).toBe('v42');
    const p = pedidos[0]!;
    expect(p.url).toBe('https://s3.us-west-000.backblazeb2.com/fusion-e1-pruebas/e1/reportes/2026-09-16.json');
    expect(p.metodo).toBe('PUT');
    expect(p.cuerpo).toBe('{"a":1}');
    expect(p.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
    // SHA-256 de '{"a":1}', para que un cuerpo mal hasheado no pase el test.
    expect(p.headers['x-amz-content-sha256']).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
    expect(p.headers['x-amz-date']).toBe('20260917T100000Z');
    // La firma entera: recalculada con el firmador que el vector de AWS de arriba ya validó.
    expect(p.headers.authorization).toBe(firmarSigV4({
      metodo: 'PUT', ruta: '/fusion-e1-pruebas/e1/reportes/2026-09-16.json', consulta: '',
      cabeceras: {
        host: 's3.us-west-000.backblazeb2.com',
        'x-amz-content-sha256': p.headers['x-amz-content-sha256']!, 'x-amz-date': '20260917T100000Z',
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': p.headers['x-amz-object-lock-retain-until-date']!,
      },
      hashCuerpo: p.headers['x-amz-content-sha256']!, region: 'us-west-000', credencial: { id: 'w', clave: 'kw' },
    }));
    expect(p.headers.authorization).toMatch(/Credential=w\/20260917\/us-west-000\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-object-lock-mode;x-amz-object-lock-retain-until-date,/);
  });

  it('una subida sin versión se trata como fallo', async () => {
    const fetchSimulado = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    await expect(crearDeposito(CFG(dir, fetchSimulado)).subir('e1/x.json', '{}', new Date()))
      .rejects.toThrow(/version-id/);
  });

  it('una subida fallida se propaga con el cuerpo del error', async () => {
    const fetchSimulado = (async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })) as unknown as typeof fetch;
    await expect(crearDeposito(CFG(dir, fetchSimulado)).subir('e1/x.json', '{}', new Date()))
      .rejects.toThrow(/403.*AccessDenied/s);
  });

  it('consultar pide ?retention con la credencial de lectura y devuelve el modo', async () => {
    const vistos: Array<{ url: string; auth: string }> = [];
    const fetchSimulado = (async (url: string | URL, init: RequestInit = {}) => {
      vistos.push({ url: String(url), auth: new Headers(init.headers).get('authorization') ?? '' });
      return String(url).includes('falta')
        ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        : new Response('<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>2027-09-18T00:00:00Z</RetainUntilDate></Retention>',
            { status: 200, headers: { 'x-amz-version-id': 'v42' } });
    }) as unknown as typeof fetch;
    const dep = crearDeposito(CFG(dir, fetchSimulado));
    expect(await dep.consultar('e1/reportes/2026-09-16.json'))
      .toEqual({ versionId: 'v42', retencion: '2027-09-18T00:00:00Z', modo: 'COMPLIANCE' });
    expect(vistos[0]!.url).toBe('https://s3.us-west-000.backblazeb2.com/fusion-e1-pruebas/e1/reportes/2026-09-16.json?retention=');
    // La de lectura, no la de escritura: si se filtra una, que no sirva para lo otro.
    expect(vistos[0]!.auth).toMatch(/Credential=r\//);
    expect(await dep.consultar('e1/reportes/falta.json')).toBeNull();
  });

  it('el pendiente se escribe entero o no se escribe, y se limpia después', async () => {
    const dep = crearDeposito(CFG(dir, (async () => new Response('', { status: 200 })) as unknown as typeof fetch));
    const ruta = await dep.guardarPendiente('e1/reportes/2026-09-16.json', '{"a":1}');
    expect(readFileSync(ruta, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    await dep.limpiarPendiente(ruta);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
