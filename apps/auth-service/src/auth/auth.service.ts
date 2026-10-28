import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, type User } from '@prisma/client/auth/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
@Injectable()
export class AuthService {
  private readonly jwt = new JwtService();
  private readonly privateKey = readFileSync(
    process.env.JWT_PRIVATE_KEY_PATH!,
    'utf8',
  );
  constructor(private readonly db: PrismaService) {}
  async register(body: { email: string; password: string; name: string }) {
    if (Buffer.byteLength(body.password) > 72)
      throw new BadRequestException('Password must be at most 72 UTF-8 bytes');
    const user = await this.db.user.create({
      data: {
        email: body.email.toLowerCase(),
        password: await bcrypt.hash(body.password, 10),
        name: body.name,
      },
    });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      isActive: user.isActive,
    };
  }
  async login(body: { email: string; password: string }) {
    const user = await this.db.user.findUnique({
      where: { email: body.email.toLowerCase() },
    });
    if (
      !user?.password ||
      !user.isActive ||
      !(await bcrypt.compare(body.password, user.password))
    )
      throw new UnauthorizedException('Invalid credentials');
    return this.db.$transaction((tx) => this.issue(tx, user, randomUUID()));
  }
  private verifyRefresh(token: string) {
    try {
      const payload = this.jwt.verify<{
        sub: string;
        jti: string;
        type: string;
      }>(token, {
        secret: process.env.JWT_REFRESH_SECRET,
        algorithms: ['HS256'],
        issuer: process.env.JWT_ISSUER,
        audience: 'online-auction-refresh',
      });
      if (payload.type !== 'refresh' || !payload.jti || !payload.sub)
        throw Error();
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }
  async refresh(token: string) {
    const claims = this.verifyRefresh(token);
    const tokens = await this.db.$transaction(async (tx) => {
      // A user lock serializes refresh/logout, including newly inserted family members.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${claims.sub} FOR UPDATE`;
      // Lock serializes rotation, reuse detection and family revocation for concurrent requests.
      await tx.$queryRaw`SELECT id FROM "RefreshToken" WHERE "tokenHash"=${hash(token)} FOR UPDATE`;
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash: hash(token) },
        include: { user: true },
      });
      if (
        !row ||
        row.jti !== claims.jti ||
        row.userId !== claims.sub ||
        row.expiresAt <= new Date() ||
        !row.user.isActive
      )
        return null;
      if (row.isRevoked) {
        await tx.refreshToken.updateMany({
          where: { familyId: row.familyId },
          data: { isRevoked: true },
        });
        return null;
      }
      await tx.refreshToken.update({
        where: { id: row.id },
        data: { isRevoked: true },
      });
      return this.issue(tx, row.user, row.familyId);
    });
    if (!tokens)
      throw new UnauthorizedException('Invalid or reused refresh token');
    return tokens;
  }
  async logout(token: string) {
    const claims = this.verifyRefresh(token);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${claims.sub} FOR UPDATE`;
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash: hash(token) },
      });
      if (row)
        await tx.refreshToken.updateMany({
          where: { familyId: row.familyId },
          data: { isRevoked: true },
        });
    });
    return { revoked: true };
  }
  private async issue(
    tx: Prisma.TransactionClient,
    user: User,
    familyId: string,
  ) {
    const jti = randomUUID();
    const common = { issuer: process.env.JWT_ISSUER };
    const accessToken = this.jwt.sign(
      { sub: user.id, role: user.role, type: 'access' },
      {
        ...common,
        privateKey: this.privateKey,
        algorithm: 'RS256',
        keyid: process.env.JWT_KEY_ID,
        audience: process.env.JWT_AUDIENCE,
        expiresIn: '15m',
        jwtid: randomUUID(),
      },
    );
    const refreshToken = this.jwt.sign(
      { sub: user.id, type: 'refresh' },
      {
        ...common,
        secret: process.env.JWT_REFRESH_SECRET,
        algorithm: 'HS256',
        audience: 'online-auction-refresh',
        expiresIn: '7d',
        jwtid: jti,
      },
    );
    await tx.refreshToken.create({
      data: {
        tokenHash: hash(refreshToken),
        jti,
        familyId,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 86400000),
      },
    });
    return { accessToken, refreshToken };
  }
}
