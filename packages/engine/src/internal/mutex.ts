// Minimal async mutex. The CLI session holds one live turn at a time, so each
// translate()/summarize() call serializes its stdin write + response read.

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Acquire the lock; await the returned release before the next holder runs. */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}
