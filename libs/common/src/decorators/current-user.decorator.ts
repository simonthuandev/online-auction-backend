import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { HEADERS, type CurrentUserPayload } from '../constants/headers.constant.js';

export const CurrentUser = createParamDecorator(
  (data: keyof CurrentUserPayload | undefined, ctx: ExecutionContext): CurrentUserPayload | string | null => {
    const request = ctx.switchToHttp().getRequest();
    const userId = request.headers[HEADERS.USER_ID] as string;
    const role = request.headers[HEADERS.USER_ROLE] as 'USER' | 'SELLER' | 'ADMIN';

    if (!userId) {
      return null;
    }

    const user: CurrentUserPayload = {
      userId,
      role: role || 'USER',
    };

    return data ? user[data] : user;
  },
);
