(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.AttendancePlanner = api;
})(typeof self !== 'undefined' ? self : globalThis, function(){
  const key = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const hours = value => Number.isFinite(Number(value)) ? Math.min(16, Math.max(0, Number(value))) : 0;
  function normalize(plan){
    return {
      target: Number.isFinite(Number(plan?.target)) && Number(plan.target)>0 ? Number(plan.target) : 120,
      weekly: Array.from({length:7}, (_,i) => hours(plan?.weekly?.[i])),
      overrides: Object.fromEntries(Object.entries(plan?.overrides || {}).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map(([d,h]) => [d,hours(h)]))
    };
  }
  function scheduled(plan,date){
    const p = normalize(plan);
    const d = key(date);
    return Object.hasOwn(p.overrides,d) ? p.overrides[d] : p.weekly[date.getDay()];
  }
  // Same paid-break allowance as dayHours; plans are credited hours, not gross presence.
  function departure(plan, session, freeBreakMinutes = 0, now = new Date()){
    if(!session) return null;
    const start = new Date(`${session.date}T${session.checkIn}:00`);
    const elapsed = (now.getTime()-start.getTime())/60000;
    if(!Number.isFinite(elapsed) || elapsed<0 || elapsed>960) return null;
    const planned = scheduled(plan,start);
    const target = planned>0 ? planned : 8;
    const minute = t => { const [h,m]=t.split(':').map(Number); return h*60+m; };
    const nowClock = `${now.getHours()}:${now.getMinutes()}`;
    const breaks=(session.breaks||[]).reduce((sum,b)=>sum+((minute(b.end||nowClock)-minute(b.start)+1440)%1440),0);
    const requiredMinutes=Math.ceil(target*60+Math.max(0,breaks-Math.max(0,Number(freeBreakMinutes)||0)));
    return {target, fallback:planned<=0, at:new Date(start.getTime()+requiredMinutes*60000), reached:elapsed>=requiredMinutes,
      onBreak:(session.breaks||[]).some(b=>!b.end), exceedsLimit:requiredMinutes>960};
  }
  function forecast(plan, selected, perDay, active, now = new Date(), freeBreakMinutes = 0){
    const p = normalize(plan), today = key(now), rows = [];
    const year=selected.getFullYear(), month=selected.getMonth();
    let actual=0, planned=0, activeEstimate=0, missed=0, unresolved=false;
    for(let day=1;day<=new Date(year,month+1,0).getDate();day++){
      const date = new Date(year,month,day,12), d=key(date), expected=scheduled(p,date);
      if(Object.hasOwn(perDay,d)){
        actual += Math.max(0, Number(perDay[d].total)||0);
        rows.push({date:d,hours:perDay[d].total,status:'actual'});
        continue;
      }
      if(active?.date === d){
        const start = new Date(`${active.date}T${active.checkIn}:00`).getTime();
        const elapsed=(now.getTime()-start)/60000;
        if(!Number.isFinite(elapsed) || elapsed<0 || elapsed>960){ unresolved=true; continue; }
        const minute = t => { const [h,m]=t.split(':').map(Number); return h*60+m; };
        const nowClock = `${now.getHours()}:${now.getMinutes()}`;
        const breaks=(active.breaks||[]).reduce((sum,b) => sum+((minute(b.end||nowClock)-minute(b.start)+1440)%1440),0);
        const worked=Math.max(0,elapsed-Math.max(0,breaks-freeBreakMinutes))/60;
        const estimate=Math.max(expected,worked);
        activeEstimate+=estimate;
        rows.push({date:d,hours:estimate,status:'active'});
      }else if(d>=today && expected>0){
        planned+=expected;
        rows.push({date:d,hours:expected,status:'planned'});
      }else if(d<today && expected>0){ missed++; }
    }
    const projected=actual+planned+activeEstimate;
    const gap=Math.max(0,p.target-projected);
    const editable=rows.filter(r=>r.status==='planned').length;
    return {actual,planned,activeEstimate,projected,gap,over:Math.max(0,projected-p.target),perShift:editable ? gap/editable : null,editable,missed,unresolved,rows,target:p.target};
  }
  return {normalize,scheduled,forecast,departure,key};
});
