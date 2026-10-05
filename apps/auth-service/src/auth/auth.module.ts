import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { UsersModule } from '../users/users.module.js';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    UsersModule,
    JwtModule.register({}), // Secrets are provided in the service or strategy
  ],
  providers: [AuthService],
  controllers: [AuthController]
})
export class AuthModule {}
