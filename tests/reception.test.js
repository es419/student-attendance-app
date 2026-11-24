const test=require('node:test');
const assert=require('node:assert/strict');
const R=require('../reception.js');
const day='2026-11-25',before=new Date('2026-11-24T18:00:00Z');
const morning={mode:'morning',readyTime:'07:00',travelMinutes:45,bufferMinutes:15,reminders:true};

test('only explicitly assigned dates generate notifications; no weekly recurrence',()=>{
  assert.deepEqual(R.reminders({},before),[]);
  const rows=R.reminders({[day]:morning},before);
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.date===day));
  assert.equal(rows[0].fire_at,'2026-11-25T05:00:00.000Z');
  assert.equal(rows[1].fire_at,'2026-11-25T05:30:00.000Z');
  assert.equal(R.departure(morning),'07:30');
  assert.ok(rows[0].message.includes('08:30'));
});
test('afternoon reception has a clothes reminder, no early departure or 08:30 requirement',()=>{
  const rows=R.reminders({'2026-11-30':{...morning,mode:'afternoon'}},before);
  assert.equal(rows.length,1);assert.equal(rows[0].stage,'ready');
  assert.ok(rows[0].message.includes('15:00–18:00'));assert.ok(!rows[0].message.includes('08:30'));
  assert.equal(R.departure({mode:'afternoon'}),null);
});
test('past times never catch up, disabled and arrived days stay silent',()=>{
  assert.equal(R.reminders({[day]:morning},new Date('2026-11-25T05:15:00Z')).length,1);
  assert.equal(R.reminders({[day]:morning},new Date('2026-11-25T05:30:00Z')).length,0);
  assert.deepEqual(R.reminders({[day]:{...morning,reminders:false}},before),[]);
  assert.deepEqual(R.reminders({[day]:morning},before,day),[]);
  assert.deepEqual(R.reminders({[day]:{cancelled:true}},before),[]);
});
test('Israeli winter/summer and date rollover work regardless of host timezone',()=>{
  assert.equal(R.at('2026-07-08','07:00').toISOString(),'2026-07-08T04:00:00.000Z');
  assert.equal(R.at(day,'07:00').toISOString(),'2026-11-25T05:00:00.000Z');
  assert.equal(R.dateKey(new Date('2026-11-24T22:30:00Z')),day);
  assert.equal(R.at('2026-03-27','02:30'),null);
});
test('bad dates, times and unreasonable travel are rejected',()=>{
  for(const date of ['2026-02-30','2026-13-01','bad','2026-1-1']) assert.equal(R.validDate(date),false);
  assert.equal(R.validDate('2028-02-29'),true);
  assert.ok(R.validation(day,{...morning,readyTime:'07:40'}));
  assert.ok(R.validation(day,{...morning,readyTime:'24:00'}));
  assert.ok(R.validation(day,{...morning,travelMinutes:400}));
  assert.ok(R.validation(day,{...morning,mode:'afternoon',readyTime:'15:00'}));
  assert.equal(R.validation(day,morning),null);
  assert.equal(R.departure({...morning,travelMinutes:60,bufferMinutes:20}),'07:10');
});
test('stable IDs deduplicate across devices, and isolate users and stages',async()=>{
  const id=await R.reminderId('user',day,'ready');
  assert.match(id,/^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  assert.equal(id,await R.reminderId('user',day,'ready'));
  assert.notEqual(id,await R.reminderId('other',day,'ready'));
  assert.notEqual(id,await R.reminderId('user',day,'leave'));
});
test('reconciliation is idempotent, updates pending times and never replays sent reminders',()=>{
  const desired=[{id:'ready',fire_at:'2026-11-25T05:00:00Z',message:'ready'}];
  assert.deepEqual(R.diff([],desired),{insert:desired,update:[],remove:[]});
  assert.deepEqual(R.diff([{...desired[0],sent:false}],desired),{insert:[],update:[],remove:[]});
  const existing=[{...desired[0],fire_at:'2026-11-25T04:30:00Z',sent:false},{id:'leave',sent:false}];
  assert.deepEqual(R.diff(existing,desired),{insert:[],update:desired,remove:['leave']});
  assert.deepEqual(R.diff(existing.map(row=>({...row,sent:true})),desired),{insert:[],update:[],remove:[]});
});
test('cancellation and morning to afternoon change remove obsolete pending reminders only',()=>{
  const old=[{id:'ready',sent:false},{id:'leave',sent:false},{id:'past',sent:true}];
  assert.deepEqual(R.diff(old,[]).remove,['ready','leave']);
  const desired=[{id:'ready',fire_at:'2026-11-25T05:00:00Z',message:'afternoon'}];
  assert.deepEqual(R.diff(old,desired).remove,['leave']);
  assert.equal(R.diff(old,desired).update[0].message,'afternoon');
});
