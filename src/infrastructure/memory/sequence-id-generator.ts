import type { IdGenerator } from "../../application/ports.js";

/** Deterministic sequential ids so tests never depend on randomness. */
export class SequenceIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = "id") {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}
