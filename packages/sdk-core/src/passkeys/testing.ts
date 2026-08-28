/**
 * Test utilities for passkey ceremony adapters.
 *
 * Shipped on a dedicated subpath, never from the package root, so it stays out of an application
 * bundle.
 *
 * The conformance suite is the point: the browser binding and the native binding must satisfy the
 * *same* contract, and "same contract" is a claim best kept honest by a test both of them run. The
 * suite takes the test framework's primitives as arguments so this module depends on no test runner.
 */

import type {
  AuthenticationResponseJSON,
  PasskeyCeremonyAdapter,
  RegistrationResponseJSON,
} from './types.js';

/** A canonical registration response, in the W3C JSON form. Values are illustrative, not real. */
export const FAKE_REGISTRATION_RESPONSE: RegistrationResponseJSON = {
  id: 'Zm9vLWNyZWRlbnRpYWwtaWQ',
  rawId: 'Zm9vLWNyZWRlbnRpYWwtaWQ',
  type: 'public-key',
  response: {
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0',
    attestationObject: 'o2NmbXRkbm9uZQ',
    transports: ['internal', 'hybrid'],
  },
  authenticatorAttachment: 'platform',
  clientExtensionResults: {},
};

/** A canonical assertion response, in the W3C JSON form. */
export const FAKE_AUTHENTICATION_RESPONSE: AuthenticationResponseJSON = {
  id: 'Zm9vLWNyZWRlbnRpYWwtaWQ',
  rawId: 'Zm9vLWNyZWRlbnRpYWwtaWQ',
  type: 'public-key',
  response: {
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
    authenticatorData: 'ZmFrZQ',
    signature: 'ZmFrZQ',
    userHandle: 'dXNlci1oYW5kbGU',
  },
  clientExtensionResults: {},
};

export interface FakePasskeyAdapterOverrides {
  isSupported?: PasskeyCeremonyAdapter['isSupported'];
  createCredential?: PasskeyCeremonyAdapter['createCredential'];
  getCredential?: PasskeyCeremonyAdapter['getCredential'];
}

/**
 * A conformant adapter that resolves canned credentials — the baseline every test starts from, and
 * the thing a specific test overrides one method of (to cancel, to hang, to misbehave).
 */
export function createFakePasskeyAdapter(
  overrides: FakePasskeyAdapterOverrides = {},
): PasskeyCeremonyAdapter {
  return {
    isSupported: overrides.isSupported ?? (() => true),
    createCredential: overrides.createCredential ?? (() => Promise.resolve(FAKE_REGISTRATION_RESPONSE)),
    getCredential: overrides.getCredential ?? (() => Promise.resolve(FAKE_AUTHENTICATION_RESPONSE)),
  };
}

/** The minimum a test framework must provide for {@link runPasskeyAdapterConformanceSuite}. */
export interface ConformanceTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe: (expected: unknown) => void;
    toBeTypeOf?: (expected: string) => void;
  };
}

/**
 * The contract every ceremony adapter must satisfy — imported and run by the browser binding and by
 * the native binding, so "one contract, two bindings" is verified rather than asserted.
 */
export function runPasskeyAdapterConformanceSuite(
  api: ConformanceTestApi,
  makeAdapter: () => PasskeyCeremonyAdapter,
): void {
  const { describe, it, expect } = api;

  describe('PasskeyCeremonyAdapter conformance', () => {
    it('exposes the three contract methods', () => {
      const adapter = makeAdapter();
      expect(typeof adapter.isSupported).toBe('function');
      expect(typeof adapter.createCredential).toBe('function');
      expect(typeof adapter.getCredential).toBe('function');
    });

    it('reports support as a boolean (sync or awaited)', async () => {
      const adapter = makeAdapter();
      const supported = await adapter.isSupported();
      expect(typeof supported).toBe('boolean');
    });

    it('resolves a W3C-shaped registration credential', async () => {
      const adapter = makeAdapter();
      const credential = await adapter.createCredential(
        {
          rp: { name: 'Example' },
          user: { id: 'dXNlcg', name: 'a@example.test', displayName: 'A' },
          challenge: 'Y2hhbGxlbmdl',
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        },
        {},
      );
      expect(typeof credential.id).toBe('string');
      expect(credential.type).toBe('public-key');
      expect(typeof credential.response.clientDataJSON).toBe('string');
      expect(typeof credential.response.attestationObject).toBe('string');
    });

    it('resolves a W3C-shaped assertion credential', async () => {
      const adapter = makeAdapter();
      const credential = await adapter.getCredential({ challenge: 'Y2hhbGxlbmdl' }, {});
      expect(typeof credential.id).toBe('string');
      expect(credential.type).toBe('public-key');
      expect(typeof credential.response.clientDataJSON).toBe('string');
      expect(typeof credential.response.authenticatorData).toBe('string');
      expect(typeof credential.response.signature).toBe('string');
    });
  });
}
