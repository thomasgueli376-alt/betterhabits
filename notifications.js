
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const reminders = ['sleep', 'water', 'calories', 'evening'];
  let registration = null, session = null, localSubscription = null, active = false;
  let backendReady = false, hasDevices = false, busy = false, timer = null, lastSnapshot = '';
  const status = text => { byId('notification-status').textContent = text; };
  function controls() {
    byId('notify-enable').disabled = busy || !backendReady || !session || !registration || active || (typeof Notification !== 'undefined' && Notification.permission === 'denied');
    byId('notify-save').disabled = busy || !active;
    byId('notify-test').disabled = busy || !active;
    byId('notify-disable').disabled = busy || !active;
  }
  function readSettings() {
    return Object.fromEntries(reminders.map(name => [name, {
      enabled: byId('notify-' + name).checked,
      ...(name === 'sleep' ? {} : { time: byId('notify-' + name + '-time').value })
    }]));
  }
  function applySettings(settings) {
    for (const name of reminders) {
      if (!settings?.[name]) continue;
      byId('notify-' + name).checked = settings[name].enabled === true;
      if (name !== 'sleep' && /^\d{2}:\d{2}$/.test(settings[name].time || '')) byId('notify-' + name + '-time').value = settings[name].time;
    }
  }
  function snapshot() {
    const day = localDay();
    const today = new Date().toLocaleDateString();
    return {
      day, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      calorieGoal: Number(state.macroGoals?.cals || 2000),
      calories: state.lastActiveDate === today ? (state.foodLogs || []).reduce((total,item)=>total + (Number(item.cals)||0),0) : 0,
      waterGoal: Number(state.waterGoal || 64),
      water: state.lastWaterDate === today ? Number(state.todayWater || 0) : 0,
      slept: (state.sleepLogs || []).some(log=>logDay(log)===day),
      wakeTime: state.sleepGoals?.waketime || '06:30',
      heartFull: state.lastActiveDate === today && state.dailyHeartFull === true,
      heartFill: state.lastActiveDate === today ? Number(state.dailyHeartFill || 0) : 0,
      protection: state.habitProtection || {}
    };
  }
  async function request(action, body = {}) {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session) throw new Error('Sign in required');
    const response = await fetch('/api/beaty-notifications', { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token}, body:JSON.stringify({action,...body}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Reminders unavailable');
    return result;
  }
  function applicationKey(publicKey) {
    const raw = atob(publicKey.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-publicKey.length%4)%4));
    return Uint8Array.from(raw, c=>c.charCodeAt(0));
  }
  let publicKey = null;
  async function readiness() {
    try {
      const { data } = await supabaseClient.auth.getSession();
      session = data.session;
      if (!session) { backendReady=false; active=false; hasDevices=false; status('Sign in to enable reminders based on your saved goals.'); return; }
      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      if (supported) {
        registration = await navigator.serviceWorker.register('/notification-worker.js');
        await navigator.serviceWorker.ready;
        localSubscription = await registration.pushManager.getSubscription();
      }
      const result = await request('status',{endpoint:localSubscription?.endpoint || ''});
      backendReady = result.ready;
      hasDevices = result.hasDevices;
      publicKey = result.publicKey;
      active = !!result.device && !!localSubscription;
      if (!backendReady) status('Notification scheduling is not available yet.');
      else if (!supported) status('On iPhone, add Good Habits to your Home Screen and open it there to enable reminders.');
      else if (active) { applySettings(result.device.settings); status('Notifications are enabled on this device.'); }
      else status(Notification.permission === 'denied' ? 'Notifications are blocked. Enable them in your phone’s notification settings.' : 'Turn on Beaty reminders for this device.');
      window.syncBeatyReminders();
    } catch (error) { backendReady=false; active=false; status('Unable to check reminder settings. Reopen Good Habits and try again.'); }
    finally { controls(); }
  }
  async function persist(subscription) {
    if (window.beatyCloudReadyUser !== session?.user.id) throw new Error('Your goals are still loading. Try again.');
    const settings=readSettings();
    for (const name of reminders.filter(n=>n!=='sleep')) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(settings[name].time)) throw new Error('Choose a valid time.');
    await request('save',{subscription:subscription.toJSON(),settings,snapshot:snapshot()});
    active=true; hasDevices=true; localSubscription=subscription; lastSnapshot=JSON.stringify(snapshot());
    status('Notifications are enabled and preferences saved.');
  }
  async function enable() {
    if (busy || !backendReady || !registration || !session || !publicKey) return;
    busy=true; controls();
    let created=null;
    try {
      const permission=await Notification.requestPermission();
      if(permission!=='granted'){status('Notification permission was not granted.');return;}
      let subscription=await registration.pushManager.getSubscription();
      if(!subscription){subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationKey(publicKey)});created=subscription;}
      await persist(subscription);
    } catch(error){if(created) await created.unsubscribe().catch(()=>{});status(error.message || 'Could not enable reminders.');}
    finally {busy=false;controls();}
  }
  async function save() {
    if(busy||!active||!localSubscription)return;
    busy=true;controls();
    try{await persist(localSubscription);}catch(error){status(error.message || 'Could not save preferences.');}
    finally{busy=false;controls();}
  }
  async function disable() {
    if(busy||!active||!localSubscription)return;
    busy=true;controls();
    try{
      const result=await request('disable',{endpoint:localSubscription.endpoint});
      await localSubscription.unsubscribe();
      active=false;localSubscription=null;hasDevices=result.hasDevices;status('Notifications turned off on this device.');
    }catch(error){status('Could not turn off reminders. Please try again.');}
    finally{busy=false;controls();}
  }
  async function test(){
    if(busy||!active)return;
    busy=true;controls();
    try{await request('test',{endpoint:localSubscription.endpoint});status('Test notification sent. Check your phone.');}
    catch(error){status(error.message || 'Test notification failed.');}
    finally{busy=false;controls();}
  }
  window.syncBeatyReminders=()=>{
    clearTimeout(timer);
    if(!backendReady||!hasDevices||window.beatyCloudReadyUser!==session?.user.id)return;
    timer=setTimeout(async()=>{
      const data=snapshot(), serialized=JSON.stringify(data);
      if(serialized===lastSnapshot)return;
      try{await request('snapshot',{snapshot:data});lastSnapshot=serialized;}
      catch(error){console.warn('Reminder snapshot sync failed');}
    },800);
  };
  window.stopBeatyNotifications=async()=>{
    clearTimeout(timer);
    try{
      const subscription=registration && await registration.pushManager.getSubscription();
      if(subscription){await request('disable',{endpoint:subscription.endpoint}).catch(()=>{});await subscription.unsubscribe();}
    }catch(error){console.warn('Reminder cleanup failed');}
  };
  function navigate(){
    const target=location.hash.slice(1);
    if(['dashboard','wellness','food','exercise','finance','screentime','todo'].includes(target)) switchTab(target);
  }
  document.addEventListener('DOMContentLoaded',()=>{
    if(!byId('notification-settings'))return;
    byId('notify-enable').addEventListener('click',enable);
    byId('notify-save').addEventListener('click',save);
    byId('notify-test').addEventListener('click',test);
    byId('notify-disable').addEventListener('click',disable);
    byId('notification-settings').addEventListener('toggle',()=>{if(byId('notification-settings').open&&!busy)readiness();});
    supabaseClient.auth.onAuthStateChange(()=>setTimeout(readiness,0));
    window.addEventListener('hashchange',navigate);
    readiness();navigate();
  });
})();
