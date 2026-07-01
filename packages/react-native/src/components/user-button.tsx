/**
 * `<UserButton />` — RN port. Renders a tap-target showing the current user's
 * email/initials + a sign-out action when expanded.
 *
 * RN primitives only.
 */

'use client';

import { type ReactNode,useState } from 'react';

import { useRakomiContext } from '../context.js';
import { loadRnPrimitives as loadRn } from '../internal/rn-primitives.js';

export interface UserButtonProps {
  /** Show the email next to the avatar. Default true. */
  showName?: boolean;
  style?: any;
}

export function UserButton(props: UserButtonProps): ReactNode {
  const ctx = useRakomiContext();
  const { View, Text, Pressable } = loadRn();
  const [expanded, setExpanded] = useState(false);
  const user = ctx.user;
  if (!user) return null;
  const initials = (user.email || '?').slice(0, 2).toUpperCase();
  return (
    <View style={props.style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Account menu for ${user.email}`}
        onPress={() => setExpanded((v) => !v)}
      >
        <View>
          <Text accessibilityLabel={`Avatar ${initials}`}>{initials}</Text>
          {props.showName !== false ? <Text>{user.email}</Text> : null}
        </View>
      </Pressable>
      {expanded ? (
        <View accessibilityRole="menu">
          <Pressable
            accessibilityRole="menuitem"
            accessibilityLabel="Sign out"
            onPress={() => {
              setExpanded(false);
              void ctx.signOut();
            }}
          >
            <Text>Sign out</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
