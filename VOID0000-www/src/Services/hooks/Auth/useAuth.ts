import { useUser, User } from '../../Auth/UserContext';

export const useAuth = (): { user: User | null; loading: boolean } => {
  const { user, loading } = useUser();
  return { user, loading };
};