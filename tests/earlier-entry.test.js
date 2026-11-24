const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const C=require('../calc.js');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
const clock=source.slice(source.indexOf('async function clockIn('),source.indexOf('async function startBreak('));
function harness(options={}){
 const saved=[];
 const c=vm.createContext({activeSession:options.active||null,earlierEntryDraft:{time:'08:00'},AttendanceCalc:C,
 runShiftAction:async fn=>fn({date:'2026-11-23',time:'09:00',at:new Date(2026,10,23,9).getTime()}),
 kvGetStrict:async()=>options.recorded?{days:{'2026-11-23':{in:'07:00',out:'08:00'}}}:null,
 saveActiveSession:async()=>{if(options.fail)return false;saved.push(JSON.parse(JSON.stringify(c.activeSession)));return true;},
 cancelAttendanceReminderMessages:async()=>{},scheduleCheckOutReminders:async()=>{},refreshReceptionReminderSchedule:async()=>{},
 ATTENDANCE_REMINDER_MESSAGES:{checkIn:'in'},render(){},showToast(){},console});
 vm.runInContext(clock,c);return {c,saved};
}
test('earlier entry persists the selected time and starts a normal active session',async()=>{
 const {c,saved}=harness();await c.clockIn({date:'2026-11-23',time:'08:00'});
 assert.deepEqual(saved,[{date:'2026-11-23',checkIn:'08:00',breaks:[]}]);assert.equal(c.earlierEntryDraft,null);
});
test('normal entry still persists the time of the press',async()=>{
 const {c,saved}=harness();await c.clockIn();assert.equal(saved[0].checkIn,'09:00');
});
test('failed save preserves draft and does not leave a fake active shift',async()=>{
 const {c,saved}=harness({fail:true});await c.clockIn({date:'2026-11-23',time:'08:00'});
 assert.equal(c.activeSession,null);assert.equal(c.earlierEntryDraft.time,'08:00');assert.equal(saved.length,0);
});
test('existing active or recorded shift cannot be overwritten by earlier entry',async()=>{
 for(const options of [{active:{date:'2026-11-23',checkIn:'07:30',breaks:[]}},{recorded:true}]){
  const {c,saved}=harness(options);await c.clockIn({date:'2026-11-23',time:'08:00'});assert.equal(saved.length,0);
 }
});
