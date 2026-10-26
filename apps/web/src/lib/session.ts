import { useQuery, useQueryClient } from '@tanstack/react-query';
import { hasRole, type MeResponse, type Role } from '@keyless/shared';
import { ApiError, api } from './api';

export const meQueryKey = ['me'] as const;

/** The signed-in user and org, or null when signed out. */
export function useSession() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        return await api.get<MeResponse>('/api/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

/** Session for components rendered inside the authenticated shell. */
export function useMe(): MeResponse {
  const { data } = useSession();
  if (!data) throw new Error('useMe used outside an authenticated route');
  return data;
}

export function useHasRole(minimum: Role): boolean {
  const { data } = useSession();
  return data ? hasRole(data.user.role, minimum) : false;
}

export function useSetSession() {
  const qc = useQueryClient();
  return (session: MeResponse | null) => {
    if (session === null) qc.clear();
    qc.setQueryData(meQueryKey, session);
  };
}
