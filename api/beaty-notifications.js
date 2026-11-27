
import webpush from 'web-push';
import { get, put } from '@vercel/blob';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
const SUPABASE_URL="https://byuunpkkwxrvmgbjjczi.supabase.co";
const SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5dXVucGtrd3hydm1nYmpqY3ppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NTkzMTksImV4cCI6MjEwOTEzNTMxOX0.WbqWDSS9DW7SgsgNpQ7_dhH4L1dfZ9wH871qvftQmKg";
const REGISTRY='beaty-reminders/registry-v1.json';
const AUDIENCE='https://betterhabits-beta.vercel.app/api/beaty-notifications';
const ISSUER='https://token.actions.githubusercontent.com';
const JWKS=createRemoteJWKSet(new URL(ISSUER+'/.well-known/jwks'));
const KINDS=['sleep','water','calories','evening'];

function fail(message,status=400){return Object.assign(new Error(message),{status});}
function isReady(){return Boolean(process.env.PUSH_VAPID_PRIVATE_KEY && process.env.PUSH_VAPID_PUBLIC_KEY);}
function bearer(req){return (req.headers.authorization||'').match(/^Bearer (.+)$/)?.[1];}
async function authenticate(req){
  const token=bearer(req);
  if(!token) throw fail('Sign in required',401);
  const response=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{apikey:SUPABASE_ANON_KEY,Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});
  if(!response.ok) throw fail('Sign in required',401);
  const body=await response.json();
  if(!/^[a-f0-9-]{36}$/i.test(body.id||'')) throw fail('Sign in required',401);
  return body.id;
}
async function authorizeScheduler(req){
  const token=bearer(req);
  if(!token) throw fail('Unauthorized',401);
  try{
    const {payload}=await jwtVerify(token,JWKS,{issuer:ISSUER,audience:AUDIENCE});
    if(payload.repository_id!=='1431492036'||payload.ref!=='refs/heads/main'||
       payload.workflow_ref!=='thomasgueli376-alt/betterhabits/.github/workflows/beaty-reminders.yml@refs/heads/main'||
       !['schedule','workflow_dispatch'].includes(payload.event_name)) throw Error('Invalid scheduler');
  }catch{throw fail('Unauthorized',401);}
}
async function readRegistry(){
  const result=await get(REGISTRY,{access:'private',useCache:false});
  if(!result)return {data:{users:{}},etag:null};
  if(result.statusCode!==200)throw Error('Registry unavailable');
  return {data:JSON.parse(await new Response(result.stream).text()),etag:result.blob.etag};
}
async function mutate(fn){
  for(let attempt=0;attempt<5;attempt++){
    const {data,etag}=await readRegistry();
    const result=fn(data);
    if(!result.changed)return result.value;
    try{
      await put(REGISTRY,JSON.stringify(data),{access:'private',addRandomSuffix:false,allowOverwrite:!!etag,...(etag?{ifMatch:etag}:{}),contentType:'application/json',cacheControlMaxAge:60});
      return result.value;
    }catch(error){
      if(!/Precondition|AlreadyExists|already exists/i.test(error.name+' '+error.message)||attempt===4)throw error;
    }
  }
}
function endpointId(endpoint){return createHash('sha256').update(endpoint).digest('hex');}
function trustedEndpoint(endpoint){
  try{
    const url=new URL(endpoint);
    return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&(
      url.hostname==='web.push.apple.com'||url.hostname.endsWith('.push.apple.com')||
      url.hostname==='fcm.googleapis.com'||url.hostname==='updates.push.services.mozilla.com'||url.hostname.endsWith('.notify.windows.com')
    );
  }catch{return false;}
}
function validateSubscription(sub){
  if(!sub||typeof sub.endpoint!=='string'||sub.endpoint.length>2048||!trustedEndpoint(sub.endpoint)||
     !/^[A-Za-z0-9_-]{86,90}$/.test(sub.keys?.p256dh||'')||!/^[A-Za-z0-9_-]{20,25}$/.test(sub.keys?.auth||''))throw fail('Invalid push subscription');
  return {endpoint:sub.endpoint,keys:{p256dh:sub.keys.p256dh,auth:sub.keys.auth}};
}
function validTime(time){return typeof time==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time);}
function validDay(day){return typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day);}
function bounded(number,fallback,max){return Number.isFinite(Number(number))?Math.max(0,Math.min(Number(number),max)):fallback;}
function validateSettings(settings){
  if(!settings||typeof settings!=='object')throw fail('Invalid reminder settings');
  const output={};
  for(const kind of KINDS){
    const item=settings[kind];
    if(!item||typeof item.enabled!=='boolean'||(kind!=='sleep'&&!validTime(item.time)))throw fail('Invalid reminder time');
    output[kind]={enabled:item.enabled,...(kind==='sleep'?{}:{time:item.time})};
  }
  return output;
}
function normalizeSnapshot(s){
  if(!s||!validDay(s.day)||typeof s.timeZone!=='string'||s.timeZone.length>100)throw fail('Invalid habit summary');
  try{new Intl.DateTimeFormat('en-US',{timeZone:s.timeZone});}catch{throw fail('Invalid time zone');}
  const protection=s.protection||{};
  const changes=kind=>(Array.isArray(protection[kind])?protection[kind]:[]).filter(x=>validDay(x?.day)&&typeof x.enabled==='boolean').slice(-100).map(x=>({day:x.day,enabled:x.enabled}));
  return {
    day:s.day,timeZone:s.timeZone,calorieGoal:Math.max(1,bounded(s.calorieGoal,2000,20000)),calories:bounded(s.calories,0,50000),
    waterGoal:Math.max(1,bounded(s.waterGoal,64,1000)),water:bounded(s.water,0,1000),slept:s.slept===true,
    wakeTime:validTime(s.wakeTime)?s.wakeTime:'06:30',heartFull:s.heartFull===true,heartFill:bounded(s.heartFill,0,100),
    protection:{holidayChanges:changes('holidayChanges'),vacationChanges:changes('vacationChanges'),vacations:(Array.isArray(protection.vacations)?protection.vacations:[]).filter(validDay).slice(-100)}
  };
}
function localClock(now,timeZone){
  const values=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return {day:values.year+'-'+values.month+'-'+values.day,minute:Number(values.hour)*60+Number(values.minute)};
}
function dateKey(d){return d.toISOString().slice(0,10);}
function dateOffset(day,n){const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return dateKey(d);}
function federalHolidays(year){
  const days=new Set();
  const fixed=(month,day)=>{
    const d=new Date(Date.UTC(year,month-1,day,12));const key=dateKey(d);days.add(key);
    if(d.getUTCDay()===6)days.add(dateOffset(key,-1));if(d.getUTCDay()===0)days.add(dateOffset(key,1));
  };
  const nth=(month,weekday,n)=>{
    const d=new Date(Date.UTC(year,month-1,1,12));d.setUTCDate(1+(weekday-d.getUTCDay()+7)%7+(n-1)*7);days.add(dateKey(d));
  };
  fixed(1,1);nth(1,1,3);nth(2,1,3);
  const memorial=new Date(Date.UTC(year,5,0,12));memorial.setUTCDate(memorial.getUTCDate()-(memorial.getUTCDay()+6)%7);days.add(dateKey(memorial));
  if(year>=2021)fixed(6,19);fixed(7,4);nth(9,1,1);nth(10,1,2);fixed(11,11);nth(11,4,4);fixed(12,25);
  return days;
}
function protectedDay(snapshot,day){
  const p=snapshot.protection;
  const enabled=changes=>changes.filter(x=>x.day<=day).sort((a,b)=>a.day.localeCompare(b.day)).pop()?.enabled===true;
  const y=Number(day.slice(0,4));
  return (enabled(p.holidayChanges)&&[y-1,y,y+1].some(v=>federalHolidays(v).has(day)))||
    (enabled(p.vacationChanges)&&p.vacations.includes(day));
}
function notification(kind,snapshot,day){
  const same=snapshot.day===day;
  const n=Math.round;
  if(kind==='sleep')return same&&snapshot.slept?null:{body:'Good morning! How did you sleep? Log last night’s sleep when you’re ready.',tab:'wellness'};
  if(kind==='water'){
    const water=same?snapshot.water:0,goal=snapshot.waterGoal;
    if(water>=goal)return null;
    return {body:water===0?'Have you had any water today? Let’s get that first glass in!':'You’ve logged '+n(water)+' oz of water. '+n(goal-water)+' oz left toward your goal!',tab:'wellness'};
  }
  if(kind==='calories'){
    const left=snapshot.calorieGoal-(same?snapshot.calories:0);
    return {body:left>=0?'You have about '+n(left)+' calories remaining today. Remember to log your meals!':'You’re about '+n(-left)+' calories above your daily goal. Keep logging and take care of yourself.',tab:'food'};
  }
  if(same&&snapshot.heartFull)return null;
  return {body:'Your heart is '+n(same?snapshot.heartFill:0)+'% full. Log any unfinished habits and check in with Beaty!',tab:'dashboard'};
}
function due(snapshot,device,now){
  const clock=localClock(now,device.timeZone||snapshot.timeZone);
  if(protectedDay(snapshot,clock.day))return [];
  return KINDS.flatMap(kind=>{
    const setting=device.settings[kind];
    if(!setting.enabled||device.lastSent?.[kind]===clock.day)return [];
    const time=kind==='sleep'?snapshot.wakeTime:setting.time;
    const [h,m]=time.split(':').map(Number);const delay=clock.minute-(h*60+m);
    const message=delay>=0&&delay<25?notification(kind,snapshot,clock.day):null;
    return message?[{kind,day:clock.day,message:{title:'Beaty ❤️',...message,tag:'beaty-'+kind+'-'+clock.day}}]:[];
  });
}
async function send(subscription,message){
  await webpush.sendNotification(subscription,JSON.stringify(message),{TTL:1800,timeout:8000,vapidDetails:{
    subject:'https://betterhabits-beta.vercel.app/',publicKey:process.env.PUSH_VAPID_PUBLIC_KEY,privateKey:process.env.PUSH_VAPID_PRIVATE_KEY
  }});
}
async function dispatch(){
  const now=new Date();
  const claims=await mutate(data=>{
    const items=[];
    for(const [uid,user] of Object.entries(data.users))for(const [id,device] of Object.entries(user.devices)){
      for(const job of due(user.snapshot,device,now)){
        device.lastSent ||= {};
        device.lastSent[job.kind]=job.day;
        items.push({...job,uid,id,subscription:device.subscription});
      }
    }
    return {changed:items.length>0,value:items};
  });
  let successes=0;
  for(const job of claims){
    try{await send(job.subscription,job.message);successes++;}
    catch(error){
      const code=Number(error.statusCode);
      await mutate(data=>{
        const user=data.users[job.uid],device=user?.devices[job.id];
        if(!device)return {changed:false};
        if(code===404||code===410){
          delete user.devices[job.id];
          if(!Object.keys(user.devices).length)delete data.users[job.uid];
        }else if(device.lastSent?.[job.kind]===job.day){
          delete device.lastSent[job.kind]; // a later scheduled poll can retry
        }else return {changed:false};
        return {changed:true};
      });
    }
  }
  return {attempted:claims.length,sent:successes};
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  try{
    const {action,endpoint,...body}=req.body||{};
    if(action==='dispatch'){
      await authorizeScheduler(req);
      if(!isReady())throw fail('Notification delivery not configured',503);
      return res.status(200).json(await dispatch());
    }
    const uid=await authenticate(req);
    const id=typeof endpoint==='string'&&endpoint.length<=2048?endpointId(endpoint):null;
    if(action==='status'){
      if(!isReady())return res.status(200).json({ready:false,hasDevices:false});
      const {data}=await readRegistry(),user=data.users[uid],device=id&&user?.devices[id];
      return res.status(200).json({ready:true,publicKey:process.env.PUSH_VAPID_PUBLIC_KEY,hasDevices:!!user&&Object.keys(user.devices).length>0,device:device?{settings:device.settings}:null});
    }
    if(!isReady())throw fail('Notification delivery not configured',503);
    if(action==='save'){
      const subscription=validateSubscription(body.subscription),settings=validateSettings(body.settings),snapshot=normalizeSnapshot(body.snapshot),key=endpointId(subscription.endpoint);
      await mutate(data=>{
        const user=data.users[uid]||{devices:{},snapshot};
        if(!data.users[uid]&&Object.keys(data.users).length>=100)throw fail('Reminder capacity reached',503);
        if(!user.devices[key]&&Object.keys(user.devices).length>=5)throw fail('Too many reminder devices');
        for(const [otherId,other] of Object.entries(data.users)){
          if(otherId!==uid&&other.devices[key]){delete other.devices[key];if(!Object.keys(other.devices).length)delete data.users[otherId];}
        }
        user.snapshot=snapshot;
        user.devices[key]={subscription,settings,timeZone:snapshot.timeZone,lastSent:user.devices[key]?.lastSent||{},lastTest:user.devices[key]?.lastTest||0};
        data.users[uid]=user;return {changed:true};
      });
      return res.status(200).json({saved:true});
    }
    if(action==='snapshot'){
      const snapshot=normalizeSnapshot(body.snapshot);
      await mutate(data=>{
        const user=data.users[uid];if(!user||JSON.stringify(user.snapshot)===JSON.stringify(snapshot))return {changed:false};
        user.snapshot=snapshot;return {changed:true};
      });return res.status(200).json({saved:true});
    }
    if(action==='disable'){
      if(!id)throw fail('Invalid device');
      const hasDevices=await mutate(data=>{
        const user=data.users[uid];if(!user?.devices[id])return {changed:false,value:!!user&&Object.keys(user.devices).length>0};
        delete user.devices[id];const hasDevices=Object.keys(user.devices).length>0;
        if(!hasDevices)delete data.users[uid];
        return {changed:true,value:hasDevices};
      });return res.status(200).json({disabled:true,hasDevices});
    }
    if(action==='test'){
      const sub=await mutate(data=>{
        const device=id&&data.users[uid]?.devices[id];
        if(!device)throw fail('Unknown reminder device',404);
        if(Date.now()-device.lastTest<60000)throw fail('Please wait a minute before another test',429);
        device.lastTest=Date.now();return {changed:true,value:device.subscription};
      });
      try{await send(sub,{title:'Beaty ❤️',body:'Notifications are working! I’ll keep you on track.',tab:'dashboard',tag:'beaty-test'});}
      catch{throw fail('Could not deliver a test notification. Try again.',502);}
      return res.status(200).json({sent:true});
    }
    throw fail('Invalid action');
  }catch(error){console.warn('Beaty notifications request failed',error.status||500);return res.status(error.status||503).json({error:error.status?error.message:'Reminder service unavailable'});}
}
