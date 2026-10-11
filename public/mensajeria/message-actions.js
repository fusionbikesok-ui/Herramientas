export function savedReply(value) {
  if (!value || !/^[1-9][0-9]{0,18}$/.test(String(value.id || '')) || BigInt(value.id) > 9223372036854775807n || !/^[a-f0-9]{64}$/.test(value.version || '')) return null;
  return { id: String(value.id), version: value.version, author: String(value.author || '').slice(0,120), text: String(value.text || '').slice(0,220) };
}
export function messageLabel(message) {
  const body=String(message?.text || '').trim();
  if (message?.media_id && (!body || /^\[[^\]]{1,100}\]$/.test(body))) return {audio:'Audio',image:'Imagen',video:'Video',document:'Documento'}[message.kind] || 'Archivo';
  return body || 'Mensaje';
}
export function forwardBlock(thread, actor, source) {
  if (!['agent','supervisor'].includes(actor?.role)) return 'Acceso de consulta';
  if (thread?.status==='closed') return 'Conversación cerrada';
  if (thread?.owner_id && String(thread.owner_id)!==String(actor.id)) return `A cargo de ${thread.owner_name || 'otro agente'}`;
  if (source?.media_id && thread?.channel==='web') return 'El chat web admite texto';
  const mayTake=!thread?.owner_id&&thread?.send_blocked_reason==='owner_required';
  if (thread?.can_send!==true&&!mayTake) return thread?.send_blocked_reason==='window_closed'?'Fuera de las 24 horas':'Envío no disponible';
  return '';
}
