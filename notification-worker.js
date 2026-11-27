
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch {}
  const allowed = ['dashboard','wellness','food','exercise','finance','screentime','todo'];
  const target = allowed.includes(payload.tab) ? payload.tab : 'dashboard';
  event.waitUntil(self.registration.showNotification(payload.title || 'Beaty ❤️', {
    body: payload.body || 'Time to check your habits!',
    tag: String(payload.tag || 'beaty-reminder'),
    data: { target },
    badge: '/beaty-badge.svg',
    icon: '/beaty-badge.svg'
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const allowed = ['dashboard','wellness','food','exercise','finance','screentime','todo'];
  const target = allowed.includes(event.notification.data?.target) ? event.notification.data.target : 'dashboard';
  const url = new URL('/#' + target, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.navigate(url); await client.focus(); return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
