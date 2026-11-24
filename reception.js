// Dated assignments only. Jerusalem time is independent of the device timezone.
(function(root){
  'use strict';
  const ZONE='Asia/Jerusalem';
  const PREFIX='👔 קבלת קהל · ';
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function parts(at){return Object.fromEntries(formatter.formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
  function dateKey(at=new Date()){const p=parts(at);return `${p.year}-${p.month}-${p.day}`;}
  function validDate(value){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value||'')) return false;
    const d=new Date(`${value}T12:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===value;
  }
  function minutes(value){return /^([01]\d|2[0-3]):[0-5]\d$/.test(value||'') ? Number(value.slice(0,2))*60+Number(value.slice(3)) : null;}
  function clock(value){return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;}
  function normalize(value){
    const v=value && typeof value==='object' ? value : {};
    if(v.mode!=='morning' && v.mode!=='afternoon') return null;
    return {mode:v.mode,readyTime:minutes(v.readyTime)!==null?v.readyTime:'07:00',
      travelMinutes:Number.isInteger(v.travelMinutes)&&v.travelMinutes>=0&&v.travelMinutes<=240?v.travelMinutes:45,
      bufferMinutes:Number.isInteger(v.bufferMinutes)&&v.bufferMinutes>=0&&v.bufferMinutes<=120?v.bufferMinutes:15,
      reminders:v.reminders!==false};
  }
  function departure(value){const a=normalize(value);return a?.mode==='morning' ? clock(510-a.travelMinutes-a.bufferMinutes) : null;}
  function validation(date,value){
    if(!validDate(date)) return 'בחר תאריך תקין';
    const a=normalize(value);
    if(!a) return 'בחר בוקר או אחר הצהריים';
    if(minutes(value.readyTime)===null) return 'בחר שעת התארגנות תקינה';
    if(!Number.isInteger(value.travelMinutes)||value.travelMinutes<0||value.travelMinutes>240 || !Number.isInteger(value.bufferMinutes)||value.bufferMinutes<0||value.bufferMinutes>120) return 'בדוק את זמן הנסיעה ומרווח הביטחון';
    if(a.mode==='morning' && minutes(a.readyTime)>=minutes(departure(a))) return 'תזכורת ההתארגנות צריכה להיות לפני שעת היציאה';
    if(a.mode==='afternoon' && minutes(a.readyTime)>=900) return 'תזכורת הלבוש צריכה להיות לפני 15:00';
    return null;
  }
  function at(date,time){
    if(!validDate(date)||minutes(time)===null) return null;
    const target=Date.parse(`${date}T${time}:00Z`);
    let result=target;
    for(let i=0;i<3;i++){
      const p=parts(new Date(result));
      const actual=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
      result+=target-actual;
    }
    // Reject a nonexistent local time on the spring clock change.
    const p=parts(new Date(result));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===`${date}T${time}` ? new Date(result) : null;
  }
  function summary(value){return normalize(value)?.mode==='afternoon' ? '15:00–18:00' : 'הגעה עד 08:30';}
  function reminders(assignments,now=new Date(),arrivedDate=null){
    const rows=[];
    for(const [date,raw] of Object.entries(assignments||{})){
      const a=normalize(raw);
      if(!a || !validDate(date) || date<dateKey(now) || date===arrivedDate || !a.reminders || validation(date,a)) continue;
      const stages=[['ready',a.readyTime,`היום קבלת קהל — לזכור לבוש מתאים · ${summary(a)}`]];
      if(a.mode==='morning') stages.push(['leave',departure(a),'זמן לצאת לעבודה · קבלת קהל היום · הגעה עד 08:30']);
      for(const [stage,time,text] of stages){
        const when=at(date,time);
        if(when && when>now) rows.push({date,stage,fire_at:when.toISOString(),message:`${PREFIX}${date} · ${text}`});
      }
    }
    return rows.sort((a,b)=>a.fire_at.localeCompare(b.fire_at));
  }
  // Sent stages retain their ID when the time or session changes: never replay them.
  async function reminderId(userId,date,stage){
    const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(`attendance/reception/v1/${userId}/${date}/${stage}`));
    const bytes=new Uint8Array(digest).slice(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
    const h=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }
  function diff(existing,desired){
    const byId=new Map(existing.map(row=>[row.id,row])), wanted=new Set(desired.map(row=>row.id));
    return {
      remove:existing.filter(row=>!row.sent&&!wanted.has(row.id)).map(row=>row.id),
      insert:desired.filter(row=>!byId.has(row.id)),
      update:desired.filter(row=>{const old=byId.get(row.id);return old&&!old.sent&&(Date.parse(old.fire_at)!==Date.parse(row.fire_at)||old.message!==row.message);})
    };
  }
  const api={PREFIX,dateKey,validDate,minutes,normalize,departure,validation,at,summary,reminders,reminderId,diff};
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
  else root.AttendanceReception=api;
})(typeof window!=='undefined'?window:globalThis);
