import { bootstrap, loadPlatformEnvironment } from '@app/common';
loadPlatformEnvironment('auth');
const { AuthServiceModule } = await import('./auth-service.module.js');
await bootstrap('auth', AuthServiceModule);
