(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.AttendanceReport=api;})(typeof self!=='undefined'?self:globalThis,function(){
  // JPEG pages keep Hebrew shaping identical to the browser, including RTL notes.
  // Standard PDF image objects, byte offsets and xref table; no external service.
  function pdfFromJpegs(pages){
    const encode=s=>new TextEncoder().encode(s),chunks=[],offsets=[0];let position=0;
    const add=b=>{chunks.push(b);position+=b.length;};const text=s=>add(encode(s));
    text('%PDF-1.4\n');const count=2+pages.length*3;
    const object=(id,body)=>{offsets[id]=position;text(`${id} 0 obj\n${body}\nendobj\n`);};
    object(1,'<< /Type /Catalog /Pages 2 0 R >>');
    object(2,`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i)=>`${3+i*3} 0 R`).join(' ')}] >>`);
    pages.forEach((page,i)=>{
      const p=3+i*3,img=p+1,stream=p+2;
      object(p,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${stream} 0 R >>`);
      offsets[img]=position;text(`${img} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`);add(page.bytes);text('\nendstream\nendobj\n');
      const commands='q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n';
      object(stream,`<< /Length ${encode(commands).length} >>\nstream\n${commands}endstream`);
    });
    const xref=position;text(`xref\n0 ${count+1}\n0000000000 65535 f \n`);
    for(let i=1;i<=count;i++)text(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`);
    text(`trailer\n<< /Size ${count+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const output=new Uint8Array(position);let at=0;for(const b of chunks){output.set(b,at);at+=b.length;}return output;
  }
  async function create({label,days,calc,formatHours,formatMoney,tagLabels}){
    await document.fonts?.ready;
    const dates=Object.keys(days).sort(),rows=dates.map(date=>({date,entry:days[date],hours:calc.perDay[date]}));
    const groups=[];for(let i=0;i<rows.length;i+=13)groups.push(rows.slice(i,i+13));if(!groups.length)groups.push([]);
    const pages=[];
    for(let n=0;n<groups.length;n++){
      const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=2036;
      const c=canvas.getContext('2d');if(!c)throw new Error('PDF rendering unavailable');
      c.fillStyle='#ffffff';c.fillRect(0,0,1440,2036);c.direction='rtl';c.textAlign='right';
      const txt=(s,x,y,size=26,color='#172b3a',align='right')=>{c.font=`${size>=38?'700':'400'} ${size}px Heebo, Arial`;c.fillStyle=color;c.textAlign=align;c.fillText(String(s),x,y);};
      c.fillStyle='#0e736e';c.fillRect(0,0,1440,14);txt('נוכחות+',1360,105,46);txt('דוח נוכחות חודשי',1360,155,30);txt(label,1360,202,30,'#567080');
      txt(`שעות: ${formatHours(calc.rawTotal)}`,1360,280,32);txt(`ברוטו משוער: ${formatMoney(calc.gross)}`,900,280,30);txt(`נטו משוער: ${formatMoney(calc.net)}`,470,280,30);
      c.fillStyle='#edf4f5';c.fillRect(70,325,1300,66);txt('תאריך',1340,368);txt('כניסה — יציאה',1080,368);txt('שעות',720,368);txt('שכר משוער',445,368);
      let y=440;
      for(const row of groups[n]){
        const {entry:e,hours:h}=row;txt(row.date.split('-').reverse().join('.'),1340,y,27);txt(e.type==='sick'?'מחלה':`${e.in} — ${e.out}`,1080,y,27);txt(formatHours(h.total),720,y,27);txt(formatMoney(h.pay),445,y,27);
        let note=[tagLabels[e.tag]||'',e.note||'',e.brk?`הפסקה: ${e.brk} דקות`:''].filter(Boolean).join(' · ');
        while(c.measureText(note).width>1220&&note.length>1)note=note.slice(0,-2);if(note)txt(note,1340,y+38,22,'#61727f');
        c.strokeStyle='#e2e9ed';c.beginPath();c.moveTo(70,y+61);c.lineTo(1370,y+61);c.stroke();y+=104;
      }
      if(!groups[n].length)txt('אין רישומים בחודש זה',1360,470,30);
      txt('נתוני השכר הם אומדן בהתאם להגדרות האפליקציה, ואינם תלוש שכר.',1360,1900,22,'#61727f');
      txt(`עמוד ${n+1} מתוך ${groups.length}`,1360,1960,22,'#61727f');txt(new Date().toLocaleDateString('he-IL'),80,1960,22,'#61727f','left');
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PDF page failed')),'image/jpeg',0.94));
      pages.push({bytes:new Uint8Array(await blob.arrayBuffer()),width:canvas.width,height:canvas.height});
    }
    return new Blob([pdfFromJpegs(pages)],{type:'application/pdf'});
  }
  return {pdfFromJpegs,create};
});
