import {it,expect} from 'vitest';
import {savedReply,messageLabel,forwardBlock} from '../public/mensajeria/message-actions.js';
it('draft quotes validate IDs and versions and bound displayed content',()=>{
 expect(savedReply({id:'9223372036854775808',version:'a'.repeat(64)})).toBeNull();
 expect(savedReply({id:'12',version:'wrong'})).toBeNull();
 expect(savedReply({id:'12',version:'a'.repeat(64),author:'A',text:'x'.repeat(300)}).text).toHaveLength(220);
});
it('attachment summaries hide technical placeholder names',()=>{
 expect(messageLabel({text:'[Audio recibido]',media_id:'media',kind:'audio'})).toBe('Audio');
 expect(messageLabel({text:'Mi consulta',media_id:'media',kind:'image'})).toBe('Mi consulta');
});
it('forward enforces owner/window/channel and permits explicit take of free target',()=>{
 const actor={id:'a',role:'supervisor'},thread={status:'open',can_send:true,channel:'whatsapp'};
 expect(forwardBlock(thread,actor,{})).toBe('');
 expect(forwardBlock({...thread,can_send:false,send_blocked_reason:'owner_required'},actor,{})).toBe('');
 expect(forwardBlock({...thread,owner_id:'b'},actor,{})).toContain('A cargo');
 expect(forwardBlock({...thread,can_send:false,send_blocked_reason:'window_closed'},actor,{})).toContain('24 horas');
 expect(forwardBlock({...thread,channel:'web'},actor,{media_id:'m'})).toContain('texto');
 expect(forwardBlock(thread,{...actor,role:'reader'},{})).toContain('consulta');
});
