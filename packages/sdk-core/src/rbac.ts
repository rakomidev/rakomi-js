/**
 * Pure RBAC predicates.
 */

export function hasRole(claims: { roles: string[] }, roleKey: string): boolean {
  return claims.roles.includes(roleKey);
}

/** Wildcard-aware: `posts:*` matches `posts:read`. */
export function hasPermission(claims: { permissions: string[] }, permission: string): boolean {
  if (claims.permissions.includes(permission)) return true;
  const [namespace] = permission.split(':');
  if (!namespace) return false;
  return claims.permissions.includes(`${namespace}:*`);
}
