// Planning never writes attendance entries or changes pay calculations.
let plannerOpen = false;
let plannerSaving = false;
const PLAN_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
function planForecast(){
  return AttendancePlanner.forecast(settings.workPlan,currentDate,computeMonth().perDay,activeSession,new Date(),settings.freeBreakMinutes);
}
function planSummary(){
  if(!settings.workPlan) return '<span class="forecast-empty">הגדר ימי עבודה להצגת צפי</span>';
  const f=planForecast();
  const status = f.gap>0.01 ? `חוסר צפוי: ${fmtHours(f.gap)} ש׳` : f.over>0.01 ? `${fmtHours(f.over)} ש׳ מעל היעד` : 'היעד צפוי להתמלא';
  const warning = f.unresolved ? ' · נדרש תיקון משמרת פתוחה' : f.projected>settings.monthlyCap ? ' · מעל תקרת התשלום' : '';
  return `<span class="forecast-value">צפי לסוף החודש <strong class="mono">${fmtHours(f.projected)} ש׳</strong></span><span class="forecast-status">${status}${f.target!==settings.monthlyCap ? ` · יעד ${fmtHours(f.target)} ש׳` : ''}${warning}</span>`;
}
function buildPlanner(){
  const p=AttendancePlanner.normalize(settings.workPlan), today=todayStr();
  const rows=[];
  for(let day=1;day<=new Date(currentDate.getFullYear(),currentDate.getMonth()+1,0).getDate();day++){
    const date=new Date(currentDate.getFullYear(),currentDate.getMonth(),day,12), d=AttendancePlanner.key(date);
    if(d<today || monthData.days[d] || activeSession?.date===d) continue;
    rows.push(`<label class="plan-date-row"><span>${day}.${date.getMonth()+1} · ${PLAN_DAYS[date.getDay()]}</span><input type="number" data-plan-date="${d}" min="0" max="16" step="0.25" inputmode="decimal" placeholder="${p.weekly[date.getDay()]}" value="${Object.hasOwn(p.overrides,d)?p.overrides[d]:''}" aria-label="שעות בתאריך ${d}"></label>`);
  }
  return `<div class="plan-inline"><div id="planSummary">${planSummary()}</div>
    <details id="plannerDetails" ${plannerOpen?'open':''}><summary aria-label="עריכת תכנון ימי העבודה">תכנון</summary>
    <form id="plannerForm"><label class="plan-target">יעד שעות חודשי<input id="planTarget" type="number" min="1" max="744" step="0.25" value="${p.target}" required></label>
    <p class="plan-note">שעות שייספרו לאחר ניכוי הפסקות, עד 16 שעות למשמרת. 0 = לא עובד. חגים וחופשות יש לעדכן ידנית.</p>
    <div class="plan-week">${PLAN_DAYS.map((name,i)=>`<label><span>${name}</span><input type="number" data-plan-day="${i}" min="0" max="16" step="0.25" inputmode="decimal" value="${p.weekly[i]}" required aria-label="שעות ביום ${name}"></label>`).join('')}</div>
    <details><summary>שינויים נקודתיים לחודש הזה</summary><p class="plan-note">ריק = לפי השבוע הקבוע · 0 = חופש. רישומים קיימים ומשמרת פעילה אינם ניתנים לשינוי כאן.</p><div class="plan-dates">${rows.join('')||'<p>אין תאריכים פנויים לתכנון בחודש הזה.</p>'}</div></details>
    <p class="plan-note">השבוע הקבוע והיעד חלים על כל החודשים. שינוי תאריך חל רק עליו. התכנון אינו רישום נוכחות.</p>
    <div class="plan-actions"><button type="submit">שמור תכנון</button><button type="button" id="planCancel">ביטול</button></div><p id="planSaveStatus" role="status"></p>
    </form></details></div>`;
}
function wirePlanner(){
  const details=$('#plannerDetails'), form=$('#plannerForm');
  details.addEventListener('toggle',()=>{plannerOpen=details.open; if(!plannerOpen && !plannerSaving) flushPendingRender();});
  $('#planCancel').addEventListener('click',()=>{plannerOpen=false;render();});
  form.addEventListener('input',ev=>{
    if(ev.target.dataset.planDay!==undefined){
      document.querySelectorAll('[data-plan-date]').forEach(input=>{
        const weekday=new Date(`${input.dataset.planDate}T12:00:00`).getDay();
        input.placeholder=form.querySelector(`[data-plan-day="${weekday}"]`).value;
      });
    }
  });
  form.addEventListener('submit',async ev=>{
    ev.preventDefault();
    if(plannerSaving || !form.reportValidity()) return;
    const weekly=Array.from(form.querySelectorAll('[data-plan-day]'),input=>Number(input.value));
    const target=Number($('#planTarget').value);
    const overrides=Array.from(form.querySelectorAll('[data-plan-date]'),input=>[input.dataset.planDate,input.value]);
    plannerSaving=true;
    form.querySelectorAll('input,button').forEach(el=>el.disabled=true);
    $('#planSaveStatus').textContent='שומר תכנון…';
    try{
      const latest=normalizeSettings(await kvGetStrict('settings'));
      const next=AttendancePlanner.normalize(latest.workPlan);
      next.weekly=weekly;next.target=target;
      for(const [date,value] of overrides){if(value==='') delete next.overrides[date];else next.overrides[date]=Number(value);}
      latest.workPlan=next;
      if(!await kvSet('settings',latest)) throw new Error('save failed');
      settings=latest;writeInitialCache(currentUserId);plannerOpen=false;
      render();showToast('התכנון נשמר והתחזית עודכנה');
    }catch(error){
      $('#planSaveStatus').textContent='התכנון לא נשמר. בדוק חיבור ונסה שוב; הערכים שהזנת נשארו כאן.';
      form.querySelectorAll('input,button').forEach(el=>el.disabled=false);
    }finally{plannerSaving=false;}
  });
}
function plannedTodayHint(){
  if(!settings.workPlan) return '';
  const h=AttendancePlanner.scheduled(settings.workPlan,new Date());
  return `<p class="lp-hint">${h?`בתכנון להיום: ${fmtHours(h)} שעות`:'היום לא מתוכננת משמרת — אפשר להיכנס כרגיל'}</p>`;
}

function departureHint(){
  const result=AttendancePlanner.departure(settings.workPlan,activeSession,settings.freeBreakMinutes);
  if(!result) return '';
  const target=`${fmtHours(result.target)} שעות${result.fallback?' (ברירת מחדל)':''}`;
  if(result.exceedsLimit) return 'השלמת היעד תחרוג ממגבלת משמרת של 16 שעות';
  if(result.reached) return `השלמת ${target} במשמרת הזו`;
  const clock=`${String(result.at.getHours()).padStart(2,'0')}:${String(result.at.getMinutes()).padStart(2,'0')}`;
  const tomorrow=AttendancePlanner.key(result.at)!==todayStr() ? ` ב־${result.at.getDate()}.${result.at.getMonth()+1}` : '';
  return `להשלמת ${target}: יציאה ב־${clock}${tomorrow}${result.onBreak?' · אם תחזור מההפסקה עכשיו':''}`;
}
