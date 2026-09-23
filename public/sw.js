/* Notifications only. Deliberately never caches authenticated pages or guest data. */
self.addEventListener('push',event=>{let data;try{data=event.data.json()}catch{return}event.waitUntil(self.registration.showNotification(String(data.title||'Airbnb Automation'),{body:String(data.body||''),icon:'/favicon.svg',data:{href:typeof data.href==='string'&&data.href.startsWith('/')&&!data.href.startsWith('//')?data.href:'/calendar'}}))});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(clients.openWindow(event.notification.data.href))});
