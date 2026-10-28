import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
export interface Principal {
  sub: string;
  role: 'USER' | 'SELLER' | 'ADMIN';
  exp: number;
  type: 'access';
}
export function constantEqual(
  actual: unknown,
  expected: string | undefined,
): boolean {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
@Injectable()
export class AccessTokens {
  private readonly jwt = new JwtService();
  private readonly publicKey = readFileSync(
    process.env.JWT_PUBLIC_KEY_PATH!,
    'utf8',
  );
  verify(token: string): Principal {
    try {
      const p = this.jwt.verify<Principal>(token, {
        publicKey: this.publicKey,
        algorithms: ['RS256'],
        issuer: process.env.JWT_ISSUER,
        audience: process.env.JWT_AUDIENCE,
      });
      if (
        p.type !== 'access' ||
        !p.sub ||
        !['USER', 'SELLER', 'ADMIN'].includes(p.role) ||
        !p.exp
      )
        throw Error('claims');
      return p;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
  authorize(header: unknown, roles: string[] = []): Principal {
    if (typeof header !== 'string' || !header.startsWith('Bearer '))
      throw new UnauthorizedException('Bearer access token required');
    const p = this.verify(header.slice(7));
    if (roles.length && !roles.includes(p.role))
      throw new ForbiddenException('Insufficient role');
    return p;
  }
}
export function requireServiceKey(
  actual: unknown,
  expected: string | undefined,
) {
  if (!constantEqual(actual, expected))
    throw new UnauthorizedException('Invalid service credential');
}
