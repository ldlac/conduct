import { describe, it, expect } from "vitest";
import { windowStart } from "../tui/components/DiffFileList.js";

describe("windowStart", () => {
  it("does not scroll when everything fits", () => {
    expect(windowStart(0, 3, 5)).toBe(0);
    expect(windowStart(2, 3, 5)).toBe(0);
    // Exactly filling the viewport still pins to the top.
    expect(windowStart(4, 5, 5)).toBe(0);
  });

  it("keeps the cursor centred once the list overflows", () => {
    // 20 files, viewport of 6, cursor in the middle: start = cursor - floor(6/2).
    expect(windowStart(10, 20, 6)).toBe(7);
  });

  it("pins to the top while the cursor is near the start", () => {
    expect(windowStart(0, 20, 6)).toBe(0);
    expect(windowStart(2, 20, 6)).toBe(0);
  });

  it("pins to the bottom while the cursor is near the end", () => {
    // Never scrolls past the last full window (count - rows).
    expect(windowStart(19, 20, 6)).toBe(14);
    expect(windowStart(18, 20, 6)).toBe(14);
  });

  it("never returns a negative or out-of-range start", () => {
    for (let cursor = 0; cursor < 20; cursor++) {
      const start = windowStart(cursor, 20, 6);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThanOrEqual(20 - 6);
    }
  });
});
