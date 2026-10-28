import { bootstrap, loadPlatformEnvironment } from '@app/common';
loadPlatformEnvironment('notification');
const { NotificationServiceModule } =
  await import('./notification-service.module.js');
await bootstrap('notification', NotificationServiceModule);
