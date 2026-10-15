import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context={module:{exports:{}}};
vm.runInNewContext(fs.readFileSync(new URL('./assets/stock-report.js',import.meta.url),'utf8'),context);
const {resultMatches,viewRows,summarizeRows}=context.module.exports;
const rows=[{id:1,stock:1,units:11,alert:'critical',issue:''},{id:2,stock:7,units:9,alert:'healthy',issue:''},{id:3,stock:4,units:0,alert:'no_sales',issue:''},{id:4,stock:0,units:2,alert:'missing',issue:''}];
test('each tab totals exactly its own rows, not the full filtered catalogue',()=>{
 const snapshot=JSON.stringify(rows);
 const expected={critical:[2,1,13],ranking:[3,2,22],catalog:[4,3,22]};
 for(const view of ['critical','ranking','catalog']){const selected=viewRows(rows,view),s=summarizeRows(selected);assert.deepEqual([s.count,s.inStock,s.units],expected[view]);assert.equal(selected.find(r=>r.id===1).stock,1);}
 assert.equal(JSON.stringify(rows),snapshot);
});
test('stock filter, tab and summary use the same set before pagination',()=>{
 const base=rows.filter(r=>resultMatches(r,{stockState:'positive'}));
 const critical=summarizeRows(viewRows(base,'critical')),ranking=summarizeRows(viewRows(base,'ranking')),catalog=summarizeRows(viewRows(base,'catalog'));
 assert.deepEqual([critical.count,ranking.count,catalog.count],[1,2,3]);
 assert.deepEqual([critical.inStock,ranking.inStock,catalog.inStock],[1,2,3]);
 assert.equal(summarizeRows(viewRows(base,'catalog')).inStock,3);
});
test('negative, shared and ambiguous stock cannot count as a variant with positive stock',()=>{
 const data=[{stock:2,units:1,issue:'',alert:'healthy'},{stock:-4,units:2,issue:'',alert:'negative'},{stock:20,units:1,issue:'shared',alert:'review'},{stock:20,units:1,issue:'duplicate',alert:'review'},{stock:null,units:1,issue:'unknown',alert:'review'}];
 const s=summarizeRows(data);assert.deepEqual([s.inStock,s.excluded,s.negative,s.count],[1,3,1,5]);
 assert.equal(summarizeRows(data.slice(2)).inStock,0);assert.equal(summarizeRows([]).inStock,0);
});
