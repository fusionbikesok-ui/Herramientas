import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOPE_TIMEOUT_MS, crearDeposito, firmarSigV4 } from '../../src/informes/deposito.ts';

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

/**
 * Un B2 de juguete: guarda lo que se sube y responde HEAD y `GET ?retention&versionId` como el servicio real.
 * Registra cada pedido para poder mirar URL, método, credencial y cabeceras.
 */
function simuladorB2(opciones: { retencionLeida?: (pedida: string) => string; putSinVersion?: boolean } = {}) {
  const objetos = new Map<string, { version: string; retener: string; sha: string | undefined; cuerpo: string }>();
  const pedidos: Array<{ url: string; metodo: string; cuerpo: unknown; headers: Record<string, string> }> = [];
  let versiones = 0;
  const fetchSimulado = (async (url: string | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const metodo = String(init.method);
    pedidos.push({ url: String(url), metodo, cuerpo: init.body, headers });
    const u = new URL(String(url));
    const clave = decodeURIComponent(u.pathname.split('/').slice(2).join('/'));
    const obj = objetos.get(clave);
    if (metodo === 'PUT') {
      versiones += 1;
      objetos.set(clave, { version: `v${versiones}`, retener: headers['x-amz-object-lock-retain-until-date']!, sha: headers['x-amz-meta-sha256'], cuerpo: String(init.body) });
      return new Response('', { status: 200, headers: opciones.putSinVersion ? {} : { 'x-amz-version-id': `v${versiones}` } });
    }
    if (!obj) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    if (metodo === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'x-amz-version-id': obj.version, ...(obj.sha ? { 'x-amz-meta-sha256': obj.sha } : {}) } });
    }
    const retener = opciones.retencionLeida ? opciones.retencionLeida(obj.retener) : obj.retener;
    return new Response(`<Retention><Mode>COMPLIANCE</Mode><RetainUntilDate>${retener}</RetainUntilDate></Retention>`, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchSimulado, pedidos, objetos };
}

describe('deposito', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dep-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('la retención se calcula sobre el momento del PUT, no sobre el día reportado', async () => {
    const b2 = simuladorB2();
    // Se sube el 2026-09-20 un informe del 2026-09-14: la retención cuenta desde la subida.
    await crearDeposito(CFG(dir, b2.fetchSimulado)).subir('e1/reportes/2026-09-14.json', '{}', new Date('2026-09-20T10:00:00Z'));
    const retener = Date.parse(b2.pedidos[0]!.headers['x-amz-object-lock-retain-until-date']!);
    expect(retener - Date.parse('2026-09-20T10:00:00Z')).toBeGreaterThanOrEqual(365 * 86400e3);
  });

  it('la subida manda Object Lock en modo COMPLIANCE, el hash del contenido y firma todas sus cabeceras', async () => {
    const b2 = simuladorB2();
    const r = await crearDeposito(CFG(dir, b2.fetchSimulado)).subir('e1/reportes/2026-09-16.json', '{"a":1}', new Date('2026-09-17T10:00:00Z'));
    expect(r.versionId).toBe('v1');
    const p = b2.pedidos[0]!;
    expect(p.url).toBe('https://s3.us-west-000.backblazeb2.com/fusion-e1-pruebas/e1/reportes/2026-09-16.json');
    expect(p.metodo).toBe('PUT');
    expect(p.cuerpo).toBe('{"a":1}');
    expect(p.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
    const hash = createHash('sha256').update('{"a":1}').digest('hex');
    // SHA-256 de '{"a":1}', para que un cuerpo mal hasheado no pase el test.
    expect(p.headers['x-amz-content-sha256']).toBe(hash);
    expect(p.headers['x-amz-meta-sha256']).toBe(hash);
    expect(p.headers['x-amz-date']).toBe('20260917T100000Z');
    // La firma entera: recalculada con el firmador que el vector de AWS de arriba ya validó.
    expect(p.headers.authorization).toBe(firmarSigV4({
      metodo: 'PUT', ruta: '/fusion-e1-pruebas/e1/reportes/2026-09-16.json', consulta: '',
      cabeceras: {
        'content-md5': createHash('md5').update('{"a":1}', 'utf8').digest('base64'),
        host: 's3.us-west-000.backblazeb2.com',
        'x-amz-content-sha256': hash, 'x-amz-date': '20260917T100000Z', 'x-amz-meta-sha256': hash,
        'x-amz-object-lock-mode': 'COMPLIANCE',
        'x-amz-object-lock-retain-until-date': p.headers['x-amz-object-lock-retain-until-date']!,
      },
      hashCuerpo: hash, region: 'us-west-000', credencial: { id: 'w', clave: 'kw' },
    }));
  });

  it('después de subir relee la retención, y si no quedó COMPLIANCE hasta la fecha pedida, falla', async () => {
    const b2 = simuladorB2({ retencionLeida: () => '2026-10-01T00:00:00Z' });
    await expect(crearDeposito(CFG(dir, b2.fetchSimulado)).subir('e1/x.json', '{}', new Date('2026-09-17T10:00:00Z')))
      .rejects.toThrow(/no confirmó la retención/);
    expect(b2.pedidos.map((p) => p.metodo)).toEqual(['PUT', 'HEAD', 'GET']);
  });

  it('una subida sin versión se trata como fallo', async () => {
    const b2 = simuladorB2({ putSinVersion: true });
    await expect(crearDeposito(CFG(dir, b2.fetchSimulado)).subir('e1/x.json', '{}', new Date()))
      .rejects.toThrow(/version-id/);
  });

  it('una subida fallida se propaga con el cuerpo del error', async () => {
    const fetchSimulado = (async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })) as unknown as typeof fetch;
    await expect(crearDeposito(CFG(dir, fetchSimulado)).subir('e1/x.json', '{}', new Date()))
      .rejects.toThrow(/403.*AccessDenied/s);
  });

  it('consultar usa la credencial de lectura, pide la retención de la versión vigente y trae el hash', async () => {
    const b2 = simuladorB2();
    const dep = crearDeposito(CFG(dir, b2.fetchSimulado));
    await dep.subir('e1/reportes/2026-09-16.json', '{"a":1}', new Date('2026-09-17T10:00:00Z'));
    b2.pedidos.length = 0;
    const r = await dep.consultar('e1/reportes/2026-09-16.json');
    expect(r).toMatchObject({ versionId: 'v1', modo: 'COMPLIANCE', sha256: createHash('sha256').update('{"a":1}').digest('hex') });
    expect(b2.pedidos.map((p) => p.metodo)).toEqual(['HEAD', 'GET']);
    expect(b2.pedidos[1]!.url).toBe('https://s3.us-west-000.backblazeb2.com/fusion-e1-pruebas/e1/reportes/2026-09-16.json?retention=&versionId=v1');
    // La de lectura, no la de escritura: si se filtra una, que no sirva para lo otro.
    for (const p of b2.pedidos) expect(p.headers.authorization).toMatch(/Credential=r\//);
    expect(await dep.consultar('e1/reportes/falta.json')).toBeNull();
  });

  it('rechaza una clave fuera del prefijo', async () => {
    const dep = crearDeposito(CFG(dir, simuladorB2().fetchSimulado));
    await expect(dep.subir('otra/cosa.json', '{}', new Date())).rejects.toThrow(/fuera del prefijo/);
    await expect(dep.consultar('e1/../otra.json')).rejects.toThrow(/fuera del prefijo/);
  });

  it('el pendiente se escribe entero o no se escribe, y se limpia después', async () => {
    const dep = crearDeposito(CFG(dir, simuladorB2().fetchSimulado));
    const ruta = await dep.guardarPendiente('e1/reportes/2026-09-16.json', '{"a":1}');
    expect(readFileSync(ruta, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    // Un temporal huérfano de un corte anterior no traba el siguiente intento.
    writeFileSync(join(dir, 'e1_reportes_2026-09-17.json.tmp'), 'resto');
    await dep.guardarPendiente('e1/reportes/2026-09-17.json', '{"b":2}');
    await dep.limpiarPendiente(ruta);
    expect(readdirSync(dir).filter((f) => !f.endsWith('.tmp'))).toEqual(['e1_reportes_2026-09-17.json']);
  });
  it('rechaza un timeout que pueda sobrevivir al permiso de entrega', () => {
    // Hallazgo alto de la revisión de T4: con un pedido que dure más que el permiso, otro proceso puede
    // reclamar la entrega, no ver el objeto y subir una SEGUNDA versión, que en compliance queda un año.
    const fetchSimulado = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    expect(() => crearDeposito({ ...CFG('/tmp', fetchSimulado), timeoutMs: TOPE_TIMEOUT_MS + 1 }))
      .toThrow(/timeoutMs de B2 inválido/);
    expect(() => crearDeposito({ ...CFG('/tmp', fetchSimulado), timeoutMs: 0 })).toThrow(/timeoutMs de B2 inválido/);
    expect(() => crearDeposito({ ...CFG('/tmp', fetchSimulado), timeoutMs: TOPE_TIMEOUT_MS })).not.toThrow();
  });

});
