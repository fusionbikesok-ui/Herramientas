import {describe,it,expect} from 'vitest';
import {shouldChime,SOUND_INTERVAL} from '../public/mensajeria/attention.js';
describe('Aviso sonoro de pendientes',()=>{
 const base={pending:3,enabled:true,ready:true,allowed:true,last:0,now:60001};
 it('avisa sólo con pendientes, audio habilitado, permiso del navegador y agente disponible',()=>{
  expect(shouldChime(base)).toBe(true);
  for(const patch of [{pending:0},{enabled:false},{ready:false},{allowed:false},{last:59999}])expect(shouldChime({...base,...patch})).toBe(false);
 });
 it('espera un minuto entre avisos aun cuando llegan varios pendientes',()=>{
  expect(shouldChime({...base,now:1000+SOUND_INTERVAL-1,last:1000,pending:9})).toBe(false);
  expect(shouldChime({...base,now:1000+SOUND_INTERVAL,last:1000})).toBe(true);
 });
});
