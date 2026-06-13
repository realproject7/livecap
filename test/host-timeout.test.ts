import { describe, it, expect } from "vitest";

import { TimeoutError, withTimeout } from "../src/host/timeout";

describe("withTimeout (#65 engine-readiness backstop)", () => {
  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it("rejects with a TimeoutError when the promise never settles", async () => {
    const never = new Promise<void>(() => {}); // a wedged engine.start()
    await expect(withTimeout(never, 20)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates the underlying rejection without waiting for the timeout", async () => {
    const boom = Promise.reject(new Error("engine spawn failed"));
    await expect(withTimeout(boom, 10_000)).rejects.toThrow("engine spawn failed");
  });

  it("does not fire after the promise has resolved", async () => {
    let timedOut = false;
    const result = await withTimeout(Promise.resolve("ok"), 30).catch((e: unknown) => {
      if (e instanceof TimeoutError) timedOut = true;
      throw e;
    });
    // Give a settled-but-cleared timer a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 60));
    expect(result).toBe("ok");
    expect(timedOut).toBe(false);
  });
});
