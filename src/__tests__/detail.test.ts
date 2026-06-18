import { describe, it, expect } from "vitest";
import {
  detailBodyHeight,
  detailTextWidth,
  wrapLine,
  wrappedRowCount,
} from "../tui/components/DetailPane.js";

describe("detailBodyHeight", () => {
  it("reserves rows for header and border", () => {
    expect(detailBodyHeight(20, false)).toBe(16);
  });

  it("reduces height when composing", () => {
    expect(detailBodyHeight(20, true)).toBe(15);
  });

  it("never goes below 3", () => {
    expect(detailBodyHeight(4, true)).toBe(3);
  });
});

describe("detailTextWidth", () => {
  it("subtracts border and padding", () => {
    expect(detailTextWidth(20)).toBe(16);
  });

  it("never goes below 1", () => {
    expect(detailTextWidth(1)).toBe(1);
  });
});

describe("wrapLine", () => {
  it("returns single row for short lines", () => {
    expect(wrapLine("hello", 10)).toEqual(["hello"]);
  });

  it("wraps long lines at width boundaries", () => {
    expect(wrapLine("abcdefghij", 5)).toEqual(["abcde", "fghij"]);
  });

  it("handles empty lines", () => {
    expect(wrapLine("", 5)).toEqual([""]);
  });
});

describe("wrappedRowCount", () => {
  it("counts rows across multiple lines", () => {
    expect(wrappedRowCount(["hello", "world"], 10)).toBe(2);
  });

  it("accounts for wrapping", () => {
    expect(wrappedRowCount(["abcdefghijklmno"], 5)).toBe(3);
  });

  it("handles empty input", () => {
    expect(wrappedRowCount([], 10)).toBe(0);
  });
});
