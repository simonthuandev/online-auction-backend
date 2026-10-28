import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { AuthService } from './auth.service.js';
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('register') register(
    @Body() body: { email: string; password: string; name: string },
  ) {
    return this.auth.register(body);
  }
  @HttpCode(200) @Post('login') login(
    @Body() body: { email: string; password: string },
  ) {
    return this.auth.login(body);
  }
  @HttpCode(200) @Post('refresh') refresh(@Body('refreshToken') token: string) {
    return this.auth.refresh(token);
  }
  @HttpCode(200) @Post('logout') logout(@Body('refreshToken') token: string) {
    return this.auth.logout(token);
  }
}
