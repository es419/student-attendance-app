(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.AttendanceRecords=api;})(typeof self!=='undefined'?self:globalThis,function(){
  const clone=value=>value==null?null:JSON.parse(JSON.stringify(value));
  const canonical=v=>v&&typeof v==='object'?(Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]))):v;
  const equal=(a,b)=>JSON.stringify(canonical(a??null))===JSON.stringify(canonical(b??null));
  function formatHours(value,format='decimal'){
    const hours=Number(value);if(!Number.isFinite(hours))return '—';
    if(format==='clock'){const total=Math.round(Math.abs(hours)*60);return `${hours<0?'−':''}${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;}
    return hours.toLocaleString('he-IL',{minimumFractionDigits:1,maximumFractionDigits:1});
  }
  function matches(date,entry,hours,query='',filter='all'){
    const text=[date,date.split('-').reverse().join('.'),entry.note||'',entry.type==='sick'?'מחלה':'עבודה',entry.tag==='remote'?'מהבית':entry.tag==='holiday'?'בחג':''].join(' ').toLocaleLowerCase('he');
    if(query.trim()&&!text.includes(query.trim().toLocaleLowerCase('he')))return false;
    return filter==='all'||(filter==='sick'&&entry.type==='sick')||(filter==='overtime'&&(hours.ot125>0||hours.ot150>0))||(filter==='remote'&&entry.tag==='remote')||(filter==='notes'&&!!entry.note);
  }
  function recordChanges(month,before,{source='app',at=new Date().toISOString(),id}={}){
    const changes=[];const days=month.days||{};
    for(const date of new Set([...Object.keys(before||{}),...Object.keys(days)])){
      const a=before?.[date]||null,b=days[date]||null;
      if(equal(a,b))continue;
      changes.push({id:id||`${at}-${date}-${Math.random().toString(36).slice(2,10)}`,date,at,source,before:clone(a),after:clone(b)});
    }
    if(changes.length)month.history=[...(Array.isArray(month.history)?month.history:[]),...changes].slice(-500);
    return changes;
  }
  function restore(month,event,expected){
    if(!equal(month.days?.[event.date]||null,expected||null))throw new Error('הרישום השתנה מאז פתיחת ההיסטוריה. פתח אותה מחדש.');
    if(event.before)month.days[event.date]=clone(event.before);else delete month.days[event.date];
  }
  return {formatHours,matches,recordChanges,restore,equal};
});
