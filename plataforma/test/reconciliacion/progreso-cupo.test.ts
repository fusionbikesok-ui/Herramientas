import { describe, expect, it } from 'vitest';
import { adaptadorEnviosMl, adaptadorMensajesMl, adaptadorItemsMl } from '../../src/reconciliacion/adaptadores/ml.ts';
import { crearRelectoresMl } from '../../src/reconciliacion/relectura.ts';
import { rutaAOperacion } from '../../src/reconciliacion/transporte-gateway.ts';
import { ErrorCupoSombraAgotado } from '../../src/worker/barridos.ts';
import type { ContextoListado } from '../../src/reconciliacion/tipos.ts';

const ctx = { corrida: { channelAccountId: 'cuenta', cursorBefore: {} }, windowFrom: null, windowTo: new Date('2026-10-15T12:00:00Z') } as unknown as ContextoListado;
const ok = (body: unknown, status = 200) => ({ status, headers: new Headers(), body });
const item = (id: string) => ({ id, status: 'active', last_updated: '2026-10-15T10:00:00Z' });

describe('avance durable con cupo compartido pequeño', () => {
  it('un envío se confirma aunque la siguiente llamada ya no tenga cupo; un 404 también avanza', async () => {
    let disponible = 1;
    const vistos: string[] = [];
    const esperas: number[] = [];
    const db = { query: async (_sql: string, args: unknown[]) => ({ rows: ['1','2','3'].filter(x => x > String(args[1])).slice(0, Number(args[3])).map(target_id => ({ target_id })) }) };
    const a = adaptadorEnviosMl({ db: db as never, sellerId: '777', esperar: async (ms) => { esperas.push(ms); }, transporte: {
      async get(ruta: string) {
        if (disponible-- <= 0) throw new ErrorCupoSombraAgotado('cupo', 1);
        vistos.push(ruta); const id = ruta.split('/').at(-1)!;
        return id === '2' ? ok(null,404) : ok({ id, status:'ready_to_ship',last_updated:'2026-10-15T10:00:00Z' });
      },
    } });
    const p1 = await a.listar(ctx,null);
    expect(p1.resources.map(x=>x.id)).toEqual(['1']);
    await expect(a.listar(ctx,p1.nextPosition)).rejects.toBeInstanceOf(ErrorCupoSombraAgotado);
    disponible=1;
    const p2=await a.listar(ctx,p1.nextPosition);
    expect(p2.resources).toEqual([]);
    disponible=1;
    const p3=await a.listar(ctx,p2.nextPosition);
    expect(p3.resources.map(x=>x.id)).toEqual(['3']);
    expect(vistos).toEqual(['/shipments/1','/shipments/2','/shipments/3']);
    expect(esperas).toEqual([300,300,300]);
  });

  it('confirma un pack y conserva los pendientes aunque sólo quede un permiso', async () => {
    let disponible=1;
    const a=adaptadorMensajesMl({db:{} as never,sellerId:'777',transporte:{async get(ruta:string){
      if(disponible--<=0)throw new ErrorCupoSombraAgotado('cupo',1);
      expect(ruta).toContain('mark_as_read=false');
      return ok({messages:[{id:'m1',date_created:'2026-10-15T10:00:00Z'}]});
    }}});
    const pendientes=Array.from({length:10},(_,i)=>`/packs/${i+1}/sellers/777`);
    const p=await a.listar(ctx,{pendientes,despuesDe:''});
    expect(p.resources).toHaveLength(1);
    expect(p.nextPosition?.pendientes).toEqual(pendientes.slice(1));
  });

  it('guarda los IDs del scan antes del bulk y cada bulk antes de pedir el siguiente', async () => {
    let disponible=1; let scans=0;
    const ids=Array.from({length:60},(_,i)=>`MLA${1000+i}`);
    const a=adaptadorItemsMl({db:{} as never,sellerId:'777',esperar:async()=>{},transporte:{async get(ruta:string){
      if(disponible--<=0)throw new ErrorCupoSombraAgotado('cupo',1);
      if(ruta.includes('items/search')){scans++;return ok({results:ids,scroll_id:'S1'});}
      return ok(new URL(ruta,'http://x').searchParams.get('ids')!.split(',').map(id=>({id,status_code:200,body:item(id)})));
    }}});
    const scan=await a.listar(ctx,null);
    expect(scan.resources).toEqual([]);
    expect(scan.nextPosition?.pendientes).toEqual(ids);
    await expect(a.listar(ctx,scan.nextPosition)).rejects.toBeInstanceOf(ErrorCupoSombraAgotado);
    disponible=1;
    const bulk1=await a.listar(ctx,scan.nextPosition);
    expect(bulk1.resources.map(x=>x.id)).toEqual(ids.slice(0,20));
    expect(bulk1.nextPosition?.pendientes).toEqual(ids.slice(20));
    disponible=1;
    const bulk2=await a.listar(ctx,bulk1.nextPosition);
    expect(bulk2.resources.map(x=>x.id)).toEqual(ids.slice(20,40));
    expect(scans).toBe(1);
  });

  it.each([
    { scroll_id: 'S1', scroll_en: 0 },
    { fase: 'contenido', pendientes: ['MLA1'], scroll_id: 'S1', scroll_en: 0 },
  ])('un scroll vencido aborta antes de la red: %j', async (posicion) => {
    let llamadas = 0;
    const a = adaptadorItemsMl({ db: {} as never, sellerId: '777', ahora: () => 300_000,
      transporte: { async get() { llamadas++; return ok([]); } },
    });
    await expect(a.listar(ctx, posicion)).rejects.toThrow('SCROLL_VENCIDO');
    expect(llamadas).toBe(0);
  });

  it('el relector de mensajes cumple el contrato real del gateway', async () => {
    const operaciones: unknown[]=[];
    const r=crearRelectoresMl({transporte:{async get(ruta,extra){
      operaciones.push(rutaAOperacion(ruta,extra?.headers??{},'777'));
      return ok({messages:[{id:'m-1',message_date:{created:'2026-10-15T10:00:00Z'}}]});
    }}});
    expect((await r['ml.messages']!.releer('m-1')).tipo).toBe('recursos');
    expect(operaciones).toEqual([{op:'ml.message',params:{id:'m-1'}}]);
  });
});
