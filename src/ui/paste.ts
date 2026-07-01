import { Transform } from "node:stream";

/** Terminal bracketed-paste markers (FR-35). */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
/** Escapes written to enable / disable bracketed paste on the terminal. */
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";
/**
 * Private-use char (U+E000) standing in for a newline inside a paste, so
 * readline keeps the whole paste as one line instead of submitting at each
 * newline. Restored to a real newline on submit (see restorePaste).
 */
export const PASTE_NEWLINE = String.fromCodePoint(0xe000);

/** Length of the longest suffix of `data` that is a proper prefix of `marker`. */
function partialTailLength(data: string, marker: string): number {
  const max = Math.min(data.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (marker.startsWith(data.slice(data.length - n))) return n;
  }
  return 0;
}

/**
 * Stateful filter over the raw terminal byte stream. Outside a paste, bytes
 * pass through unchanged (so readline handles normal typing/editing). Inside a
 * paste (between the start/end markers), the markers are stripped and newlines
 * are replaced with PASTE_NEWLINE. Handles markers split across chunks.
 */
export class PasteFilter {
  private inPaste = false;
  private pending = ""; // held-back tail that might be a partial marker

  feed(input: string): string {
    let data = this.pending + input;
    this.pending = "";
    let out = "";

    while (data.length > 0) {
      const marker = this.inPaste ? PASTE_END : PASTE_START;
      const idx = data.indexOf(marker);
      if (idx !== -1) {
        const segment = data.slice(0, idx);
        out += this.inPaste ? segment.replace(/\r\n|\r|\n/g, PASTE_NEWLINE) : segment;
        data = data.slice(idx + marker.length);
        this.inPaste = !this.inPaste;
        continue;
      }
      // No full marker: emit everything except a possible partial marker tail.
      const hold = partialTailLength(data, marker);
      const emit = data.slice(0, data.length - hold);
      out += this.inPaste ? emit.replace(/\r\n|\r|\n/g, PASTE_NEWLINE) : emit;
      this.pending = data.slice(data.length - hold);
      data = "";
    }
    return out;
  }
}

/** A Transform stream applying PasteFilter to the byte stream feeding readline. */
export function createPasteFilterStream(): Transform {
  const filter = new PasteFilter();
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      cb(null, filter.feed(chunk.toString("utf8")));
    },
  });
}

/** Turn a submitted line's paste placeholders back into real newlines. */
export function restorePaste(line: string): string {
  return line.split(PASTE_NEWLINE).join("\n");
}
