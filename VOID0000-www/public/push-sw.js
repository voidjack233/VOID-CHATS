self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {
    title: 'VOID',
    body: 'New activity',
    tag: 'void-notification',
    url: '/chats',
  };

  if (event.data) {
    try {
      payload = {
        ...payload,
        ...event.data.json(),
      };
    } catch {
      payload.body = event.data.text() || payload.body;
    }
  }

  const title = payload.title || 'VOID';
  const options = {
    body: payload.body || 'Open VOID to check it.',
    tag: payload.tag || 'void-notification',
    icon: '/VOID.png',
    badge: '/VOID.png',
    data: {
      url: payload.url || '/chats',
      type: payload.type || 'activity',
      conversation_id: payload.conversation_id || null,
      conversation_public_id: payload.conversation_public_id || null,
    },
  };

  event.waitUntil((async () => {
    const windows = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    const hasFocusedVoidWindow = windows.some((client) => {
      try {
        return client.focused && new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });

    if (hasFocusedVoidWindow && payload.type === 'message') {
      return;
    }

    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data?.url || '/chats', self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          await client.navigate(targetUrl);
        }
        return;
      }
    }

    await clients.openWindow(targetUrl);
  })());
});
