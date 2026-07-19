export class WheelCommandGate {
  private accumulator = 0;
  private direction = 0;
  private lockedUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold = 140, cooldownMs = 720) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  push(delta: number, now: number): -1 | 1 | null {
    const direction = Math.sign(delta);
    if (direction === 0 || now < this.lockedUntil) {
      return null;
    }

    if (direction !== this.direction) {
      this.accumulator = 0;
      this.direction = direction;
    }

    this.accumulator += Math.abs(delta);
    if (this.accumulator < this.threshold) {
      return null;
    }

    this.accumulator = 0;
    this.lockedUntil = now + this.cooldownMs;
    return direction as -1 | 1;
  }

  reset() {
    this.accumulator = 0;
    this.direction = 0;
    this.lockedUntil = 0;
  }
}

export class RepeatGate {
  private pressedAt = new Map<string, number>();
  private repeatedAt = new Map<string, number>();
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;

  constructor(initialDelayMs = 360, intervalMs = 110) {
    this.initialDelayMs = initialDelayMs;
    this.intervalMs = intervalMs;
  }

  shouldFire(control: string, pressed: boolean, now: number, repeat: boolean): boolean {
    if (!pressed) {
      this.pressedAt.delete(control);
      this.repeatedAt.delete(control);
      return false;
    }

    const pressedAt = this.pressedAt.get(control);
    if (pressedAt === undefined) {
      this.pressedAt.set(control, now);
      this.repeatedAt.set(control, now);
      return true;
    }

    if (!repeat || now - pressedAt < this.initialDelayMs) {
      return false;
    }

    const repeatedAt = this.repeatedAt.get(control) ?? pressedAt;
    if (now - repeatedAt < this.intervalMs) {
      return false;
    }

    this.repeatedAt.set(control, now);
    return true;
  }
}
