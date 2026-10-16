export const SOUND_INTERVAL=60000;
export function shouldChime({pending,enabled,ready,allowed,last,now}) {
  return pending>0 && enabled && ready && allowed && now-last>=SOUND_INTERVAL;
}
export function createAttention({post,refresh,identity,allowedSound}) {
  const $=id=>document.getElementById(id);
  let count=0,enabled=true,context=null,last=0,requestId=null,busy=false,actorId='';
  const baseTitle=document.title;
  function storageKey(part){return `mensajeria-attention:${actorId}:${part}`;}
  function label(){
    $('pending-sound').textContent=!enabled?'Sonido silenciado':context?.state==='running'?'Sonido activado':'Activar sonido';
    $('pending-sound').setAttribute('aria-pressed',String(enabled));
    $('pending-sound').title='Aviso suave cada minuto mientras haya pendientes. Podés silenciarlo.';
  }
  function identityChanged(){
    const actor=identity();
    if(actorId!==actor?.id){actorId=actor?.id||'';requestId=null;last=0;try{enabled=localStorage.getItem(storageKey('enabled'))!=='false';}catch{enabled=true;}}
    $('read-all').hidden=!(actor?.is_admin && actor?.role==='supervisor');
    $('read-all').disabled=busy||count===0;
    $('pending-sound').hidden=!['agent','supervisor'].includes(actor?.role);
    label();
  }
  function chime(){
    if(!actorId)return;
    let lastAcrossTabs=last;
    try{lastAcrossTabs=Math.max(last,Number(localStorage.getItem(storageKey('last')))||0);}catch{}
    const now=Date.now();
    if(!shouldChime({pending:count,enabled,ready:context?.state==='running',allowed:allowedSound(),last:lastAcrossTabs,now}))return;
    // Avoid interrupting message playback or microphone recording.
    if([...document.querySelectorAll('audio,video')].some(media=>!media.paused))return;
    try {
      const oscillator=context.createOscillator(),gain=context.createGain(),at=context.currentTime;
      oscillator.type='sine';oscillator.frequency.setValueAtTime(660,at);oscillator.frequency.setValueAtTime(880,at+0.16);
      gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(0.045,at+0.03);gain.gain.exponentialRampToValueAtTime(0.001,at+0.42);
      oscillator.connect(gain);gain.connect(context.destination);oscillator.start(at);oscillator.stop(at+0.44);
      oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
      last=now;try{localStorage.setItem(storageKey('last'),String(now));}catch{}
    }catch{/* Visual indicator remains available if audio is unsupported. */}
  }
  async function unlock(event){
    if(!enabled||!actorId||event?.target?.closest('#pending-sound'))return;
    try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;context ||=new Audio();await context.resume();label();chime();}catch{}
  }
  document.addEventListener('pointerdown',unlock);document.addEventListener('keydown',unlock);
  $('pending-sound').addEventListener('click',async()=>{
    if(enabled&&context?.state==='running')enabled=false;
    else {enabled=true;await unlock();}
    try{localStorage.setItem(storageKey('enabled'),String(enabled));}catch{}
    label();
  });
  $('read-all').addEventListener('click',async()=>{
    if(busy||!identity()?.is_admin||identity()?.role!=='supervisor')return;
    busy=true;requestId ||=crypto.randomUUID();identityChanged();
    $('attention-feedback').textContent='Marcando pendientes de todos los canales y números…';
    try{
      const result=await post('/read-all',{request_id:requestId});requestId=null;
      $('attention-feedback').textContent=`${result.marked} conversaciones marcadas como leídas. Conservan su responsable y estado.`;
      await refresh();
    }catch(error){$('attention-feedback').textContent=`${error.message} Podés reintentar; se conserva la misma operación.`;}
    finally{busy=false;identityChanged();}
  });
  return {identityChanged,update(value){
    count=Math.max(0,Number(value)||0);identityChanged();
    $('pending-alert').hidden=count===0;
    $('pending-alert-text').textContent=`${count} ${count===1?'conversación pendiente':'conversaciones pendientes'}`;
    document.title=count?`(${count}) Pendientes · Mensajería`:baseTitle;
    chime();
  }};
}
