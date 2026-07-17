/* Web Worker: corre el cómputo caro de candidatos (matcher-engine.js) fuera del hilo
   principal, para que la UI no se congele y la barra de progreso avance fluida.
   Recibe {wcItems, indice, pubs} y devuelve el array de candidatos (mismo orden que pubs). */
importScripts('matcher-engine.js');

self.onmessage=function(e){
  try{
    const {wcItems,indice,pubs}=e.data;
    const total=pubs.length;
    const CHUNK=200;
    const out=new Array(total);
    let i=0;
    function paso(){
      const fin=Math.min(i+CHUNK,total);
      for(;i<fin;i++){
        out[i]=MatcherEngine.candidatosDeItem(pubs[i],wcItems,indice);
      }
      self.postMessage({type:'progress',done:i,total});
      if(i<total)setTimeout(paso,0);else self.postMessage({type:'done',candidatos:out});
    }
    paso();
  }catch(err){
    self.postMessage({type:'error',message:err&&err.message||String(err)});
  }
};
