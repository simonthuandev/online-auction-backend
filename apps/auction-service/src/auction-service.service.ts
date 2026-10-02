import { Injectable } from '@nestjs/common';

@Injectable()
export class AuctionServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
