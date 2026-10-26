import { describe, expect, it } from 'vitest';
import { assignableRoles, hasRole } from './roles';

describe('roles', () => {
  it('ranks roles', () => {
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('reviewer', 'admin')).toBe(false);
    expect(hasRole('viewer', 'viewer')).toBe(true);
  });
  it('limits assignable roles', () => {
    expect(assignableRoles('admin')).not.toContain('owner');
    expect(assignableRoles('owner')).toContain('owner');
    expect(assignableRoles('reviewer')).toEqual([]);
  });
});
