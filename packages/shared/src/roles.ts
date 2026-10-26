import { z } from 'zod';

/** Tenant roles, highest privilege first. Super-admin is a platform flag, not a tenant role. */
export const ROLES = ['owner', 'admin', 'reviewer', 'viewer'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

const RANK: Record<Role, number> = { owner: 4, admin: 3, reviewer: 2, viewer: 1 };

/** True when `role` is at least as privileged as `minimum`. */
export function hasRole(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/** Roles that may enable / are encouraged to use TOTP 2FA. */
export const TWO_FACTOR_ROLES: readonly Role[] = ['owner', 'admin'];

/** Roles an inviter may assign. Only owners can create other owners. */
export function assignableRoles(inviter: Role): Role[] {
  if (inviter === 'owner') return [...ROLES];
  if (inviter === 'admin') return ['admin', 'reviewer', 'viewer'];
  return [];
}
