import { UserRole } from './auth.constants';

export type AuthenticatedUser = {
  id: string;
  username: string;
  role: UserRole;
};
