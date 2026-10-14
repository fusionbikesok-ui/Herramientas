import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const context={module:{exports:{}}};
vm.runInNewContext(fs.readFileSync(new URL('./assets/stock-report.js',import.meta.url),'utf8'),context);
const {resultMatches,compareResults}=context.module.exports;
const rows=[
 {id:1,name:'Bici 2',stock:10,units:2,coverage_days:450,last_sale:'2026-08-01',alert:'healthy'},
 {id:2,name:'Bici 10',stock:2,units:10,coverage_days:18,last_sale:'2026-10-10',alert:'healthy'},
 {id:3,name:'Casco',stock:null,units:3,coverage_days:null,last_sale:null,alert:'review'},
 {id:4,name:'Guante',stock:-1,units:1,coverage_days:0,last_sale:'2026-09-10',alert:'negative'},
 {id:5,name:'Raptor',stock:0,units:5,coverage_days:0,last_sale:'2026-10-01',alert:'missing'}
];
const ordered=(key,direction)=>[...rows].sort((a,b)=>compareResults(a,b,key,direction)).map(r=>r.id);
test('numeric ordering handles two digits, negatives and zero; unknown stock is last both ways',()=>{
 assert.deepEqual(ordered('stock','asc'),[4,5,2,1,3]);assert.deepEqual(ordered('stock','desc'),[1,2,5,4,3]);
 assert.deepEqual(ordered('units','desc'),[2,5,3,1,4]);
});
test('coverage and dates keep unknown values last; product names use natural ordering',()=>{
 assert.equal(ordered('coverage_days','asc').at(-1),3);assert.equal(ordered('coverage_days','desc').at(-1),3);
 assert.deepEqual(ordered('last_sale','desc'),[2,5,4,1,3]);assert.deepEqual(ordered('name','asc'),[1,2,3,4,5]);
});
test('stock filters distinguish reported zero from an unavailable quantity',()=>{
 const ids=stockState=>rows.filter(r=>resultMatches(r,{stockState})).map(r=>r.id);
 assert.deepEqual(ids('positive'),[1,2]);assert.deepEqual(ids('zero'),[5]);assert.deepEqual(ids('negative'),[4]);assert.deepEqual(ids('unknown'),[3]);
});
test('ranges combine inclusively and reject unknowns instead of treating them as zero',()=>{
 const f={stockMin:0,stockMax:2,unitsMin:5,unitsMax:10,coverMax:18};
 assert.deepEqual(rows.filter(r=>resultMatches(r,f)).map(r=>r.id),[2,5]);
 assert.equal(resultMatches(rows[2],{stockMax:0}),false);assert.equal(resultMatches(rows[2],{coverMax:0}),false);
 assert.equal(resultMatches(rows[4],{stockMax:0,coverMax:0}),true);
});
test('empty filters retain the catalogue and view defaults preserve previous ranking',()=>{
 assert.ok(rows.every(r=>resultMatches(r,{})));
 assert.deepEqual([...rows].sort((a,b)=>compareResults(a,b,'default','asc','ranking')).map(r=>r.id),[2,5,3,1,4]);
 assert.equal(compareResults({id:7,name:'Zion',units:1,coverage_days:3,alert:'critical'},rows[5-1],'default','asc','critical')<0,true);
});
test('sorting applies to the complete set before paging and does not change source rows',()=>{
 const snapshot=JSON.stringify(rows);const result=rows.filter(r=>resultMatches(r,{stockMin:0})).sort((a,b)=>compareResults(a,b,'units','desc'));
 assert.deepEqual(result.slice(0,2).map(r=>r.id),[2,5]);assert.equal(JSON.stringify(rows),snapshot);
});
