const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const R=require('../reception.js');
const source=fs.readFileSync(require.resolve('../reception-ui.js'),'utf8');
const day='2026-11-25',user='11111111-1111-4111-8111-111111111111';
const assignment={mode:'morning',readyTime:'07:00',travelMinutes:45,bufferMinutes:15,reminders:true};
function harness(time='2026-11-24T18:00:00Z'){
  const tables={kv_store:[{user_id:user,key:`reception:${day}`,value:assignment}],break_reminders:[]};
  let fail=false;
  const calls=[];
  const db={from(table){
    let action='read',values=null;const filters=[];
    const q={select(){return q;},eq(k,v){filters.push(row=>row[k]===v);return q;},like(k,v){filters.push(row=>String(row[k]).startsWith(v.replace(/%$/,'')));return q;},gte(k,v){filters.push(row=>row[k]>=v);return q;},in(k,vs){filters.push(row=>vs.includes(row[k]));return q;},delete(){action='delete';return q;},update(v){action='update';values=v;return q;},upsert(v,opts){action='insert';values=v;assert.equal(opts.ignoreDuplicates,true);return q;},
      then(resolve,reject){return Promise.resolve().then(()=>{
        if(fail) return {data:null,error:new Error('offline')};
        const matches=tables[table].filter(row=>filters.every(f=>f(row)));
        calls.push({table,action});
        if(action==='delete') tables[table]=tables[table].filter(row=>!matches.includes(row));
        if(action==='update') matches.forEach(row=>Object.assign(row,values));
        if(action==='insert') for(const row of values) if(!tables[table].some(old=>old.id===row.id)) tables[table].push({...row,sent:false});
        return {data:matches,error:null};
      }).then(resolve,reject);}
    };return q;
  }};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[time]));}}
  const context=vm.createContext({AttendanceReception:R,Date:Clock,currentUserId:user,supabaseClient:db,
    kvGetStrict:async key=>key==='activeSession'?context.session||null:context.attendance||null,writeInitialCache(){},console});
  vm.runInContext(source,context);
  return {context,tables,calls,setFail(v){fail=v;}};
}
test('database reconciliation survives repeated refreshes, mode/time edits and cancellation',async()=>{
  const h=harness();
  await h.context.refreshReceptionReminderSchedule();
  assert.equal(h.tables.break_reminders.length,2);
  assert.ok(h.tables.break_reminders.every(row=>row.user_id===user));
  const ids=h.tables.break_reminders.map(row=>row.id);
  await h.context.refreshReceptionReminderSchedule();
  assert.equal(h.tables.break_reminders.length,2);
  assert.equal(h.calls.filter(c=>c.action==='insert').length,1);
  h.tables.kv_store[0].value={...assignment,readyTime:'06:50'};
  await h.context.refreshReceptionReminderSchedule();
  assert.deepEqual(h.tables.break_reminders.map(row=>row.id),ids);
  assert.equal(h.tables.break_reminders[0].fire_at,'2026-11-25T04:50:00.000Z');
  h.tables.kv_store[0].value={...assignment,mode:'afternoon'};
  await h.context.refreshReceptionReminderSchedule();
  assert.equal(h.tables.break_reminders.length,1);assert.match(h.tables.break_reminders[0].message,/15:00–18:00/);
  const unrelated={id:'break',user_id:user,message:'break',sent:false};h.tables.break_reminders.push(unrelated);
  h.tables.kv_store[0].value={cancelled:true};
  await h.context.refreshReceptionReminderSchedule();
  assert.deepEqual(h.tables.break_reminders,[unrelated]);
});
test('sent reminders are never reset or reinserted when a stage time changes',async()=>{
  const h=harness();await h.context.refreshReceptionReminderSchedule();
  const sent=h.tables.break_reminders[0];sent.sent=true;
  h.tables.kv_store[0].value={...assignment,readyTime:'06:50'};
  await h.context.refreshReceptionReminderSchedule();
  assert.equal(sent.sent,true);assert.equal(sent.fire_at,'2026-11-25T05:00:00.000Z');
  assert.equal(h.tables.break_reminders.length,2);
});
test('failed cloud read does not cancel or overwrite existing pending reminders',async()=>{
  const h=harness();await h.context.refreshReceptionReminderSchedule();
  const before=JSON.stringify(h.tables.break_reminders);h.setFail(true);
  await assert.rejects(h.context.refreshReceptionReminderSchedule(),/offline/);
  assert.equal(JSON.stringify(h.tables.break_reminders),before);
  h.setFail(false);await h.context.refreshReceptionReminderSchedule();
  assert.equal(h.tables.break_reminders.length,2);
});
test('overlapping scheduling calls are serialized and schedule a single copy per stage',async()=>{
  const h=harness();
  await Promise.all([h.context.refreshReceptionReminderSchedule(),h.context.refreshReceptionReminderSchedule(),h.context.refreshReceptionReminderSchedule()]);
  assert.equal(h.tables.break_reminders.length,2);
  assert.equal(h.calls.filter(c=>c.action==='insert').length,1);
});
test('a refresh just after the due minute preserves the queued reminder for cron, without scheduling late catch-up',async()=>{
  const early=harness();await early.context.refreshReceptionReminderSchedule();
  const late=harness('2026-11-25T05:00:15Z');
  late.tables.break_reminders=structuredClone(early.tables.break_reminders);
  await late.context.refreshReceptionReminderSchedule();
  assert.equal(late.tables.break_reminders.length,2);
  const newAssignment=harness('2026-11-25T05:00:15Z');
  await newAssignment.context.refreshReceptionReminderSchedule();
  assert.equal(newAssignment.tables.break_reminders.length,1);
  assert.equal(newAssignment.tables.break_reminders[0].fire_at,'2026-11-25T05:30:00.000Z');
});
test('check-in or a completed attendance record suppresses remaining reminders for today',async()=>{
  for(const completed of [false,true]){
    const h=harness('2026-11-25T04:00:00Z');
    await h.context.refreshReceptionReminderSchedule();assert.equal(h.tables.break_reminders.length,2);
    if(completed) h.context.attendance={days:{[day]:{type:'work',in:'06:00',out:'06:30'}}};
    else h.context.session={date:day,checkIn:'06:00',breaks:[]};
    await h.context.refreshReceptionReminderSchedule();assert.equal(h.tables.break_reminders.length,0);
  }
});
