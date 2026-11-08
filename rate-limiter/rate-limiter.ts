export class RateLimitedError extends Error {
  constructor() {
    super("rate limited");
    this.name = "RateLimitedError";
    Object.setPrototypeOf(this, RateLimitedError.prototype);
  }
}

export type Clock = () => number;

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly tokensNeeded = 1;

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number,
    private readonly now: Clock = () => performance.now() / 1000
  ) {
    if (capacity < 1 || refillRate <= 0) {
      throw new Error("capacity must be at least 1 and refillRate must be greater than 0");
    }
    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  allowRequest(): boolean {
    this.refill();
    if (this.tokens >= this.tokensNeeded) {
      this.tokens -= this.tokensNeeded;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}