const test=require('node:test');
const assert=require('node:assert/strict');
const P=require('../planner.js');
const month=new Date(2026,10,1,12),now=new Date(2026,10,22,12);
const plan={target:120,weekly:[8,8,8,8,8,0,0],overrides:{}};
const forecast=(p=plan,days={},active=null,time=now)=>P.forecast(p,month,days,active,time,40);
test('actual replaces planned; expired unrecorded days never inflate forecast',()=>{
 const f=forecast(plan,{'2026-11-22':{total:6}});
 assert.equal(f.actual,6);assert.equal(f.planned,48);assert.equal(f.projected,54);
 assert.equal(f.editable,6);assert.equal(f.perShift,11);assert.ok(f.missed>0);
});
test('date override cancels a working day or adds a weekend shift',()=>{
 const f=forecast({...plan,overrides:{'2026-11-22':0,'2026-11-28':4}});
 assert.equal(f.planned,52);assert.equal(f.editable,7);
});
test('current session uses full plan once and recorded day takes precedence',()=>{
 const active={date:'2026-11-22',checkIn:'08:00',breaks:[]};
 const f=forecast(plan,{},active);assert.equal(f.activeEstimate,8);assert.equal(f.projected,56);
 const completed=forecast(plan,{'2026-11-22':{total:5}},active);
 assert.equal(completed.activeEstimate,0);assert.equal(completed.projected,53);
});
test('active overtime and excess break allowance affect only the forecast',()=>{
 const p={target:120,weekly:[2,0,0,0,0,0,0]};
 const a={date:'2026-11-22',checkIn:'08:00',breaks:[{start:'10:00',end:'11:00'}]};
 assert.equal(forecast(p,{},a).activeEstimate,220/60);
});
test('forgotten session is excluded with an explicit warning',()=>{
 const f=forecast(plan,{}, {date:'2026-11-21',checkIn:'08:00',breaks:[]});
 assert.equal(f.unresolved,true);assert.equal(f.activeEstimate,0);
});
test('past month has no future shifts, and no division by zero',()=>{
 const f=P.forecast(plan,new Date(2026,9,1),{},null,now);
 assert.equal(f.projected,0);assert.equal(f.perShift,null);
});
test('leap year and year boundaries use local dates',()=>{
 const p={target:120,weekly:[1,1,1,1,1,1,1]};
 assert.equal(P.forecast(p,new Date(2028,1,1),{},null,new Date(2028,0,1)).planned,29);
 assert.equal(P.forecast(p,new Date(2027,0,1),{},null,new Date(2026,11,31)).planned,31);
});
test('no plan is empty, malformed hours cannot yield NaN',()=>{
 assert.equal(forecast(null).projected,0);
 assert.deepEqual(P.normalize({weekly:[-3,'x',200]}).weekly,[0,0,16,0,0,0,0]);
});
test('forecast leaves inputs untouched and reports excess separately',()=>{
 const p={target:10,weekly:[8,8,8,8,8,0,0]},days={'2026-11-22':{total:20}};
 const before=JSON.stringify([p,days]);const f=forecast(p,days);
 assert.equal(f.gap,0);assert.equal(f.over,58);assert.equal(JSON.stringify([p,days]),before);
});
