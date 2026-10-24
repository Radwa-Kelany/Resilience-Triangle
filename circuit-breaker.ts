export enum State {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  isServiceFailure?: (error: unknown) => boolean;
  onStateChange?: (from: State, to: State) => void;
}

interface ErrorLike {
  name?: string;
  status?: number;
  code?: string;
}

const SERVICE_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

export function defaultIsServiceFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const { name, status, code } = error as ErrorLike;

  if (name === 'AbortError') return false;
  if (typeof status === 'number') return status >= 500;
  if (name === 'TimeoutError') return true;
  if (code && SERVICE_ERROR_CODES.has(code)) return true;

  return false;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly isServiceFailure: (error: unknown) => boolean;
  private readonly onStateChange: (from: State, to: State) => void;

  private state: State = State.CLOSED;
  private failureCount = 0;
  private openedAt = 0;
  private halfOpenProbeInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 10_000;
    this.isServiceFailure = options.isServiceFailure ?? defaultIsServiceFailure;
    this.onStateChange = options.onStateChange ?? (() => {});
  }

  getState(): State {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const isProbe = this.allowRequest();

    try {
      const result = await operation();
      this.onSuccess(isProbe);
      return result;
    } catch (error) {
      this.onFailure(isProbe, this.isServiceFailure(error));
      throw error;
    }
  }

  private allowRequest(): boolean {
    if (this.state === State.OPEN) {
      if (Date.now() - this.openedAt < this.cooldownMs) {
        throw new CircuitOpenError('Circuit is open: request blocked during cooldown');
      }
      this.setState(State.HALF_OPEN);
    }

    if (this.state === State.HALF_OPEN) {
      if (this.halfOpenProbeInFlight) {
        throw new CircuitOpenError('Circuit is half-open: probe in progress');
      }
      this.halfOpenProbeInFlight = true;
      return true;
    }

    return false;
  }

  private onSuccess(isProbe: boolean): void {
    if (isProbe) {
      this.halfOpenProbeInFlight = false;
    }

    this.failureCount = 0;
    this.setState(State.CLOSED);
  }

  private onFailure(isProbe: boolean, isServiceFailure: boolean): void {
    if (isProbe) {
      this.halfOpenProbeInFlight = false;

      if (isServiceFailure) {
        this.open();
      }

      return;
    }

    if (!isServiceFailure) {
      return;
    }

    this.failureCount += 1;

    if (this.failureCount >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.openedAt = Date.now();
    this.setState(State.OPEN);
  }

  private setState(next: State): void {
    if (this.state === next) return;

    const previous = this.state;
    this.state = next;
    this.onStateChange(previous, next);
  }
}