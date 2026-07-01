/**
 * Verifiable Credentials Issuer SDK accessors (`@rakomi/node`).
 *
 * Server-to-server methods for tenant backends to issue, list, get, and revoke VCs via
 * the Rakomi issuer (OpenID4VCI).
 *
 * Error contract (closed set): `invalid_claims`, `tenant_disabled`, `rate_limited`, `no_pepper`,
 * `user_not_found`, `schema_violation`, `dpia_not_acknowledged`, `minor_blocked`,
 * `pid_attribute_forbidden`.
 */

/**
 * VC issuer SDK errors are thrown as `VcSdkError` (extending Error). Code semantics align
 * with the Rakomi API error codes (e.g. `vc/tenant_disabled`, `vc/invalid_claims`).
 */
export class VcSdkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'VcSdkError';
  }
}

export type VcBuiltinType =
  | 'MembershipCredential'
  | 'SubscriptionCredential'
  | 'VerifiedEmailCredential'
  | 'AgeVerificationCredential'
  | 'CustomCredential';

export type VcRevocationReason =
  | 'key_compromise'
  | 'service_terminated'
  | 'attribute_change'
  | 'user_request'
  | 'other';

export type VcCredentialStatus = 'active' | 'revoked' | 'expired';

export interface VcCredentialResponse {
  jti: string;
  vct: string;
  credential_type: VcBuiltinType;
  custom_type_name: string | null;
  user_id: string;
  subject_type: 'user' | 'agent' | 'org';
  issued_at: string;
  valid_from: string | null;
  valid_until: string | null;
  revoked_at: string | null;
  revocation_reason: VcRevocationReason | null;
  status: VcCredentialStatus;
  signing_kid: string;
  holder_jkt: string | null;
}

export interface VcOfferResponse {
  jti: string;
  vct: string;
  status: { idx: number; uri: string };
  credential_offer_uri: string;
  download_url: string;
  expires_at: string;
}

export interface VcIssueParams {
  userId: string;
  credentialType: VcBuiltinType;
  customTypeName?: string;
  claims: Record<string, unknown>;
  validFrom?: string;
  validUntil?: string;
  subjectType?: 'user' | 'agent' | 'org';
}

export interface VcListParams {
  userId?: string;
  credentialType?: VcBuiltinType;
  limit?: number;
  offset?: number;
}

export interface VcRevokeParams {
  reason: VcRevocationReason;
}

export class CredentialsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async issue(params: VcIssueParams): Promise<VcOfferResponse> {
    const res = await fetch(`${this.baseUrl}/v1/credentials/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      redirect: 'error',
      body: JSON.stringify({
        user_id: params.userId,
        credential_type: params.credentialType,
        custom_type_name: params.customTypeName,
        claims: params.claims,
        valid_from: params.validFrom,
        valid_until: params.validUntil,
        subject_type: params.subjectType,
      }),
    });
    return this.parse<VcOfferResponse>(res, 'issue');
  }

  async list(params: VcListParams = {}): Promise<{ data: VcCredentialResponse[] }> {
    const url = new URL(`${this.baseUrl}/v1/credentials`);
    if (params.userId) url.searchParams.set('user_id', params.userId);
    if (params.credentialType) url.searchParams.set('credential_type', params.credentialType);
    if (params.limit !== undefined) url.searchParams.set('limit', String(params.limit));
    if (params.offset !== undefined) url.searchParams.set('offset', String(params.offset));
    const res = await fetch(url, {
      headers: { 'X-API-Key': this.apiKey },
      redirect: 'error',
    });
    return this.parse<{ data: VcCredentialResponse[] }>(res, 'list');
  }

  async get(jti: string): Promise<VcCredentialResponse> {
    const res = await fetch(`${this.baseUrl}/v1/credentials/${encodeURIComponent(jti)}`, {
      headers: { 'X-API-Key': this.apiKey },
      redirect: 'error',
    });
    return this.parse<VcCredentialResponse>(res, 'get');
  }

  async revoke(jti: string, reason: VcRevocationReason = 'user_request'): Promise<{
    jti: string;
    revoked_at: string;
    status: { idx: number; uri: string; list_version: number };
  }> {
    const res = await fetch(`${this.baseUrl}/v1/credentials/${encodeURIComponent(jti)}/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
      redirect: 'error',
      body: JSON.stringify({ reason } satisfies VcRevokeParams),
    });
    return this.parse(res, 'revoke');
  }

  private async parse<T>(res: Response, op: string): Promise<T> {
    if (!res.ok) {
      let code = `vc/${op}_failed`;
      let message = `VC ${op} failed with HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { code?: string; message?: string };
        if (body.code) code = body.code;
        if (body.message) message = body.message;
      } catch {
      }
      throw new VcSdkError(code, message, res.status);
    }
    return (await res.json()) as T;
  }
}
