import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
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

    this.http.register(
      'auth_patch__api_admin_users_id_role',
      async (request: AuthRequest) => {
        const adminId = request.principal?.sub;
        const role = request.principal?.role;
        if (!adminId) {
          throw new UnauthorizedException('Unauthenticated');
        }
        if (role !== 'ADMIN') {
          throw new ForbiddenException('Admin access required');
        }
        const targetUserId = String(request.params.id);
        const { role: newRole } = (request.body || {}) as {
          role: 'USER' | 'SELLER' | 'ADMIN';
        };
        return this.users.updateUserRole(adminId, targetUserId, newRole);
      },
    );
  }
}
