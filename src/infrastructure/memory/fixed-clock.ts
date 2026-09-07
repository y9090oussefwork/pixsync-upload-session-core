import type { Clock } from "../../application/ports.js";

/** Deterministic clock for tests; no sleeps needed to observe expiry. */
export class FixedClock implements Clock {
  private current: number;

  constructor(startMs: number) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
