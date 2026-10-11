import {describe,it,expect} from 'vitest';
import {readBoundary,inboxPaneWidth} from '../public/mensajeria/app.js';
describe('Lectura visible y distribución de paneles',()=>{
 const ready={role:'agent',visible:true,selected:true,atBottom:true,unread:2};
 it('confirma el mensaje más reciente sin perder precisión bigint',()=>{
  expect(readBoundary([{id:'9007199254740993'},{id:'9007199254740992'},{id:'bad'}],ready)).toBe('9007199254740993');
 });
 it('no consume pendientes ocultos, lector, lista móvil ni historial desplazado',()=>{
  for(const patch of [{role:'reader'},{visible:false},{selected:false},{atBottom:false},{unread:0}])expect(readBoundary([{id:'2'}],{...ready,...patch})).toBe('');
  expect(readBoundary([],ready)).toBe('');
 });
 it('reserva espacio de respuesta y limita preferencias de cualquier tamaño',()=>{
  for(const width of [768,800,1024,1440,1800])for(const preferred of [-100,0,300,620,10000,null,NaN]){
   const result=inboxPaneWidth(preferred,width);expect(result.value).toBeGreaterThanOrEqual(260);expect(result.value).toBeLessThanOrEqual(620);expect(width-result.value-12).toBeGreaterThanOrEqual(360);
  }
 });
});
