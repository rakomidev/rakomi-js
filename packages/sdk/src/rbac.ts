import type { TokenPayload } from './types.js';

/**
 * Check if the token payload contains a specific role key.
 * Role keys are immutable slugs (e.g., 'team_admin'), not display names.
 */
export function hasRole(payload: TokenPayload, roleKey: string): boolean {
  return payload.roles.includes(roleKey);
}

/**
 * Check if the token payload contains a specific permission.
 * Supports wildcard matching: if user has 'posts:*', hasPermission('posts:read') returns true.
 * Match logic: split on ':', compare namespace exactly, '*' in action position matches any action.
 */
export function hasPermission(payload: TokenPayload, permission: string): boolean {
  if (payload.permissions.includes(permission)) return true;

  const [namespace] = permission.split(':');
  if (!namespace) return false;

  return payload.permissions.includes(`${namespace}:*`);
}
