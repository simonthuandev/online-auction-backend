import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, type User } from '@prisma/client/auth/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface UpdateProfileDto {
  name?: string;
  avatarUrl?: string | null;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: 'USER' | 'SELLER' | 'ADMIN';
  avatarUrl: string | null;
  isActive: boolean;
}

function mapToProfile(user: User): UserProfile {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarUrl: user.avatarUrl ?? null,
    isActive: user.isActive,
  };
}

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

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User account is inactive or not found');
    }
    return mapToProfile(user);
  }

  async updateProfile(
    userId: string,
    body: UpdateProfileDto,
  ): Promise<UserProfile> {
    if (
      !body ||
      typeof body !== 'object' ||
      (body.name === undefined && body.avatarUrl === undefined)
    ) {
      throw new BadRequestException('Request body must contain name or avatarUrl');
    }

    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') {
        throw new BadRequestException('Name must be a string');
      }
      const trimmed = body.name.trim();
      if (trimmed.length < 1 || trimmed.length > 100) {
        throw new BadRequestException('Name must be between 1 and 100 characters');
      }
      name = trimmed;
    }

    let avatarUrl: string | null | undefined;
    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl === null) {
        avatarUrl = null;
      } else if (typeof body.avatarUrl === 'string') {
        const trimmed = body.avatarUrl.trim();
        if (trimmed.length > 2048) {
          throw new BadRequestException(
            'Avatar URL must be at most 2048 characters',
          );
        }
        try {
          const parsed = new URL(trimmed);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error();
          }
        } catch {
          throw new BadRequestException(
            'Avatar URL must be a valid http or https URL',
          );
        }
        avatarUrl = trimmed;
      } else {
        throw new BadRequestException('Avatar URL must be a string or null');
      }
    }

    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!existing || !existing.isActive) {
      throw new UnauthorizedException('User account is inactive or not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(name !== undefined && { name }),
        ...(avatarUrl !== undefined && { avatarUrl }),
      },
    });

    return mapToProfile(updated);
  }
}
