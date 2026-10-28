import { Injectable } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client/auth/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}
  create(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }
  findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }
  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }
}
