import { describe, it, expect } from "vitest";
import {
  detailBodyHeight,
  detailTextWidth,
  wrapLine,
  wrappedRowCount,
  parseDiffFiles,
} from "../tui/components/DetailPane.js";

describe("detailBodyHeight", () => {
  it("reserves rows for the three-line header and border", () => {
    expect(detailBodyHeight(20, false)).toBe(15);
  });

  it("reduces height when composing", () => {
    expect(detailBodyHeight(20, true)).toBe(14);
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

describe("parseDiffFiles", () => {
  it("returns empty for empty string", () => {
    expect(parseDiffFiles("")).toEqual([]);
  });

  it("parses a single-file diff", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+new line
 old line`;
    const files = parseDiffFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/foo.ts");
    expect(files[0].content).toBe(diff);
  });

  it("parses a multi-file diff", () => {
    const file1 = `diff --git a/a.ts b/a.ts
index a..b 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
+change`;
    const file2 = `diff --git a/b.ts b/b.ts
index c..d 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +1,2 @@
+other`;
    const diff = `${file1}\n${file2}`;
    const files = parseDiffFiles(diff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("a.ts");
    expect(files[0].content).toBe(file1);
    expect(files[1].path).toBe("b.ts");
    expect(files[1].content).toBe(file2);
  });

  it("handles diff with no header path match", () => {
    const diff = `diff --git a/file b/file
index a..b 100644
--- a/file
+++ b/file
@@ -1 +1,2 @@
+x`;
    const files = parseDiffFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("file");
  });

  it("counts per-file insertions and deletions, ignoring the +++/--- headers", () => {
    const diff = `diff --git a/a.ts b/a.ts
index a..b 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 keep
-gone
+added one
+added two`;
    const [file] = parseDiffFiles(diff);
    // Two `+` body lines and one `-` body line; the `+++`/`---` headers and the
    // unchanged " keep" context line must not be counted.
    expect(file.insertions).toBe(2);
    expect(file.deletions).toBe(1);
  });

  it("tracks stats independently across files in a multi-file diff", () => {
    const file1 = `diff --git a/a.ts b/a.ts
index a..b 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1,3 @@
+one
+two`;
    const file2 = `diff --git a/b.ts b/b.ts
index c..d 100644
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1 @@
-removed`;
    const files = parseDiffFiles(`${file1}\n${file2}`);
    expect(files[0]).toMatchObject({ insertions: 2, deletions: 0 });
    expect(files[1]).toMatchObject({ insertions: 0, deletions: 1 });
  });

  it("reports zero lines for a binary file (no +/- body lines)", () => {
    const diff = `diff --git a/img.png b/img.png
index a..b 100644
Binary files a/img.png and b/img.png differ`;
    const [file] = parseDiffFiles(diff);
    expect(file).toMatchObject({ insertions: 0, deletions: 0 });
    // It still counts as a changed file even with no line delta.
    expect(file.path).toBe("img.png");
  });
});
