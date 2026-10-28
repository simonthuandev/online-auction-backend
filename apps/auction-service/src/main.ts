import { bootstrap, loadPlatformEnvironment } from '@app/common';
loadPlatformEnvironment('auction');
const { AuctionServiceModule } = await import('./auction-service.module.js');
await bootstrap('auction', AuctionServiceModule);
