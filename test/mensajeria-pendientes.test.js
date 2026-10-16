import {describe,it,expect} from 'vitest';
import {readBoundary,inboxPaneWidth,shouldClaimOnOpen,filterHelp} from '../public/mensajeria/app.js';
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

describe('Asignación al abrir y significado de la bandeja',()=>{
 it('sólo reclama chats abiertos sin responsable y sin otra operación en curso',()=>{
  const actor={id:'a',role:'agent'},thread={status:'open',owner_id:null};
  expect(shouldClaimOnOpen(actor,thread)).toBe(true);
  for(const role of ['agent','supervisor'])expect(shouldClaimOnOpen({...actor,role},{...thread,owner_id:'b'})).toBe(false);
  expect(shouldClaimOnOpen({...actor,role:'reader'},thread)).toBe(false);
  expect(shouldClaimOnOpen(actor,{...thread,status:'closed'})).toBe(false);
  expect(shouldClaimOnOpen(actor,thread,true)).toBe(false);
 });
 it('distingue lectura y asignación',()=>{
  expect(filterHelp('unread')).toContain('Mensajes sin leer');
  expect(filterHelp('mine')).toContain('mensajes nuevos');
 });
});
