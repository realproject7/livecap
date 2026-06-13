// A small promise timeout (#65). The session host awaits engine readiness (the
// local tier may download a multi-GB model on first run); the per-chunk stall
// detection in `ensureModel` is the primary guard, but this is the host-side
// backstop so a truly wedged start surfaces a real, content-free status to the
// strip instead of hanging the message chain forever.

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Resolve `promise`, but reject with a [`TimeoutError`] if it has not settled
 * within `ms`. The timer is cleared as soon as `promise` settles and is
 * `unref`'d so it never by itself keeps the host process alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}
