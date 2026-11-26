(function(){
  const release=window.AttendanceRelease;
  let registration=null,changedController=false,requested=false,checking=false;
  let hadController=!!navigator.serviceWorker?.controller;
  const $=id=>document.getElementById(id);
  function safe(){return !window.isUpdateSafe||window.isUpdateSafe();}
  function banner(){const el=$('updateBanner');if(!el)return;el.hidden=!(registration?.waiting||changedController);}
  function status(text){if($('updateStatus'))$('updateStatus').textContent=text;}
  function observe(reg){
    registration=reg;banner();
    reg.addEventListener('updatefound',()=>{const worker=reg.installing;if(!worker)return;worker.addEventListener('statechange',()=>{if(worker.state==='installed')banner();});});
  }
  async function check(){
    if(checking)return;checking=true;status('בודק עדכונים…');if($('checkUpdatesBtn'))$('checkUpdatesBtn').disabled=true;
    try{if(!registration)throw Error('unsupported');await registration.update();banner();status(registration.waiting?'עדכון חדש מוכן להתקנה':'הבדיקה הסתיימה. עדכון חדש יוצג כשיהיה מוכן.');}
    catch(e){status('לא ניתן לבדוק עדכונים כרגע. נסה שוב עם חיבור לרשת.');}
    finally{checking=false;if($('checkUpdatesBtn'))$('checkUpdatesBtn').disabled=false;}
  }
  function install(){
    if(!safe()){status('שמור או בטל את השינויים הפתוחים לפני העדכון.');if(typeof showToast==='function')showToast('שמור או בטל את השינויים הפתוחים לפני העדכון');return;}
    if(changedController&&!registration?.waiting){location.reload();return;}
    if(!registration?.waiting)return;
    requested=true;$('installUpdateBtn').disabled=true;$('installUpdateBtn').textContent='מעדכן…';
    registration.waiting.postMessage({type:'SKIP_WAITING'});
  }
  window.showReleaseNotes=function(){
    const host=$('releaseNotes');if(!host)return;
    host.querySelector('h2').textContent=`מה חדש בגרסה ${release.version}`;
    const list=host.querySelector('ul');list.replaceChildren();for(const note of release.notes){const item=document.createElement('li');item.textContent=note;list.appendChild(item);}
    host.hidden=false;$('closeReleaseNotes').focus();
  };
  window.showReleaseNotesOnce=function(){
    try{const key=`attendance_release_seen:${release.version}:${release.build}`;if(localStorage.getItem(key))return;localStorage.setItem(key,'1');window.showReleaseNotes();}catch(e){}
  };
  function init(){
    document.querySelectorAll('[data-app-version]').forEach(el=>el.textContent=`גרסה ${release.version} · בנייה ${release.build}`);
    $('installUpdateBtn')?.addEventListener('click',install);
    $('checkUpdatesBtn')?.addEventListener('click',check);
    $('whatsNewBtn')?.addEventListener('click',window.showReleaseNotes);
    $('closeReleaseNotes')?.addEventListener('click',()=>{$('releaseNotes').hidden=true;$('whatsNewBtn')?.focus();});
    $('releaseNotes')?.addEventListener('click',ev=>{if(ev.target===$('releaseNotes'))$('releaseNotes').hidden=true;});
    document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&$('releaseNotes'))$('releaseNotes').hidden=true;});
    if(!('serviceWorker' in navigator)){status('עדכונים ייטענו בפתיחה הבאה של האפליקציה.');return;}
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(!hadController){hadController=true;return;}
      changedController=true;
      // Only the tab whose user chose Install may reload, and only while still safe.
      if(requested&&safe())location.reload();else{requested=false;if($('installUpdateBtn')){$('installUpdateBtn').disabled=false;$('installUpdateBtn').textContent='עדכן עכשיו';}banner();}
    });
    (window.__attendanceSwRegistrationPromise||navigator.serviceWorker.getRegistration()).then(reg=>{if(reg)observe(reg);}).catch(()=>status('לא ניתן לבדוק עדכונים כרגע.'));
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&registration)registration.update().catch(()=>{});});
  }
  init();
})();
