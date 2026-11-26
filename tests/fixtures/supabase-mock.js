
window.__db={settings:{sickDayHours:8,attendanceRemindersEnabled:false,deductions:[],additions:[]},'attendance:2026-11':{days:{'2026-11-20':{type:'work',in:'08:00',out:'16:00',brk:0,note:'existing',tag:'remote'},'2026-11-21':{type:'sick'}}}};
window.__failDelete=false;window.__failHistory=false;
window.supabase={createClient(){return {auth:{getSession:async()=>({data:{session:{user:{id:'fake-review-user'}}}}),onAuthStateChange(){},signOut:async()=>({})},from(table){
const f={};let op='select',value;const q={select(){return q},eq(k,v){f[k]=v;return q},in(k,v){f[k]=v;return q},like(k,v){f.like=v;return q},maybeSingle(){f.single=true;return q},single(){f.single=true;return q},insert(v){op='insert';value=v;return q},upsert(v){op='upsert';value=v;return q},delete(){op='delete';return q},then(resolve,reject){return Promise.resolve().then(()=>{
if(table!=='kv_store')return {data:null,error:null,count:0};
if(op==='upsert'){window.__db[value.key]=structuredClone(value.value);return {data:null,error:null};}
if(op==='delete'){if(window.__failDelete&&f.key==='activeSession')return {data:null,error:{message:'simulated delete failure'}};if(f.key)delete window.__db[f.key];return {data:null,error:null};}
if(f.like&&window.__failHistory)return {data:null,error:{message:'simulated network failure'}};
if(f.single)return {data:Object.hasOwn(window.__db,f.key)?{value:structuredClone(window.__db[f.key])}:null,error:null};
return {data:Object.entries(window.__db).filter(([k])=>Array.isArray(f.key)?f.key.includes(k):f.like?k.startsWith(f.like.replace('%','')):true).map(([key,value])=>({key,value:structuredClone(value)})),error:null};
}).then(resolve,reject)}};return q;}}}};