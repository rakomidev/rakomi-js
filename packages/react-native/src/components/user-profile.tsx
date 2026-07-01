/**
 * `<UserProfile />` — RN port (PREVIEW).
 *
 * Marked `'preview'` until 0.2.0; on first mount in `__DEV__` builds we log a
 * warning so consumers don't accidentally ship it to production.
 */

'use client';

import { type ReactNode,useEffect } from 'react';

import { useRakomiContext } from '../context.js';
import { loadRnPrimitives as loadRn } from '../internal/rn-primitives.js';

declare const __DEV__: boolean | undefined;

export interface UserProfileProps {
  style?: any;
}

export function UserProfile(props: UserProfileProps): ReactNode {
  useEffect(() => {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {

      console.warn('[@rakomi/react-native] <UserProfile /> is in preview until 0.2.0 — feedback welcome.');
    }
  }, []);
  const ctx = useRakomiContext();
  const { View, Text } = loadRn();
  const user = ctx.user;
  if (!user) {
    return (
      <View style={props.style}>
        <Text>Not signed in</Text>
      </View>
    );
  }
  return (
    <View style={props.style} accessibilityRole="summary">
      <Text accessibilityRole="header">{user.email || 'Anonymous user'}</Text>
      <Text>ID: {user.id}</Text>
      <Text>Tenant: {user.tenantId}</Text>
      {user.roles.length > 0 ? <Text>Roles: {user.roles.join(', ')}</Text> : null}
      {user.permissions.length > 0 ? <Text>Permissions: {user.permissions.length}</Text> : null}
      {user.mfaVerified ? <Text accessibilityLabel="MFA verified">MFA: verified</Text> : null}
    </View>
  );
}
