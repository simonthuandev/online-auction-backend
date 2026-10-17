import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { HEADERS } from '../constants/headers.constant.js';

@Injectable()
export class GatewayAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const userId = request.headers[HEADERS.USER_ID];

    if (!userId) {
      throw new UnauthorizedException('Missing authenticated user header from API Gateway');
    }

    return true;
  }
}
