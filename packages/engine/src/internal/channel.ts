// A single-producer/single-consumer async channel: the stdout reader pushes
// parsed events, the in-flight turn's async generator pulls them. Bridges the
// callback-style stream into `for await`.

export class AsyncChannel<T> {
  private readonly buffer: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;
  private error: Error | null = null;

  push(value: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  /** Close the channel; pending and future consumers see iteration end. */
  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error ?? null;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      // The generator below re-checks `error` after the resolve via next().
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve;
      });
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}
