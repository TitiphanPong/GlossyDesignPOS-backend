export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const USER_ROLES = ['staff', 'manager', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];
