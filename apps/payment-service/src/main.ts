import { bootstrap, loadPlatformEnvironment } from '@app/common';
loadPlatformEnvironment('payment');
const { PaymentServiceModule } = await import('./payment-service.module.js');
await bootstrap('payment', PaymentServiceModule);
