const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
const cleanup=source.slice(source.indexOf('async function cleanupRetiredReception(){'),source.indexOf('async function refreshAttendanceReminderSchedule(){'));

function harness(failingTable=null,user='owner'){
  const tables={
    kv_store:[
      {id:'assignment',user_id:'owner',key:'reception:2026-11-25'},
      {id:'other-assignment',user_id:'other',key:'reception:2026-11-25'},
      {id:'settings',user_id:'owner',key:'settings'},
      {id:'attendance',user_id:'owner',key:'attendance:2026-11'}
    ],
    break_reminders:[
      {id:'pending',user_id:'owner',message:'👔 קבלת קהל · 2026-11-25 · reminder',sent:false},
      {id:'sent',user_id:'owner',message:'👔 קבלת קהל · 2026-11-24 · reminder',sent:true},
      {id:'other',user_id:'other',message:'👔 קבלת קהל · 2026-11-25 · reminder',sent:false},
      {id:'break',user_id:'owner',message:'break reminder',sent:false},
      {id:'checkout',user_id:'owner',message:'לא שכחת להחתים יציאה?',sent:false}
    ]
  };
  const toasts=[];
  const db={from(table){
    const filters=[];
    const q={delete(){return q;},eq(key,value){filters.push(row=>row[key]===value);return q;},
      like(key,value){filters.push(row=>row[key].startsWith(value.slice(0,-1)));return q;},
      then(resolve,reject){return Promise.resolve().then(()=>{
        if(table===failingTable)return {error:new Error('offline')};
        tables[table]=tables[table].filter(row=>!filters.every(filter=>filter(row)));
        return {error:null};
      }).then(resolve,reject);}
    };return q;
  }};
  const context=vm.createContext({supabaseClient:db,currentUserId:user,showToast:message=>toasts.push(message),console:{error(){}}});
  vm.runInContext(cleanup,context);
  return {tables,toasts,context};
}
test('retirement removes only own reception assignments and unsent reception pushes; repeated cleanup is safe',async()=>{
  const h=harness();
  await h.context.cleanupRetiredReception();
  assert.deepEqual(h.tables.kv_store.map(row=>row.id),['other-assignment','settings','attendance']);
  assert.deepEqual(h.tables.break_reminders.map(row=>row.id),['sent','other','break','checkout']);
  const after=JSON.stringify(h.tables);
  await h.context.cleanupRetiredReception();
  assert.equal(JSON.stringify(h.tables),after);assert.deepEqual(h.toasts,[]);
});
test('assignment cleanup failure still cancels queued pushes and reports incomplete cancellation',async()=>{
  const h=harness('kv_store');
  await h.context.cleanupRetiredReception();
  assert.equal(h.tables.kv_store.length,4);
  assert.ok(!h.tables.break_reminders.some(row=>row.id==='pending'));
  assert.equal(h.toasts.length,1);
});
test('signed-out cleanup never deletes another account data',async()=>{
  const h=harness(null,null),before=JSON.stringify(h.tables);
  await h.context.cleanupRetiredReception();
  assert.equal(JSON.stringify(h.tables),before);assert.deepEqual(h.toasts,[]);
});
