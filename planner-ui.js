// Planning never writes attendance entries or changes pay calculations.
let plannerOpen = false;
let plannerSaving = false;
const PLAN_DAYS = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
function planForecast(){
  return AttendancePlanner.forecast(settings.workPlan,currentDate,computeMonth().perDay,activeSession,new Date(),settings.freeBreakMinutes);
}
function planSummary(){
  const f=planForecast();
  const hasPlan=!!settings.workPlan;
  const status = !hasPlan ? 'הגדר את ימי העבודה כדי לראות תחזית' : f.gap>0.01 ? `חסרות ${fmtHours(f.gap)} שעות ליעד` : f.over>0.01 ? `${fmtHours(f.over)} שעות מעל היעד` : 'התכנון מגיע ליעד';
  const extraMinutes = Math.ceil(f.perShift * 60);
  const extraLabel = extraMinutes >= 60 ? `${Math.floor(extraMinutes/60)} שעות${extraMinutes%60 ? ` ו־${extraMinutes%60} דקות` : ''}` : `${extraMinutes} דקות`;
  const tooLong = f.perShift && f.rows.some(r=>r.status==='planned' && r.hours+f.perShift>16);
  const suggestion = hasPlan && f.gap>0.01 ? f.editable ? `כדי להשלים: עוד ${extraLabel} בממוצע בכל אחת מ־${f.editable} המשמרות שטרם התחילו. אפשר גם להוסיף יום עבודה.` : 'אין עוד משמרות מתוכננות להשלמה. אפשר להוסיף תאריכים בתכנון.' : '';
  return `<div class="plan-heading"><h2>בדרך ל־${fmtHours(f.target)} שעות</h2><span>${HE_MONTHS[currentDate.getMonth()]} ${currentDate.getFullYear()}</span></div>
    <div class="plan-total"><strong>${fmtHours(f.projected)}</strong><span>שעות צפויות בסוף החודש</span></div>
    <p class="plan-status">${status}</p>
    <div class="plan-meter" role="progressbar" aria-label="תחזית לעומת היעד" aria-valuemin="0" aria-valuemax="${f.target}" aria-valuenow="${Math.min(f.target,f.projected)}"><span style="width:${Math.min(100,100*f.actual/f.target)}%"></span><span class="planned" style="width:${Math.min(100-Math.min(100,100*f.actual/f.target),100*(f.planned+f.activeEstimate)/f.target)}%"></span></div>
    <p class="plan-note">נרשמו ${fmtHours(f.actual)} ש׳ · בתכנון ${fmtHours(f.planned)} ש׳${f.activeEstimate ? ` · משמרת פעילה: כ־${fmtHours(f.activeEstimate)} ש׳ בסיומה` : ''}</p>
    ${suggestion ? `<p>${suggestion}</p>` : ''}
    ${tooLong ? '<p class="plan-alert">חלוקה שווה תיצור משמרת ארוכה מ־16 שעות. יש להוסיף ימי עבודה או לשנות את החלוקה.</p>' : ''}
    ${f.projected>settings.monthlyCap ? `<p class="plan-alert">התחזית עוברת את תקרת התשלום (${fmtHours(settings.monthlyCap)} ש׳) ב־${fmtHours(f.projected-settings.monthlyCap)} ש׳.</p>` : ''}
    ${f.missed ? `<p class="plan-note">${f.missed} ימים מתוכננים שכבר עברו ללא רישום לא נכללו בתחזית.</p>` : ''}
    ${f.unresolved ? '<p class="plan-alert">יש משמרת פתוחה שדורשת תיקון; היא לא נכללה בתחזית.</p>' : ''}
    ${f.activeEstimate ? '<p class="plan-note">המשמרת הפעילה נאמדת לפי התכנון או השעות שנצברו, הגבוה מביניהם. השכר מתעדכן רק בסגירתה.</p>' : ''}`;
}
function buildPlanner(){
  const p=AttendancePlanner.normalize(settings.workPlan), today=todayStr();
  const rows=[];
  for(let day=1;day<=new Date(currentDate.getFullYear(),currentDate.getMonth()+1,0).getDate();day++){
    const date=new Date(currentDate.getFullYear(),currentDate.getMonth(),day,12), d=AttendancePlanner.key(date);
    if(d<today || monthData.days[d] || activeSession?.date===d) continue;
    rows.push(`<label class="plan-date-row"><span>${day}.${date.getMonth()+1} · ${PLAN_DAYS[date.getDay()]}</span><input type="number" data-plan-date="${d}" min="0" max="16" step="0.25" inputmode="decimal" placeholder="${p.weekly[date.getDay()]}" value="${Object.hasOwn(p.overrides,d)?p.overrides[d]:''}" aria-label="שעות בתאריך ${d}"></label>`);
  }
  return `<section class="ledger-card plan-card"><div id="planSummary">${planSummary()}</div>
    <details id="plannerDetails" ${plannerOpen?'open':''}><summary>תכנון ימי העבודה</summary>
    <form id="plannerForm"><label class="plan-target">יעד שעות חודשי<input id="planTarget" type="number" min="1" max="744" step="0.25" value="${p.target}" required></label>
    <p class="plan-note">שעות שייספרו לאחר ניכוי הפסקות, עד 16 שעות למשמרת. 0 = לא עובד. חגים וחופשות יש לעדכן ידנית.</p>
    <div class="plan-week">${PLAN_DAYS.map((name,i)=>`<label><span>${name}</span><input type="number" data-plan-day="${i}" min="0" max="16" step="0.25" inputmode="decimal" value="${p.weekly[i]}" required aria-label="שעות ביום ${name}"></label>`).join('')}</div>
    <details><summary>שינויים נקודתיים לחודש הזה</summary><p class="plan-note">ריק = לפי השבוע הקבוע · 0 = חופש. רישומים קיימים ומשמרת פעילה אינם ניתנים לשינוי כאן.</p><div class="plan-dates">${rows.join('')||'<p>אין תאריכים פנויים לתכנון בחודש הזה.</p>'}</div></details>
    <p class="plan-note">השבוע הקבוע והיעד חלים על כל החודשים. שינוי תאריך חל רק עליו. התכנון אינו רישום נוכחות.</p>
    <div class="plan-actions"><button type="submit">שמור תכנון</button><button type="button" id="planCancel">ביטול</button></div><p id="planSaveStatus" role="status"></p>
    </form></details></section>`;
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
