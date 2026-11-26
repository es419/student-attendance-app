const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),cp=require('node:child_process');
const R=require('../records.js'),PDF=require('../report.js');
const entry={type:'work',in:'08:00',out:'16:00',brk:0,note:'ישיבת צוות',tag:'remote'};
test('hours format rounds minutes, supports more than 24h and handles invalid data',()=>{
  assert.equal(R.formatHours(53.9,'clock'),'53:54');assert.equal(R.formatHours(1.999,'clock'),'2:00');assert.equal(R.formatHours(0,'clock'),'0:00');assert.equal(R.formatHours(NaN,'clock'),'—');assert.match(R.formatHours(8),/8[.,]0/);
});
test('filter and search compose across dates, notes, sick days, remote work and overtime',()=>{
  const h={ot125:1,ot150:0};
  assert.equal(R.matches('2026-11-26',entry,h,'צוות','remote'),true);
  assert.equal(R.matches('2026-11-26',entry,h,'26.11.2026','overtime'),true);
  assert.equal(R.matches('2026-11-26',entry,h,'','sick'),false);
  assert.equal(R.matches('2026-11-26',{type:'sick'},h,'מחלה','sick'),true);
  assert.equal(R.matches('2026-11-26',entry,h,'אין מילה','notes'),false);
});
test('audit records creates, edits and deletions while leaving unrelated days alone',()=>{
  const m={days:{a:entry,b:{...entry,out:'17:00'}}};
  const events=R.recordChanges(m,{b:entry,c:entry},{at:'2026-11-26T10:00:00Z'});
  assert.equal(events.length,3);assert.equal(events.find(e=>e.date==='a').before,null);assert.equal(events.find(e=>e.date==='c').after,null);assert.equal(events.find(e=>e.date==='b').before.out,'16:00');
  m.days.b.note='changed';assert.equal(events.find(e=>e.date==='b').after.note,'ישיבת צוות');
});
test('repeated identical save is audit-idempotent, independent of JSON key order',()=>{
  const m={days:{a:{out:'16:00',in:'08:00'}}};R.recordChanges(m,{a:{in:'08:00',out:'16:00'}});assert.equal(m.history,undefined);
});
test('audit retention is bounded without dropping the newest event',()=>{
  const m={days:{a:entry},history:Array.from({length:500},(_,i)=>({id:String(i)}))};R.recordChanges(m,{});assert.equal(m.history.length,500);assert.equal(m.history.at(-1).date,'a');
});
test('restore preserves unrelated days and refuses to overwrite a concurrent change',()=>{
  const m={days:{a:entry,b:entry}},event={date:'a',before:{...entry,out:'15:00'}};
  R.restore(m,event,entry);assert.equal(m.days.a.out,'15:00');assert.equal(m.days.b.out,'16:00');assert.throws(()=>R.restore(m,event,entry),/הרישום השתנה/);
});
test('restore can recover deletion, and removing a created record remains auditable',()=>{
  const m={days:{}};R.restore(m,{date:'a',before:entry},null);assert.deepEqual(m.days.a,entry);R.restore(m,{date:'a',before:null},entry);assert.equal(m.days.a,undefined);
});
test('PDF builder produces consistent page objects and exact byte-based xref offsets',()=>{
  const pages=[{width:10,height:20,bytes:new Uint8Array([255,216,0,10,255,217])},{width:10,height:20,bytes:new Uint8Array([255,216,255,217])}];
  const bytes=PDF.pdfFromJpegs(pages),text=Buffer.from(bytes).toString('latin1');assert.ok(text.startsWith('%PDF-1.4'));assert.match(text,/\/Count 2/);
  const xref=Number(text.match(/startxref\n(\d+)/)[1]);assert.equal(text.slice(xref,xref+4),'xref');
  for(const match of text.matchAll(/(\d{10}) 00000 n /g)){const at=Number(match[1]);assert.match(text.slice(at,at+15),/^\d+ 0 obj/);}
});
test('release metadata, package and generated assets are consistent',()=>{
  cp.execFileSync(process.execPath,['scripts/release.cjs','--check'],{cwd:require('node:path').resolve(__dirname,'..')});
  const r=require('../release.json'),p=require('../package.json');assert.equal(p.version,r.version);
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8'),sw=fs.readFileSync(require.resolve('../sw.js'),'utf8');
  for(const f of ['professional.css','enhancements.js','records.js','report.js','updates.js','release.js']){assert.ok(html.includes(`${f}?v=${r.version}-b${r.build}`));assert.ok(sw.includes(`${f}?v=${r.version}-b${r.build}`));}
});
function updater({safe=true,controlled=true}={}){
  const elements={},listeners={};let posts=0,reloads=0,updateError=false;
  function element(id){return elements[id]??=( {hidden:true,disabled:false,textContent:'',events:{},addEventListener(k,fn){this.events[k]=fn},querySelector(){return {textContent:'',replaceChildren(){},appendChild(){}}},focus(){}} );}
  const waiting={postMessage(){posts++}},reg={waiting,addEventListener(){},async update(){if(updateError)throw Error('offline')}};
  const serviceWorker={controller:controlled?{}:null,addEventListener(k,fn){listeners[k]=fn},getRegistration:async()=>reg};
  const window={AttendanceRelease:{version:'2.0.0',build:22,notes:[]},__attendanceSwRegistrationPromise:Promise.resolve(reg),isUpdateSafe:()=>safe};
  const c=vm.createContext({window,navigator:{serviceWorker},document:{getElementById:element,querySelectorAll:()=>[],addEventListener(){}},location:{reload(){reloads++}},localStorage:{getItem(){return true}},showToast(){},console});
  vm.runInContext(fs.readFileSync(require.resolve('../updates.js'),'utf8'),c);
  return {elements,reg,listeners,posts:()=>posts,reloads:()=>reloads,safe(v){safe=v},offline(){updateError=true}};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('update waits for an explicit install action and blocks open drafts',async()=>{
  const h=updater({safe:false});await tick();assert.equal(h.posts(),0);h.elements.installUpdateBtn.events.click();assert.equal(h.posts(),0);assert.match(h.elements.updateStatus.textContent,/שמור או בטל/);h.safe(true);h.elements.installUpdateBtn.events.click();assert.equal(h.posts(),1);
});
test('controller change in a different tab never forces this tab to reload',async()=>{
  const h=updater();await tick();h.reg.waiting=null;h.listeners.controllerchange();assert.equal(h.reloads(),0);assert.equal(h.elements.updateBanner.hidden,false);
});
test('first service-worker activation does not advertise a nonexistent update',async()=>{
  const h=updater({controlled:false});await tick();h.reg.waiting=null;h.elements.updateBanner.hidden=true;h.listeners.controllerchange();assert.equal(h.reloads(),0);assert.equal(h.elements.updateBanner.hidden,true);
});
test('requested update rechecks draft safety when the controller changes',async()=>{
  const h=updater();await tick();h.elements.installUpdateBtn.events.click();h.safe(false);h.reg.waiting=null;h.listeners.controllerchange();assert.equal(h.reloads(),0);h.safe(true);h.elements.installUpdateBtn.events.click();assert.equal(h.reloads(),1);
});
test('failed update checks display a retryable connectivity message',async()=>{
  const h=updater();await tick();h.offline();await h.elements.checkUpdatesBtn.events.click();assert.match(h.elements.updateStatus.textContent,/לא ניתן לבדוק/);assert.equal(h.elements.checkUpdatesBtn.disabled,false);
});
test('worker installation does not skip waiting; only an explicit message activates an upgrade',async()=>{
  const handlers={};let skips=0;let deleted=false;
  const c=vm.createContext({self:{addEventListener:(k,fn)=>handlers[k]=fn,skipWaiting:async()=>{skips++}},caches:{open:async()=>({put:async()=>{}}),delete:async()=>{deleted=true}},fetch:async()=>({ok:true}),Response});
  vm.runInContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),c);
  let pending;handlers.install({waitUntil:p=>pending=p});await pending;assert.equal(skips,0);assert.equal(deleted,false);handlers.message({data:{type:'SKIP_WAITING'},waitUntil:p=>pending=p});await pending;assert.equal(skips,1);
});
test('partial release download is rejected and its incomplete cache is removed',async()=>{
  const handlers={};let deleted=false;
  const c=vm.createContext({self:{addEventListener:(k,fn)=>handlers[k]=fn},caches:{open:async()=>({put:async()=>{}}),delete:async()=>{deleted=true}},fetch:async path=>({ok:!path.includes('professional.css')}),Response});
  vm.runInContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),c);let pending;handlers.install({waitUntil:p=>pending=p});await assert.rejects(pending,/Incomplete/);assert.equal(deleted,true);
});
