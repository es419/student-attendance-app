let shiftSearch='',shiftFilter='all',salaryDetailsOpen=false,entryOriginalDate=null,entryEntrySnapshot=null,historyBusy=false,reportBusy=false,entrySaving=false,settingsDirty=false,payslipDirty=false,payslipDraft=null;
let savePending=0,lastSaveState='idle',lastSavedAt=null;
function beginSave(){savePending++;lastSaveState='saving';updateSyncUI();}
function endSave(ok){savePending=Math.max(0,savePending-1);lastSaveState=ok?'saved':'error';if(ok)lastSavedAt=new Date();updateSyncUI();}
function updateSyncUI(){
  const el=document.getElementById('syncStatus');if(!el)return;
  const offline=navigator.onLine===false;
  const state=savePending?'saving':offline?'offline':lastSaveState;
  el.dataset.state=state;
  el.textContent=state==='saving'?'שומר…':state==='error'?'פעולה לא נשמרה':state==='offline'?'אין חיבור':state==='saved'?'נשמר בענן':'מחובר לחשבון';
  el.title=lastSavedAt?`שמירה אחרונה: ${lastSavedAt.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}`:'';
}
function wireEnhancements(){
  updateSyncUI();
  for(const [id,key] of [['actualPayslipGross','gross'],['actualPayslipNet','net']]){const input=document.getElementById(id);if(!input)continue;if(payslipDraft)input.value=payslipDraft[key];input.addEventListener('input',()=>{payslipDirty=true;payslipDraft={gross:document.getElementById('actualPayslipGross').value,net:document.getElementById('actualPayslipNet').value};});}
  document.getElementById('cancelPayslipDraft')?.addEventListener('click',()=>{payslipDirty=false;payslipDraft=null;render();flushPendingRender();});
  document.getElementById('salaryDetails')?.addEventListener('toggle',ev=>{salaryDetailsOpen=ev.target.open;});
  const search=document.getElementById('shiftSearch');if(search){search.value=shiftSearch;search.addEventListener('input',()=>{shiftSearch=search.value;updateEntriesView();});}
  const filter=document.getElementById('shiftFilter');if(filter){filter.value=shiftFilter;filter.addEventListener('change',()=>{shiftFilter=filter.value;updateEntriesView();});}
  document.getElementById('clearShiftFilters')?.addEventListener('click',()=>{shiftSearch='';shiftFilter='all';if(search)search.value='';if(filter)filter.value='all';updateEntriesView();});
  document.getElementById('exportPdfBtn')?.addEventListener('click',exportMonthPdf);
  document.getElementById('monthHistoryBtn')?.addEventListener('click',()=>openHistory());
  document.getElementById('entryHistoryBtn')?.addEventListener('click',()=>openHistory(entryOriginalDate));
  document.getElementById('duplicateEntryBtn')?.addEventListener('click',duplicateEntry);
  document.getElementById('entryTemplate')?.addEventListener('change',ev=>{const e=monthData.days[ev.target.value];if(e)applyEntryTemplate(e);});
  document.querySelectorAll('.export-menu button').forEach(button=>button.addEventListener('click',()=>{button.closest('details').open=false;}));
  document.getElementById('syncStatus')?.addEventListener('click',()=>{if(lastSaveState==='error')showToast('הפעולה האחרונה לא נשמרה. בצע אותה שוב לאחר בדיקת החיבור.');else if(lastSavedAt)showToast(`נשמר בענן ב־${lastSavedAt.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'})}`);});
}
function visibleDates(calc){return Object.keys(monthData.days).sort().reverse().filter(d=>AttendanceRecords.matches(d,monthData.days[d],calc.perDay[d],shiftSearch,shiftFilter));}
function applyEntryTemplate(entry){
  $('#entryType').value=entry.type==='sick'?'sick':'work';$('#entryIn').value=entry.in||'';$('#entryOut').value=entry.out||'';$('#entryBreak').value=entry.brk||0;$('#entryNote').value=entry.note||'';setEntryTag(entry.tag||'');updateEntryTypeUI();
}
function duplicateEntry(){
  const e=entryOriginalDate&&monthData.days[entryOriginalDate];if(!e)return;
  const copy=deepClone(e);openEntryEditor();applyEntryTemplate(copy);$('#entryDate').value='';$('#entryEditorTitle').textContent='שכפול יום עבודה';$('#entryDate').focus();showToast('בחר תאריך חדש ושמור את היום');
}
function templateOptions(){
  return Object.keys(monthData.days).sort().reverse().slice(0,15).map(d=>`<option value="${d}">${d.split('-').reverse().join('.')} · ${monthData.days[d].type==='sick'?'מחלה':`${monthData.days[d].in}–${monthData.days[d].out}`}</option>`).join('');
}
function entryDescription(e){return !e?'ללא רישום':e.type==='sick'?'יום מחלה':`${e.in}–${e.out}${e.brk?` · ${e.brk} דקות הפסקה`:''}${e.note?` · ${e.note}`:''}`;}
async function openHistory(date=null){
  if(historyBusy)return;
  const host=$('#historyOverlay'),body=$('#historyBody');host.hidden=false;body.textContent='טוען היסטוריה…';$('#historyTitle').textContent=date?`היסטוריית ${date.split('-').reverse().join('.')}`:'היסטוריית החודש';
  const userId=currentUserId,mk=monthKey(currentDate);historyBusy=true;
  try{
    const data=await kvGetStrict(`attendance:${mk}`);if(userId!==currentUserId||host.hidden)return;
    const events=(Array.isArray(data?.history)?data.history:[]).filter(e=>!date||e.date===date).slice().reverse();
    body.innerHTML=events.length?events.map((e,i)=>`<article class="history-event"><div class="history-event-head"><strong>${escapeHtml(e.date.split('-').reverse().join('.'))}</strong><time>${escapeHtml(new Date(e.at).toLocaleString('he-IL',{dateStyle:'short',timeStyle:'short'}))}</time></div><p>לפני: ${escapeHtml(entryDescription(e.before))}</p><p class="history-after">אחרי: ${escapeHtml(entryDescription(e.after))}</p><small>${e.source==='telegram'?'Telegram':'אפליקציה'}</small><button type="button" data-restore="${i}">שחזור המצב הקודם</button></article>`).join(''):'<p class="empty-copy">כאן יופיעו שינויים חדשים שנשמרו החל מגרסה 2.0. נשמרים עד 500 שינויים לחודש.</p>';
    body.querySelectorAll('[data-restore]').forEach(button=>button.addEventListener('click',async()=>{
      const event=events[Number(button.dataset.restore)],expected=deepClone(data?.days?.[event.date]||null);
      if(!confirm(`לשחזר את ${event.date.split('-').reverse().join('.')} למצב הבא?\n${entryDescription(event.before)}`))return;
      button.disabled=true;historyBusy=true;
      try{
        if(userId!==currentUserId)throw Error('Account changed');
        await mutateMonth(mk,m=>AttendanceRecords.restore(m,event,expected));
        host.hidden=true;finishCloseEntryEditor();render();showToast('הרישום שוחזר');
      }catch(e){showToast(e.message||'השחזור נכשל. נסה שוב.');button.disabled=false;}
      finally{historyBusy=false;}
    }));
  }catch(e){if(!host.hidden)body.textContent='לא ניתן לטעון את ההיסטוריה. סגור ונסה שוב עם חיבור לרשת.';}
  finally{historyBusy=false;}
}
async function exportMonthPdf(){
  if(reportBusy)return;reportBusy=true;const button=$('#exportPdfBtn');if(button)button.disabled=true;
  const userId=currentUserId,date=new Date(currentDate),snapshot=deepClone(monthData),calc=computeMonth(snapshot),format=settings.hoursFormat;
  try{
    showToast('מכין דוח חודשי…');
    const blob=await AttendanceReport.create({label:`${HE_MONTHS[date.getMonth()]} ${date.getFullYear()}`,days:snapshot.days,calc,formatHours:h=>AttendanceRecords.formatHours(h,format),formatMoney:fmtMoney,tagLabels:TAG_LABELS});
    if(userId!==currentUserId)return;
    const file=new File([blob],`attendance-${monthKey(date)}.pdf`,{type:'application/pdf'});
    // Generation can outlast iOS's share gesture. Always offer an explicit Share tap.
    const host=$('#reportReady');host.hidden=false;const share=$('#sharePdfBtn'),download=$('#downloadPdfBtn');
    share.hidden=!(navigator.canShare&&navigator.canShare({files:[file]}));
    share.onclick=async()=>{try{await navigator.share({files:[file],title:`דוח נוכחות ${monthKey(date)}`});}catch(e){if(e.name!=='AbortError')showToast('השיתוף לא הצליח. אפשר להוריד את הקובץ.');}};
    download.onclick=()=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=file.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);};
    $('#reportReadyName').textContent=`${HE_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  }catch(e){console.error('PDF export failed',e);showToast('הכנת הדוח נכשלה. נסה שוב.');}
  finally{reportBusy=false;if(button)button.disabled=false;}
}
function initEnhancements(){
  document.getElementById('historyClose')?.addEventListener('click',()=>{$('#historyOverlay').hidden=true;});
  document.getElementById('closeReportReady')?.addEventListener('click',()=>{$('#reportReady').hidden=true;});
  for(const id of ['historyOverlay','reportReady'])document.getElementById(id)?.addEventListener('click',ev=>{if(ev.target.id===id)ev.target.hidden=true;});
  document.getElementById('settingsDrawer')?.addEventListener('input',()=>{settingsDirty=true;});
  document.getElementById('settingsDrawer')?.addEventListener('toggle',ev=>{const el=ev.target;if(el.matches?.('.set-group')&&el.open)document.querySelectorAll('#settingsDrawer .set-group[open]').forEach(other=>{if(other!==el)other.open=false;});},true);
  window.addEventListener('online',updateSyncUI);window.addEventListener('offline',updateSyncUI);
  document.addEventListener('keydown',ev=>{
    const overlay=['releaseNotes','reportReady','historyOverlay','entryEditorOverlay'].map(id=>document.getElementById(id)).find(el=>el&&!el.hidden);
    const modal=overlay?.querySelector('[role=dialog]')||(document.body.classList.contains('settings-open')?document.getElementById('settingsDrawer'):null);
    if(!modal)return;
    if(ev.key==='Escape'){ev.preventDefault();ev.stopImmediatePropagation();if(overlay?.id==='entryEditorOverlay')closeEntryEditor();else if(overlay)overlay.hidden=true;else closeSettings();return;}
    if(ev.key==='Tab'){const items=[...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary,[tabindex="0"]')].filter(el=>el.getClientRects().length);if(!items.length)return;const first=items[0],last=items.at(-1);if(ev.shiftKey&&(document.activeElement===first||!modal.contains(document.activeElement))){ev.preventDefault();last.focus();}else if(!ev.shiftKey&&(document.activeElement===last||!modal.contains(document.activeElement))){ev.preventDefault();first.focus();}}
  },true);
  window.isUpdateSafe=()=>!isUserEditing()&&!payslipDirty&&!settingsDirty&&!settingsSaving&&!shiftActionBusy&&!monthChangeBusy&&!historyBusy&&!reportBusy&&!entrySaving;
}
