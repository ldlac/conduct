// In-place frame writer that removes the terminal flicker from Ink's redraw.
//
// Ink redraws via `log-update`, which writes `eraseLines(N) + newFrame`: it
// erases all N old lines, then writes the new ones. On Windows Terminal (incl.
// WSL) the compositor can present a refresh in the window between the erase and
// the rewrite, so you briefly see blank lines — the flicker. (The full-screen
// `clearTerminal` wipe Ink falls back to when the frame reaches the terminal
// height is far worse; App keeps us off it with an `overflow: hidden` root box.)
//
// This rewrites each frame to repaint *in place*: move the cursor back to the
// top of the frame without erasing, then overwrite line by line. Every cell
// transitions directly old-glyph -> new-glyph, so there's nothing to flash.

// The exact prefix ansi-escapes' eraseLines(n) emits: n repetitions of "\x1b[2K"
// (erase whole line) each followed (except the last) by "\x1b[1A" (cursor up),
// terminated by "\x1b[G" (cursor to column 1). log-update prepends this to every
// frame to wipe the previous one before redrawing.
const ERASE_LINES_RE = /^(?:\x1b\[2K(?:\x1b\[1A)?)+\x1b\[G/;

/**
 * Convert one Ink frame from erase-then-redraw into an in-place overwrite.
 *
 * The leading eraseLines block becomes a bare cursor move back to the top of
 * the frame (no erasing); then each new line is written followed by `\x1b[K`
 * (erase to end of line) and the whole thing ends with `\x1b[J` (erase below).
 * The only erasing left clears the tail of a now-shorter line or lines below a
 * now-shorter frame — never a cell that's about to be overwritten — so no cell
 * is blanked then refilled. Visually equivalent to log-update across
 * grow/shrink/recolor/clear cases.
 *
 * Frames without the eraseLines prefix (the very first frame, a BEL, cursor
 * show/hide) are returned untouched.
 */
export function inPlaceFrame(str: string): string {
  const m = str.match(ERASE_LINES_RE);
  if (!m) return str;
  const prefix = m[0];
  const prevLineCount = (prefix.match(/\x1b\[2K/g) ?? []).length;
  const body = str.slice(prefix.length);
  // Move to the top-left of the previous frame without erasing anything.
  const out = (prevLineCount > 1 ? `\x1b[${prevLineCount - 1}A` : "") + "\r";
  // A bare eraseLines with no body is log-update's clear() — wipe the region.
  if (body.length === 0) return out + "\x1b[J";
  // `body` is `frame + "\n"`; the trailing newline yields a final "" we drop.
  const lines = body.split("\n").slice(0, -1);
  return out + lines.map((line) => line + "\x1b[K\n").join("") + "\x1b[J";
}

/**
 * Wrap a TTY stdout so every write Ink makes is routed through
 * {@link inPlaceFrame}. A Proxy keeps the stream otherwise intact — `rows`,
 * `columns`, `resize` events, `isTTY` and the rest forward to the real stream
 * live — so Ink's layout and resize handling are unaffected.
 */
export function flickerFreeStdout(real: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "write") {
        return (chunk: unknown, ...rest: unknown[]) =>
          typeof chunk === "string"
            ? (target.write as (...a: unknown[]) => boolean)(
                inPlaceFrame(chunk),
                ...rest,
              )
            : (target.write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;
}
