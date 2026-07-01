
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface UserContext {
  userId?: string;
  userMetadata?: Record<string, unknown>;
  keys?: string[];
}

export interface FlagsOptions {
  ttl?: number;
  skipCache?: boolean;
}

export type FlagResult<T = unknown> =
  | { ok: true; value: T; variant?: string; reason?: string }
  | { ok: false; error: { code: string; message: string } };

export type FlagsAllResult =
  | { ok: true; flags: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

interface CacheEntry {
  flags: Record<string, unknown>;
  etag: string | null;
  fetchedAt: number;
  ttl: number;
}

const MAX_CACHE_ENTRIES = 1000;
const ETAG_REGEX = /^"[^"]*"$/;

class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private readonly threshold = 3;
  private readonly resetMs = 60_000;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  get status(): CircuitState {
    return this.state;
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      this.state = 'open';
      this.failures = 0;
      this.resetTimer = setTimeout(() => {
        this.state = 'half-open';
        this.failures = 0;
        this.resetTimer = null;
      }, this.resetMs);
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold && this.state === 'closed') {
      this.state = 'open';
      this.resetTimer = setTimeout(() => {
        this.state = 'half-open';
        this.failures = 0;
        this.resetTimer = null;
      }, this.resetMs);
    }
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = 0;
      if (this.resetTimer !== null) {
        clearTimeout(this.resetTimer);
        this.resetTimer = null;
      }
    }
  }

  isOpen(): boolean {
    return this.state === 'open';
  }
}

export class FlagsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly circuit: CircuitBreaker = new CircuitBreaker();

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  get circuitStatus(): CircuitState {
    return this.circuit.status;
  }

  private buildCacheKey(ctx?: UserContext): string {
    const userId = ctx?.userId ?? '__anon__';
    const sortedKeys = ctx?.keys ? [...ctx.keys].sort().join(',') : '__all__';
    return `${this.apiKey}:${userId}:${sortedKeys}`;
  }

  private isCacheValid(entry: CacheEntry): boolean {
    return Date.now() - entry.fetchedAt < entry.ttl * 1000;
  }

  private setCacheEntry(key: string, entry: CacheEntry): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, entry);
  }

  private async fetchFlags(ctx?: UserContext, _opts?: FlagsOptions): Promise<{ flags: Record<string, unknown>; etag: string | null }> {
    const body = {
      ...(ctx?.userId ? { user_id: ctx.userId } : {}),
      ...(ctx?.userMetadata ? { user_metadata: ctx.userMetadata } : {}),
      ...(ctx?.keys?.length ? { keys: ctx.keys } : {}),
    };

    const cacheKey = this.buildCacheKey(ctx);
    const cached = this.cache.get(cacheKey);
    const etag = cached?.etag ?? null;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    const response = await fetch(`${this.baseUrl}/v1/flags/evaluate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 304 && cached) {
      return { flags: cached.flags, etag: cached.etag };
    }

    if (!response.ok) {
      const err = new (class extends Error {})(`HTTP ${response.status}`);
      throw err;
    }

    const data = (await response.json()) as { flags: Record<string, unknown> };
    const newEtag = response.headers.get('etag');
    const validEtag = newEtag && ETAG_REGEX.test(newEtag) ? newEtag : null;

    return { flags: data.flags ?? {}, etag: validEtag };
  }

  async get<T = unknown>(key: string, ctx?: UserContext, opts?: FlagsOptions): Promise<FlagResult<T>> {
    try {
      if (this.circuit.isOpen()) {
        return { ok: false, error: { code: 'CIRCUIT_OPEN', message: 'Circuit breaker open — evaluate endpoint unavailable' } };
      }

      const effectiveTtl = Math.max(opts?.ttl ?? 60, 10);
      const cacheKey = this.buildCacheKey(ctx);
      const cached = this.cache.get(cacheKey);

      if (!opts?.skipCache && cached && this.isCacheValid(cached)) {
        const value = cached.flags[key];
        return { ok: true, value: value as T };
      }

      const { flags, etag } = await this.fetchFlags(ctx, opts);
      this.setCacheEntry(cacheKey, { flags, etag, fetchedAt: Date.now(), ttl: effectiveTtl });
      this.circuit.recordSuccess();

      const value = flags[key];
      return { ok: true, value: value as T };
    } catch (err) {
      this.circuit.recordFailure();
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, error: { code: 'FETCH_FAILED', message } };
    }
  }

  async getAll(ctx?: UserContext, opts?: FlagsOptions): Promise<FlagsAllResult> {
    try {
      if (this.circuit.isOpen()) {
        return { ok: false, error: { code: 'CIRCUIT_OPEN', message: 'Circuit breaker open — evaluate endpoint unavailable' } };
      }

      const effectiveTtl = Math.max(opts?.ttl ?? 60, 10);
      const cacheKey = this.buildCacheKey(ctx);
      const cached = this.cache.get(cacheKey);

      if (!opts?.skipCache && cached && this.isCacheValid(cached)) {
        return { ok: true, flags: cached.flags };
      }

      const { flags, etag } = await this.fetchFlags(ctx, opts);
      this.setCacheEntry(cacheKey, { flags, etag, fetchedAt: Date.now(), ttl: effectiveTtl });
      this.circuit.recordSuccess();

      return { ok: true, flags };
    } catch (err) {
      this.circuit.recordFailure();
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, error: { code: 'FETCH_FAILED', message } };
    }
  }

  startPolling(ctx?: UserContext, opts?: FlagsOptions): { stop: () => void } {
    const effectiveTtl = Math.max(opts?.ttl ?? 60, 10);
    const intervalId = setInterval(() => {
      void this.getAll(ctx, { ...opts, ttl: effectiveTtl, skipCache: true });
    }, effectiveTtl * 1000);
    return { stop: () => clearInterval(intervalId) };
  }

  flush(cacheKey?: string): void {
    if (cacheKey !== undefined) {
      this.cache.delete(cacheKey);
    } else {
      this.cache.clear();
    }
  }
}
