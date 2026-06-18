import { describe, it, expect } from "vitest";
import { inPlaceFrame, flickerFreeStdout } from "../tui/flicker-free-stdout.js";

// Replicates ansi-escapes@7's eraseLines(n) byte-for-byte, so the test exercises
// exactly the prefix ink prepends to frames without depending on the (transitive)
// ansi-escapes package directly.
function eraseLines(count: number): string {
  let clear = "";
  for (let i = 0; i < count; i++)
    clear += "\x1b[2K" + (i < count - 1 ? "\x1b[1A" : "");
  if (count) clear += "\x1b[G";
  return clear;
}

// Replicates ink's log-update render loop (build/log-update.js): every frame is
// written as `eraseLines(previousLineCount) + frame + "\n"`. This is the exact
// input inPlaceFrame has to transform.
function makeLogUpdate(write: (s: string) => void) {
  let previousLineCount = 0;
  let previousOutput = "";
  return (str: string) => {
    const output = str + "\n";
    if (output === previousOutput) return;
    previousOutput = output;
    write(eraseLines(previousLineCount) + output);
    previousLineCount = output.split("\n").length;
  };
}

// Minimal terminal emulator for the escape subset both paths use, so we can
// assert the *visible* result of inPlaceFrame matches plain log-update.
function makeTerm(rows = 60, cols = 100) {
  const grid: string[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(" "),
  );
  let cr = 0;
  let cc = 0;
  const scroll = () => {
    while (cr >= rows) {
      grid.shift();
      grid.push(Array(cols).fill(" "));
      cr--;
    }
  };
  const write = (data: string) => {
    for (let i = 0; i < data.length; ) {
      if (data[i] === "\x1b" && data[i + 1] === "[") {
        let j = i + 2;
        let num = "";
        while (j < data.length && data[j] >= "0" && data[j] <= "9")
          num += data[j++];
        const cmd = data[j];
        const k = num === "" ? null : Number.parseInt(num, 10);
        if (cmd === "A") cr = Math.max(0, cr - (k ?? 1));
        else if (cmd === "B") cr = Math.min(rows - 1, cr + (k ?? 1));
        else if (cmd === "G") cc = 0;
        else if (cmd === "K") for (let x = cc; x < cols; x++) grid[cr][x] = " ";
        else if (cmd === "J") {
          for (let x = cc; x < cols; x++) grid[cr][x] = " ";
          for (let y = cr + 1; y < rows; y++) grid[y].fill(" ");
        }
        // "2K" (num "2", cmd "K") with cc at col 0 clears the whole line, which
        // is how log-update uses it; SGR ("m") is ignored for visible compare.
        i = j + 1;
        continue;
      }
      const ch = data[i];
      if (ch === "\n") {
        cr++;
        cc = 0;
        scroll();
      } else if (ch === "\r") {
        cc = 0;
      } else {
        if (cc < cols) grid[cr][cc] = ch;
        cc++;
      }
      i++;
    }
  };
  const snapshot = () =>
    grid
      .map((r) => r.join("").replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n+$/, "");
  return { write, snapshot };
}

const color = (s: string) => `\x1b[32m${s}\x1b[39m`;

const SEQUENCES: string[][] = [
  ["a", "ab", "abc"], // single line growing
  ["l1\nl2\nl3", "l1\nl2", "l1", "l1\nl2\nl3\nl4"], // grow + shrink
  ["x\ny\nz", "p\nq\nr", "p\nq\nr"], // same height + no-op repeat
  [`${color("hi")}\nworld`, `${color("HI")}\nworld!!`, "short"], // color + shrink
  ["aaaa\nbbbb", "a\nb"], // shrink line width: tails must clear
  ["one\ntwo\nthree\nfour\nfive", "X"], // big shrink
  ["", "first", "", "second"], // empty frames interleaved
];

describe("inPlaceFrame", () => {
  it("renders the same visible screen as ink's log-update", () => {
    for (const frames of SEQUENCES) {
      const ref = makeTerm();
      const test = makeTerm();
      const refLog = makeLogUpdate(ref.write);
      const testLog = makeLogUpdate((data) => test.write(inPlaceFrame(data)));
      for (const f of frames) {
        refLog(f);
        testLog(f);
      }
      expect(test.snapshot(), JSON.stringify(frames)).toBe(ref.snapshot());
    }
  });

  it("never blanks a cell before repainting (no full-line erase in a redraw)", () => {
    // A redraw frame must not contain eraseLine ("\x1b[2K"), which is what
    // causes the blank-then-paint flash; only end-of-line/below erases are ok.
    const redraw = inPlaceFrame(eraseLines(2) + "new1\nnew2\n");
    expect(redraw).not.toContain("\x1b[2K");
    expect(redraw).toContain("\x1b[K");
  });

  it("moves the cursor up to the top of the previous frame, not down", () => {
    const redraw = inPlaceFrame(eraseLines(3) + "a\nb\nc\n");
    expect(redraw.startsWith("\x1b[2A\r")).toBe(true); // up prevLineCount-1
  });

  it("passes through frames with no eraseLines prefix (first frame, BEL)", () => {
    expect(inPlaceFrame("first frame\n")).toBe("first frame\n");
    expect(inPlaceFrame("\x07")).toBe("\x07");
  });

  it("treats a bodyless eraseLines (log-update clear) as a region wipe", () => {
    expect(inPlaceFrame(eraseLines(4))).toBe("\x1b[3A\r\x1b[J");
  });
});

describe("flickerFreeStdout", () => {
  it("routes string writes through inPlaceFrame and forwards everything else", () => {
    const writes: string[] = [];
    const fake = {
      isTTY: true,
      rows: 42,
      columns: 137,
      write: (chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      },
      on() {
        return this;
      },
    } as unknown as NodeJS.WriteStream;

    const wrapped = flickerFreeStdout(fake);
    // Live property forwarding for layout/resize.
    expect(wrapped.rows).toBe(42);
    expect(wrapped.columns).toBe(137);
    expect(wrapped.isTTY).toBe(true);

    wrapped.write(eraseLines(2) + "hello\nthere\n");
    expect(writes[0]).not.toContain("\x1b[2K"); // transformed
    expect(writes[0]).toContain("hello");

    // Non-string (Buffer) writes pass through untouched.
    const buf = Buffer.from("raw");
    wrapped.write(buf);
    expect(writes[1]).toBe("raw");
  });
});
