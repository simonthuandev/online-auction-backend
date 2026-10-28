import { bootstrap, loadPlatformEnvironment } from '@app/common';
loadPlatformEnvironment('order');
const { OrderServiceModule } = await import('./order-service.module.js');
await bootstrap('order', OrderServiceModule);
