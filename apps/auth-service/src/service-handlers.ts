import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { HttpHandlers, EventHandlers, type AuthRequest } from '@app/common';
import { UsersService } from './users/users.service.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly users: UsersService,
  ) {}

  onModuleInit() {
    this.http.register('auth_get__api_auth_me', async (request: AuthRequest) => {
      const userId = request.principal?.sub;
      if (!userId) {
        throw new UnauthorizedException('Unauthenticated');
      }
      return this.users.getProfile(userId);
    });

    this.http.register('auth_patch__api_auth_me', async (request: AuthRequest) => {
      const userId = request.principal?.sub;
      if (!userId) {
        throw new UnauthorizedException('Unauthenticated');
      }
      return this.users.updateProfile(userId, request.body);
    });
  }
}
