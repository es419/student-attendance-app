// Account-scoped dates, stored independently from payroll and the weekly planner.
let receptionAssignments={};
let receptionOpen=false;
let receptionSaving=false;
let receptionSyncPromise=null;
let receptionSyncAgain=false;
let receptionScheduleStatus='';
let receptionDraft=null;

function receptionRows(rows){
  return Object.fromEntries((rows||[]).filter(row=>row.key?.startsWith('reception:') && AttendanceReception.validDate(row.key.slice(10)))
    .map(row=>[row.key.slice(10),AttendanceReception.normalize(row.value)]).filter(([,value])=>value));
}
function receptionLabel(date){
  const label=new Intl.DateTimeFormat('he-IL',{timeZone:'Asia/Jerusalem',weekday:'short',day:'numeric',month:'numeric'}).format(new Date(`${date}T12:00:00Z`));
  return date===AttendanceReception.dateKey() ? `היום · ${label}` : label;
}
function receptionDates(){return Object.keys(receptionAssignments).filter(d=>d>=AttendanceReception.dateKey()).sort();}
function buildReception(){
  const dates=receptionDates(), next=dates[0];
  const hint=next ? `${receptionLabel(next)} · ${AttendanceReception.summary(receptionAssignments[next])}` : 'לפי שיבוץ שקיבלת';
  return `<section class="reception-panel" aria-label="שיבוצי קבלת קהל">
    <details id="receptionDetails" ${receptionOpen?'open':''}>
      <summary><span>👔 קבלת קהל<span class="reception-hint" id="receptionHint">${escapeHtml(hint)}</span></span><span class="reception-edit">${next?'עריכה':'הוספה'}</span></summary>
      <p class="plan-note">רק תאריך שתסמן יקבל תזכורת. אין חזרה שבועית.</p>
      <div class="reception-dates">${dates.map(date=>`<button type="button" data-reception-date="${date}">${escapeHtml(receptionLabel(date))} · <bdi>${AttendanceReception.summary(receptionAssignments[date])}</bdi></button>`).join('')}</div>
      <form id="receptionForm">
        <div class="reception-fields"><label>תאריך<input id="receptionDate" type="date" min="${AttendanceReception.dateKey()}" value="${next||AttendanceReception.dateKey()}" required></label>
        <label>שיבוץ<select id="receptionMode"><option value="morning">בוקר · הגעה עד 08:30</option><option value="afternoon">אחר הצהריים · ‎15:00–18:00‎</option></select></label></div>
        <label class="reception-checkbox"><input id="receptionReminders" type="checkbox" checked>תזכורות לשיבוץ הזה</label>
        <p class="reception-preview" id="receptionPreview"></p>
        <details class="reception-options"><summary>שעות התזכורות</summary>
          <label>תזכורת לבוש והתארגנות<input id="receptionReady" type="time" value="07:00" required></label>
          <div id="receptionTravelFields" class="reception-fields"><label>זמן נסיעה בדקות<input id="receptionTravel" type="number" min="0" max="240" step="1" value="45" required></label><label>מרווח ביטחון בדקות<input id="receptionBuffer" type="number" min="0" max="120" step="1" value="15" required></label></div>
          <p class="plan-note">הזמנים לפי שעון ישראל. שעת היציאה מחושבת מזמן הנסיעה ומרווח הביטחון.</p>
        </details>
        <p id="receptionPushStatus" class="plan-note" role="status"></p><button id="receptionEnablePush" type="button" hidden>הפעל התראות במכשיר הזה</button>
        <div class="plan-actions"><button type="submit">שמור שיבוץ</button><button type="button" id="receptionRemove" hidden>בטל שיבוץ</button><button type="button" id="receptionClose">סגור</button></div>
        <p id="receptionSaveStatus" class="plan-note" role="status" aria-live="polite">${escapeHtml(receptionScheduleStatus)}</p>
      </form>
    </details></section>`;
}
function receptionFormValue(){return {mode:$('#receptionMode').value,readyTime:$('#receptionReady').value,
  travelMinutes:Number($('#receptionTravel').value),bufferMinutes:Number($('#receptionBuffer').value),reminders:$('#receptionReminders').checked};}
function updateReceptionPreview(){
  const value=receptionFormValue(), date=$('#receptionDate').value;
  const morning=value.mode==='morning';
  $('#receptionTravelFields').hidden=!morning;
  $('#receptionRemove').hidden=!receptionAssignments[date];
  let text=!value.reminders?'התזכורות כבויות לשיבוץ הזה':`${value.readyTime||'07:00'} · לבוש והתארגנות${morning?` · ${AttendanceReception.departure(value)} יציאה לעבודה`:''}`;
  const pending=AttendanceReception.reminders({[date]:value});
  if(value.reminders && !AttendanceReception.validation(date,value) && pending.length<(morning?2:1)) text+=' · שעות שכבר חלפו לא יישלחו';
  $('#receptionPreview').textContent=text;
}
function fillReceptionForm(date,draftValue=null){
  const value=draftValue||receptionAssignments[date]||{mode:'morning',readyTime:'07:00',travelMinutes:45,bufferMinutes:15,reminders:true};
  $('#receptionDate').value=date;
  $('#receptionMode').value=value.mode;$('#receptionReady').value=value.readyTime;
  $('#receptionTravel').value=value.travelMinutes;$('#receptionBuffer').value=value.bufferMinutes;
  $('#receptionReminders').checked=value.reminders;
  $('#receptionSaveStatus').textContent=receptionScheduleStatus;
  if(receptionOpen) receptionDraft={date,value:{...value}};
  updateReceptionPreview();
}
async function refreshReceptionPushUI(){
  const user=currentUserId, el=$('#receptionPushStatus'),button=$('#receptionEnablePush');
  if(!el||!button) return;
  const sub=await getCurrentPushSubscription();
  if(user!==currentUserId||!el.isConnected) return;
  if(sub){el.textContent='התראות פעילות במכשיר הזה. התזכורות נשמרות מראש גם כשהאפליקציה סגורה.';button.hidden=true;}
  else{
    const support=pushSupportStatus();
    el.textContent=support==='denied'?'ההתראות חסומות במכשיר הזה. יש לאפשר אותן בהגדרות המכשיר.':support==='unsupported'?'לקבלת התראות באייפון פתח את האפליקציה ממסך הבית והפעל התראות בהגדרות.':'הפעל התראות במכשיר שבו תרצה לקבל את התזכורות. שיבוץ לבדו אינו מפעיל הרשאה.';
    button.hidden=support!=='ok';
  }
}
function wireReception(){
  const details=$('#receptionDetails'),form=$('#receptionForm');
  details.addEventListener('toggle',()=>{
    if(!details.isConnected) return;
    receptionOpen=details.open;
    if(receptionOpen){void registerServiceWorker().then(refreshReceptionPushUI);}
    else if(!receptionSaving){receptionDraft=null;flushPendingRender();}
  });
  form.addEventListener('input',()=>{updateReceptionPreview();receptionDraft={date:$('#receptionDate').value,value:receptionFormValue()};});
  $('#receptionDate').addEventListener('change',()=>fillReceptionForm($('#receptionDate').value));
  document.querySelectorAll('[data-reception-date]').forEach(button=>button.addEventListener('click',()=>fillReceptionForm(button.dataset.receptionDate)));
  $('#receptionClose').addEventListener('click',()=>{receptionOpen=false;receptionDraft=null;render();});
  $('#receptionEnablePush').addEventListener('click',async()=>{await subscribeToPush();await refreshReceptionPushUI();});
  form.addEventListener('submit',event=>{event.preventDefault();void saveReception(false);});
  $('#receptionRemove').addEventListener('click',()=>void saveReception(true));
  fillReceptionForm(receptionDraft?.date||$('#receptionDate').value,receptionDraft?.value);
}
async function saveReception(remove){
  const form=$('#receptionForm'),user=currentUserId,date=$('#receptionDate').value,value=receptionFormValue();
  if(receptionSaving||!user) return;
  const problem=remove ? null : AttendanceReception.validation(date,value);
  if(problem){$('#receptionSaveStatus').textContent=problem;return;}
  if(!AttendanceReception.validDate(date)||date<AttendanceReception.dateKey()){showToast('בחר היום או תאריך עתידי');return;}
  receptionSaving=true;
  form.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
  $('#receptionSaveStatus').textContent=remove?'מבטל שיבוץ ותזכורות…':'שומר שיבוץ ותזכורות…';
  let saved=false;
  try{
    // A tombstone preserves the date on cloud refresh until cancellation succeeds.
    if(!await kvSet(`reception:${date}`,remove?{cancelled:true}:value)) throw new Error('save failed');
    saved=true;
    if(currentUserId!==user) return;
    if(remove) delete receptionAssignments[date];else receptionAssignments[date]=value;
    writeInitialCache(user);
    await refreshReceptionReminderSchedule();
    if(currentUserId!==user) return;
    const pushActive=!!(await getCurrentPushSubscription());
    if(currentUserId!==user) return;
    receptionOpen=false;receptionDraft=null;render();
    showToast(remove?'השיבוץ בוטל והתזכורות שלו הוסרו':value.reminders?(pushActive?'השיבוץ נשמר ותזכורות עתידיות תוזמנו':'השיבוץ נשמר. ודא שהתראות פעילות במכשיר שבו תרצה לקבל אותן'):'השיבוץ נשמר ללא תזכורות');
  }catch(error){
    console.error('reception save failed',error);
    if(currentUserId!==user) return;
    receptionScheduleStatus=saved?'השיבוץ נשמר, אבל עדכון התזכורות לא הושלם. לחץ שוב כדי לנסות לעדכן אותן.':'השיבוץ לא נשמר. בדוק חיבור ונסה שוב.';
    $('#receptionSaveStatus').textContent=receptionScheduleStatus;
    form.querySelectorAll('input,select,button').forEach(el=>el.disabled=false);
  }finally{receptionSaving=false;}
}

async function syncReceptionReminders(){
  const user=currentUserId;
  if(!user) return;
  // Read fresh assignments before reconciling: a stale device must not restore a cancelled day.
  const today=AttendanceReception.dateKey(new Date());
  const [{data:assignments,error:assignmentError},session,attendance]=await Promise.all([
    supabaseClient.from('kv_store').select('key,value').eq('user_id',user).like('key','reception:%').gte('key',`reception:${today}`),
    kvGetStrict('activeSession'),kvGetStrict(`attendance:${today.slice(0,7)}`)
  ]);
  if(assignmentError) throw assignmentError;
  if(currentUserId!==user) return;
  receptionAssignments=receptionRows(assignments);writeInitialCache(user);
  const now=new Date(),arrived=session?.date===today||attendance?.days?.[today]?today:null;
  // Allow the server cron to claim an already queued reminder just after its due
  // minute. A newly saved late assignment still never creates a past reminder.
  const candidates=AttendanceReception.reminders(receptionAssignments,new Date(now.getTime()-5*60000),arrived);
  const candidateRows=await Promise.all(candidates.map(async row=>({id:await AttendanceReception.reminderId(user,row.date,row.stage),user_id:user,fire_at:row.fire_at,message:row.message})));
  const pendingQuery=supabaseClient.from('break_reminders').select('id,fire_at,message,sent').eq('user_id',user).like('message',AttendanceReception.PREFIX+'%').eq('sent',false);
  const sentQuery=candidateRows.length ? supabaseClient.from('break_reminders').select('id,fire_at,message,sent').eq('user_id',user).in('id',candidateRows.map(row=>row.id)) : Promise.resolve({data:[],error:null});
  const results=await Promise.all([pendingQuery,sentQuery]);
  for(const result of results) if(result.error) throw result.error;
  if(currentUserId!==user) return;
  const existing=[...new Map(results.flatMap(r=>r.data||[]).map(row=>[row.id,row])).values()];
  const desired=candidateRows.filter(row=>Date.parse(row.fire_at)>now.getTime() || existing.some(old=>old.id===row.id&&!old.sent&&old.message===row.message&&Date.parse(old.fire_at)===Date.parse(row.fire_at)));
  const delta=AttendanceReception.diff(existing,desired);
  // Delete only this feature's obsolete pending rows. Sent notifications stay sent.
  if(delta.remove.length){const {error}=await supabaseClient.from('break_reminders').delete().eq('user_id',user).eq('sent',false).in('id',delta.remove);if(error) throw error;}
  for(const row of delta.update){
    const {error}=await supabaseClient.from('break_reminders').update({fire_at:row.fire_at,message:row.message}).eq('user_id',user).eq('id',row.id).eq('sent',false);
    if(error) throw error;
  }
  if(delta.insert.length){
    // Deterministic UUID + ignoreDuplicates protects against simultaneous refreshes.
    const {error}=await supabaseClient.from('break_reminders').upsert(delta.insert,{onConflict:'id',ignoreDuplicates:true});
    if(error) throw error;
  }
  receptionScheduleStatus='';
}
async function refreshReceptionReminderSchedule(){
  if(receptionSyncPromise){receptionSyncAgain=true;return receptionSyncPromise;}
  receptionSyncPromise=(async()=>{
    do{receptionSyncAgain=false;await syncReceptionReminders();}while(receptionSyncAgain&&currentUserId);
  })();
  try{return await receptionSyncPromise;}finally{receptionSyncPromise=null;}
}
function refreshReceptionInBackground(){
  void refreshReceptionReminderSchedule().then(()=>renderUnlessEditing()).catch(error=>{
    console.error('reception reminder refresh failed',error);
    receptionScheduleStatus='לא ניתן לוודא שהתזכורות מעודכנות. פתח את השיבוץ ולחץ שמור כדי לנסות שוב.';
    const el=$('#receptionSaveStatus');if(el) el.textContent=receptionScheduleStatus;
  });
}
