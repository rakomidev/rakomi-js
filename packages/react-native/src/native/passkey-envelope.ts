
/** Which ceremony produced this envelope. The required-set differs per direction — deliberately. */
export type CredentialEnvelopeKind = 'registration' | 'assertion';

/**
 * base64url, unpadded (RFC 4648 §5). Deliberately a flat character class with a single quantifier —
 * no nesting, so it cannot backtrack pathologically on a hostile input.
 *
 * `+`, not `*`: no legitimate WebAuthn base64url member is the EMPTY string, and `*` accepted one.
 * That mattered for the OPTIONAL members (`response.userHandle`), which the required-set does not
 * cover: a Swift module mapping a `nil` user handle to `""` instead of omitting the key — the single
 * most common Optional→String bridging bug — sailed through and reached the server.
 */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

interface EnvelopeRule {
  /** Members that MUST be present and be non-empty strings. `response.` prefixes reach into `response`. */
  readonly required: readonly string[];
  /** Members that MUST be unpadded base64url when present. */
  readonly base64url: readonly string[];
  /** Members that MUST be present and be an array of strings (`response.transports`). */
  readonly requiredStringArray: readonly string[];
  /** Members that MUST be present and be an object (`clientExtensionResults`, possibly empty). */
  readonly requiredObject: readonly string[];
  /** Top-level members carried through to the server. Everything else is DROPPED. */
  readonly keep: readonly string[];
  /** `response` members carried through. Everything else is DROPPED. */
  readonly keepInResponse: readonly string[];
  /** `response` members carried through as a string array. */
  readonly keepStringArrayInResponse: readonly string[];
}

/**
 * The ENFORCED required-set — per direction, and NARROWER than the documentation MUST in
 * `NativePasskeyModuleSpec`'s JSDoc. The narrowing rule, stated exactly, because a vaguer version of
 * it silently excused two fields it should not have:
 *
 * **enforced ⇔ (sdk-core's own fixture carries it) ∧ (the server consumes it).**
 *
 * `response.authenticatorData` and `response.publicKeyAlgorithm` on a REGISTRATION response fail the
 * first conjunct — sdk-core's canonical fixture does not carry them — and enforcing them would make
 * this validator reject the reference implementation the shared conformance suite is built on. A
 * validator that rejects the reference implementation is broken, not strict. `response.transports` and
 * `clientExtensionResults` satisfy BOTH conjuncts (the fixture carries them; the server persists
 * `transports` and replays it into `allowCredentials`), so they ARE enforced — an earlier revision let
 * them slide under a hand-wave, which would have let a module omit `transports` and silently degrade
 * cross-device sign-in weeks later, on another device. That is exactly the failure class this validator
 * exists for.
 *
 * When sdk-core's fixtures are enriched to the full W3C shape, this set widens in the same change —
 * never before.
 *
 * The set stays PER-DIRECTION rather than a union precisely so the wrong-ceremony case survives the
 * reduction: a registration envelope has no `signature`, an assertion envelope has no
 * `attestationObject`.
 */
const RULES: Record<CredentialEnvelopeKind, EnvelopeRule> = {
  registration: {
    required: ['id', 'rawId', 'response.clientDataJSON', 'response.attestationObject'],
    base64url: ['id', 'rawId', 'response.clientDataJSON', 'response.attestationObject'],
    requiredStringArray: ['response.transports'],
    requiredObject: ['clientExtensionResults'],
    keep: ['id', 'rawId', 'type', 'authenticatorAttachment', 'clientExtensionResults'],
    keepInResponse: [
      'clientDataJSON',
      'attestationObject',
      'authenticatorData',
      'publicKey',
      'publicKeyAlgorithm',
    ],
    keepStringArrayInResponse: ['transports'],
  },
  assertion: {
    required: [
      'id',
      'rawId',
      'response.clientDataJSON',
      'response.authenticatorData',
      'response.signature',
    ],
    base64url: [
      'id',
      'rawId',
      'response.clientDataJSON',
      'response.authenticatorData',
      'response.signature',
      'response.userHandle',
    ],
    requiredStringArray: [],
    requiredObject: ['clientExtensionResults'],
    keep: ['id', 'rawId', 'type', 'authenticatorAttachment', 'clientExtensionResults'],
    keepInResponse: ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle'],
    keepStringArrayInResponse: [],
  },
};

/** The envelope broke the W3C contract. Terminal: the module is broken, retrying changes nothing. */
export class CredentialEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialEnvelopeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read `id` or `response.clientDataJSON` out of the envelope. Missing intermediate → `undefined`. */
function readPath(envelope: Record<string, unknown>, path: string): unknown {
  const dot = path.indexOf('.');
  if (dot === -1) return envelope[path];
  const parent = envelope[path.slice(0, dot)];
  return isRecord(parent) ? parent[path.slice(dot + 1)] : undefined;
}

/**
 * Validate a parsed native response against the W3C envelope for `kind`.
 *
 * Throws {@link CredentialEnvelopeError} naming the field and the violated rule — never the field's
 * VALUE. A `PasskeyError` message reaches logs and crash reporters; a credential id and a
 * `clientDataJSON` are durable user identifiers, so the diagnosis must be free of them.
 */
export function assertW3cCredentialEnvelope(kind: CredentialEnvelopeKind, parsed: unknown): void {
  if (!isRecord(parsed)) {
    throw new CredentialEnvelopeError(
      `the native module returned a ${parsed === null ? 'null' : typeof parsed}; the contract is a JSON object`,
    );
  }
  if (parsed['type'] !== 'public-key') {
    throw new CredentialEnvelopeError(`'type' must be the string "public-key" (W3C WebAuthn L3)`);
  }
  if (!isRecord(parsed['response'])) {
    throw new CredentialEnvelopeError(`'response' is missing or is not an object`);
  }

  const rule = RULES[kind];

  for (const path of rule.required) {
    const value = readPath(parsed, path);
    if (typeof value !== 'string' || value.length === 0) {
      throw new CredentialEnvelopeError(
        `'${path}' is required on a ${kind} response and must be a non-empty string (W3C WebAuthn L3 JSON serialization)`,
      );
    }
  }

  for (const path of rule.requiredStringArray) {
    const value = readPath(parsed, path);
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new CredentialEnvelopeError(
        `'${path}' is required on a ${kind} response and must be an array of strings (W3C WebAuthn L3). The server stores it and replays it into allowCredentials — omitting it silently breaks cross-device sign-in later, on another device.`,
      );
    }
  }

  for (const path of rule.requiredObject) {
    const value = readPath(parsed, path);
    if (!isRecord(value)) {
      throw new CredentialEnvelopeError(
        `'${path}' is required on a ${kind} response and must be an object (an empty object is fine)`,
      );
    }
  }

  for (const path of rule.base64url) {
    const value = readPath(parsed, path);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !BASE64URL.test(value)) {
      throw new CredentialEnvelopeError(
        `'${path}' is not unpadded base64url (RFC 4648 §5). On iOS, Data.base64EncodedString() emits standard base64 (RFC 4648 §4, with '+', '/' and '=' padding) — use the URL-safe, unpadded variant.`,
      );
    }
  }
}

/**
 * Validate, then **re-project** the envelope onto the members the contract knows.
 *
 * Validating without projecting is a check, not a boundary. The bridge used to forward the whole parsed
 * object, and the server accepts the credential as an opaque blob — so every extra member a buggy or
 * hostile module invented rode straight through to persistence. A `transports` that is a *string*
 * instead of an array, or a five-thousand-element array, lands in the database and then poisons every
 * subsequent `allowCredentials` for that user. Dropping unknown members costs nothing (the server reads
 * none of them) and closes the class outright, instead of blacklisting the shapes we happened to think
 * of.
 *
 * `Object.create(null)` for the projection, so a `"__proto__"` key that survived `JSON.parse` as an own
 * property cannot be carried into an object with a real prototype further down.
 */
export function sanitizeCredentialEnvelope(
  kind: CredentialEnvelopeKind,
  parsed: unknown,
): Record<string, unknown> {
  assertW3cCredentialEnvelope(kind, parsed);
  const envelope = parsed as Record<string, unknown>;
  const source = envelope['response'] as Record<string, unknown>;
  const rule = RULES[kind];

  const response = Object.create(null) as Record<string, unknown>;
  for (const key of rule.keepInResponse) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') response[key] = value;
  }
  for (const key of rule.keepStringArrayInResponse) {
    const value = source[key];
    if (Array.isArray(value)) response[key] = value.filter((entry) => typeof entry === 'string');
  }

  const projected = Object.create(null) as Record<string, unknown>;
  for (const key of rule.keep) {
    const value = envelope[key];
    if (value !== undefined) projected[key] = value;
  }
  projected['response'] = response;
  return projected;
}
