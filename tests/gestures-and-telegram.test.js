const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
function part(a,b){const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i);return source.slice(i,j)}
function swipe(){
  const handlers={};let deleted=0;
  const row={style:{},setPointerCapture(){},addEventListener(type,fn,capture){(handlers[type]||=[]).push({fn,capture})},querySelector(){return button}};
  const button={closest:sel=>sel==='.entry-del'?button:null,click(){
    let stopped=false;const event={target:button,stopImmediatePropagation(){stopped=true},preventDefault(){}};
    for(const h of handlers.click||[])if(h.capture)h.fn(event);
    if(!stopped)deleted++;
  }};
  const wrap={querySelector:()=>row,style:{setProperty(){}}};
  const c=vm.createContext({document:{querySelectorAll:()=>[wrap]},softHaptic(){},setTimeout(){return 1}});
  vm.runInContext(part('function wireSwipeRows(', '// Drag the editor sheet'),c);c.wireSwipeRows();
  function fire(type,x,y=10){for(const h of handlers[type]||[])h.fn({type,pointerType:'touch',pointerId:1,clientX:x,clientY:y,target:{closest:()=>null}})}
  return {fire,row,deleted:()=>deleted};
}
test('completed swipe activates deletion despite row click suppression',()=>{
  const h=swipe();h.fire('pointerdown',0);h.fire('pointermove',110);h.fire('pointerup',110);assert.equal(h.deleted(),1);
});
test('cancelled swipe never deletes a day',()=>{
  const h=swipe();h.fire('pointerdown',0);h.fire('pointermove',110);h.fire('pointercancel',110);assert.equal(h.deleted(),0);assert.equal(h.row.style.transform,'');
});
test('vertical scrolling and a short swipe never delete a day',()=>{
  for(const vertical of [false,true]){const h=swipe();h.fire('pointerdown',0);h.fire('pointermove',vertical?5:50,vertical?60:10);h.fire('pointerup',50);assert.equal(h.deleted(),0)}
});
test('cancelled sheet drag restores the sheet without dismissing the editor',()=>{
  const handlers={};let closed=false;
  const handle={setPointerCapture(){},addEventListener(type,fn){handlers[type]=fn}};
  const sheet={style:{}};const overlay={querySelector:()=>sheet,querySelectorAll:()=>[handle]};
  const c=vm.createContext({document:{getElementById:()=>overlay},setTimeout(){closed=true},clearTimeout(){},finishCloseEntryEditor(){closed=true},closeEntryTimer:null});
  vm.runInContext(part('function wireSheetDrag(', '// Pull down at the top'),c);c.wireSheetDrag();
  handlers.pointerdown({clientY:0,button:0,target:{closest:()=>null},currentTarget:handle});handlers.pointermove({clientY:160});handlers.pointercancel({type:'pointercancel'});
  assert.equal(closed,false);assert.equal(sheet.style.transform,'');
});
const telegramSource=fs.readFileSync(require.resolve('../supabase/functions/attendance-telegram/index.ts'),'utf8');
// This isolated function only has two string parameter annotations and one MonthData cast.
const action=telegramSource.slice(telegramSource.indexOf('async function performAction('),telegramSource.indexOf('function elapsedText(')).replace(/: string/g,'').replace(/ as MonthData/g,'');
function bot(days={},active=null,failDelete=false){
  const db={'attendance:2026-11':{days:JSON.parse(JSON.stringify(days))},...(active?{activeSession:JSON.parse(JSON.stringify(active))}:{})};
  const c=vm.createContext({loadState:async()=>({now:{date:'2026-11-26',time:'14:00'},settings:{},activeSession:db.activeSession||null,monthKey:'attendance:2026-11',monthData:JSON.parse(JSON.stringify(db['attendance:2026-11']))}),
    setKv:async(user,key,value)=>{db[key]=JSON.parse(JSON.stringify(value))},deleteKv:async(user,key)=>{if(failDelete)throw Error('offline');delete db[key]},
    elapsedMinutesSince:()=>360,MAX_SHIFT_MINUTES:960,isOnBreak:()=>false,breakMinutes:()=>0,cancelAttendanceReminders:async()=>{},cancelReminder:async()=>{},scheduleTelegramClockOutReminders:async()=>{},ATTENDANCE_REMINDER_MESSAGES:{}});
  vm.runInContext(action,c);return {c,db};
}
test('Telegram check-in also refuses existing work and sick days',async()=>{
  for(const entry of [{in:'08:00',out:'12:00'},{type:'sick'}]){const h=bot({'2026-11-26':entry});assert.match(await h.c.performAction('owner','clock_in'),/כבר קיים רישום/);assert.equal(h.db.activeSession,undefined)}
});
test('Telegram clock-out preserves notes and tags',async()=>{
  const h=bot({'2026-11-26':{in:'08:00',out:'12:00',note:'הערה',tag:'remote'}},{date:'2026-11-26',checkIn:'08:00',breaks:[]});
  await h.c.performAction('owner','clock_out');assert.equal(h.db['attendance:2026-11'].days['2026-11-26'].note,'הערה');assert.equal(h.db['attendance:2026-11'].days['2026-11-26'].tag,'remote');assert.equal(h.db.activeSession,undefined);
});
test('Telegram clock-out keeps an unrelated saved shift intact',async()=>{
  const h=bot({'2026-11-26':{in:'08:00',out:'12:00'}},{date:'2026-11-26',checkIn:'13:00',breaks:[]});
  assert.match(await h.c.performAction('owner','clock_out'),/רישום אחר/);assert.equal(h.db['attendance:2026-11'].days['2026-11-26'].out,'12:00');assert.ok(h.db.activeSession);
});
test('Telegram failed close propagates failure and keeps the session for retry',async()=>{
  const h=bot({},{date:'2026-11-26',checkIn:'08:00',breaks:[]},true);await assert.rejects(h.c.performAction('owner','clock_out'));assert.ok(h.db.activeSession);assert.equal(h.db['attendance:2026-11'].days['2026-11-26'].out,'14:00');
});
