import { bootstrap, loadPlatformEnvironment } from '@app/common';
loadPlatformEnvironment('product');
const { ProductServiceModule } = await import('./product-service.module.js');
await bootstrap('product', ProductServiceModule);
