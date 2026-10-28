import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AccessTokens } from '../platform/security.js';
@Injectable()
export class GatewayAuthGuard implements CanActivate {
  constructor(private readonly tokens: AccessTokens) {}
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    req.principal = this.tokens.authorize(req.headers.authorization);
    return true;
  }
}
