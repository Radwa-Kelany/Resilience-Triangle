import { TokenBucket } from "../rate-limiter/rate-limiter";

export type FailureKind = "http" | "timeout" | "connection" | "cancelled";

export class RequestError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(`${kind}${status !== undefined ? ` ${status}` : ""}`);
    this.name = "RequestError";
  }
}

export function isRetryable(error: RequestError): boolean {
  switch (error.kind) {
    case "timeout":
    case "connection":
      return true;
    case "cancelled":
      return false;
    case "http": {
      const status = error.status ?? 0;
      return status >= 500 || status === 429;
    }
  }
}

export interface CallOptions {
  safeToRepeat?: boolean;
  idempotencyKey?: string;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  totalTimeoutMs: number;
  budget: { capacity: number; refillRate: number };
  requireIdempotencyKey?: boolean;
}

export interface Runtime {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export class Backoff {
  constructor(
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
    private readonly random: () => number
  ) {}

  nextDelay(retryNumber: number): number {
    const limit = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * Math.pow(2, retryNumber - 1)
    );
    return this.random() * limit;
  }
}

interface Policy {
  config: RetryConfig;
  backoff: Backoff;
  budget: TokenBucket;
}

const defaultRuntime: Runtime = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

function hasKey(options: CallOptions): boolean {
  return options.idempotencyKey !== undefined && options.idempotencyKey !== "";
}

function canRepeat(config: RetryConfig, options: CallOptions): boolean {
  if (config.requireIdempotencyKey === true) {
    return hasKey(options);
  }
  return options.safeToRepeat === true || hasKey(options);
}

export class RetryExecutor {
  private readonly policies = new Map<string, Policy>();
  private readonly runtime: Runtime;

  constructor(
    configs: Record<string, RetryConfig>,
    runtime: Partial<Runtime> = {}
  ) {
    this.runtime = { ...defaultRuntime, ...runtime };
    for (const [providerName, config] of Object.entries(configs)) {
      this.policies.set(providerName, {
        config,
        backoff: new Backoff(
          config.baseDelayMs,
          config.maxDelayMs,
          this.runtime.random
        ),
        budget: new TokenBucket(config.budget.capacity, config.budget.refillRate),
      });
    }
  }

  async execute<T>(
    providerName: string,
    operation: () => Promise<T>,
    options: CallOptions = {}
  ): Promise<T> {
    const policy = this.policies.get(providerName);
    if (!policy) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    const { config, backoff, budget } = policy;
    const allowedAttempts = canRepeat(config, options) ? config.maxAttempts : 1;
    const deadline = this.runtime.now() + config.totalTimeoutMs;
    let attempt = 1;

    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof RequestError) || !isRetryable(error)) {
          throw error;
        }
        if (attempt >= allowedAttempts) {
          throw error;
        }

        const delay =
          error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : backoff.nextDelay(attempt);

        if (this.runtime.now() + delay > deadline) {
          throw error;
        }

        if (!budget.allowRequest()) {
          throw error;
        }

        await this.runtime.sleep(delay);
        attempt += 1;
      }
    }
  }
}