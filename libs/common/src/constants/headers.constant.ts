export const HEADERS = {
  USER_ID: 'x-user-id',
  USER_ROLE: 'x-user-role',
} as const;

export interface CurrentUserPayload {
  userId: string;
  role: 'USER' | 'SELLER' | 'ADMIN';
}
