import { afterEach, describe, expect, it, vi } from "vitest";
import { RespondTimeoutError, withRespondTimeout } from "../../src/stream/shared";

describe("withRespondTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("passes through a response that settles in time", async () => {
    await expect(withRespondTimeout(Promise.resolve("sent"), 1000)).resolves.toBe("sent");
    await expect(withRespondTimeout(Promise.reject(new Error("refused")), 1000)).rejects.toThrow("refused");
  });

  it("rejects with RespondTimeoutError when the command never settles", async () => {
    vi.useFakeTimers();
    const pending = withRespondTimeout(new Promise<never>(() => {}), 20_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(RespondTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });
});
