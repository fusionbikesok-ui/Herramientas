const test=require('node:test');
const assert=require('node:assert/strict');
// Browser UMD asset: evaluate its CommonJS branch despite the parent ESM package.
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {runInThisContext}=require('node:vm');
const asset=join(__dirname,'assets/metrics.js');
const common={exports:{}};
runInThisContext('(function(module){'+readFileSync(asset,'utf8')+'\n})',{filename:asset})(common);
const {groups,share,periodRange,monthRange}=common.exports;

test('Un modelo agrupa sus variantes sin sumar dos veces el mismo pedido',()=>{
 const rows=[{modelKey:'p:1',brand:'ZION',quantity:2,amount:50,order:10},{modelKey:'p:1',brand:'ZION',quantity:1,amount:25,order:10},{modelKey:'p:1',brand:'ZION',quantity:1,amount:25,order:11}];
 const [model]=groups(rows,r=>r.modelKey);assert.equal(model.quantity,4);assert.equal(model.amount,100);assert.equal(model.orders.size,2);
});
test('Modelos homónimos conservan identidades separadas',()=>{
 const rows=[{modelKey:'p:1',model:'Bici',brand:'A',quantity:1,amount:50,order:10},{modelKey:'p:2',model:'Bici',brand:'A',quantity:1,amount:25,order:11}];assert.equal(groups(rows,r=>r.modelKey).length,2);
});
test('El ranking por marca acumula todos sus modelos y los importes netos',()=>{
 const rows=[{brand:'A',quantity:2,amount:150,order:1},{brand:'A',quantity:0,amount:-25,order:2},{brand:'B',quantity:1,amount:100,order:3}];
 const results=groups(rows,r=>r.brand);assert.equal(results[0].amount,125);assert.equal(results[0].quantity,2);assert.equal(results[1].amount,100);
});
test('Participación corresponde a la métrica seleccionada y evita división por cero',()=>{assert.equal(share(25,100),25);assert.equal(share(0,100),0);assert.equal(share(0,0),null);assert.equal(share(3,-2),null);});
test('Fechas rápidas incluyen ambos extremos y cruzan años correctamente',()=>{assert.deepEqual(periodRange('30','2026-01-05'),['2025-12-07','2026-01-05']);assert.deepEqual(periodRange('90','2026-10-05'),['2026-07-08','2026-10-05']);assert.deepEqual(periodRange('month','2026-10-05'),['2026-10-01','2026-10-05']);});
test('Últimos 12 meses resuelve el 29 de febrero',()=>{assert.deepEqual(periodRange('year','2024-02-29'),['2023-02-28','2024-02-29']);});
test('La evolución incluye meses sin ventas',()=>{assert.deepEqual(monthRange('2026-01-31','2026-03-01'),['2026-01','2026-02','2026-03']);});
test('Fechas invertidas dentro del mismo mes y fechas imposibles se rechazan',()=>{assert.throws(()=>monthRange('2026-09-20','2026-09-01'));assert.throws(()=>monthRange('2026-02-30','2026-03-01'));});
test('El límite de 120 meses coincide con el contrato del servidor',()=>{assert.equal(monthRange('2016-01-01','2025-12-31').length,120);assert.throws(()=>monthRange('2016-01-01','2026-01-01'));});
