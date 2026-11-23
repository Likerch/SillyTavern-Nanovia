// Server-sent events on the proxy's response path: an incremental splitter that never alters a byte, and the rewriting of
// the events that carry `usage` (everything else is forwarded as it came). Pure: no clock, no I/O.
import type { ResolvedUsage, ShimContext } from './shim';
import { shimSsePayload } from './shim';

/**
 * Cuts a byte or text stream into SSE events. Every returned string is one event exactly as received, with its blank-line
 * terminator, so the concatenation of all returned strings plus nothing else is the input. Line ends may be LF, CRLF or CR
 * (a CR at the end of a chunk waits for the next one). Multi-byte UTF-8 split across chunks is decoded correctly (invalid
 * bytes become U+FFFD, a BOM stays as a character). Blank lines before the first field of an event travel with it.
 */
export class SseSplitter {
    private readonly decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
    /** Text of the event being collected (and any complete events not yet returned). */
    private buf = '';
    /** Scan position inside `buf`; always the start of a line. */
    private pos = 0;
    /** The event being collected already has a non-blank line. */
    private content = false;

    /** Adds a chunk and returns the events that are now complete (in order, possibly none). */
    feed(chunk: string | Uint8Array): string[] {
        this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
        return this.drain(false);
    }

    /** End of stream: returns what is left (an event the server never terminated) as one string, or nothing. */
    flush(): string[] {
        this.buf += this.decoder.decode();
        const out = this.drain(true);
        if (this.buf.length > 0) out.push(this.buf);
        this.buf = '';
        this.pos = 0;
        this.content = false;
        return out;
    }

    private drain(final: boolean): string[] {
        const out: string[] = [];
        const buf = this.buf;
        let from = 0;
        let pos = this.pos;
        for (;;) {
            const line = scanLine(buf, pos, final);
            if (line === null) break;
            const next = pos + line.length + line.terminator;
            if (line.length > 0) {
                this.content = true;
            } else if (this.content) {
                out.push(buf.slice(from, next));
                from = next;
                this.content = false;
            }
            pos = next;
        }
        if (from > 0) this.buf = buf.slice(from);
        this.pos = pos - from;
        return out;
    }
}

/** The line starting at `pos`: its length without the terminator and the terminator's length; null while it is incomplete. */
function scanLine(buf: string, pos: number, final: boolean): { length: number; terminator: number } | null {
    for (let i = pos; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c === 10) return { length: i - pos, terminator: 1 };
        if (c === 13) {
            if (i + 1 < buf.length) return { length: i - pos, terminator: buf.charCodeAt(i + 1) === 10 ? 2 : 1 };
            return final ? { length: i - pos, terminator: 1 } : null;
        }
    }
    return null;
}

export interface SseRewrite {
    /** The event to forward: the identical string unless its usage was rewritten. */
    text: string;
    /** The facts of the rewritten usage; null when the event had none (and so was not touched). */
    resolved: ResolvedUsage | null;
}

// [\s\S] rather than `.`: JSON.stringify leaves U+2028 and U+2029 unescaped and `.` would stop at them.
const BOM = String.fromCharCode(0xfeff);
const DATA_LINE = new RegExp(`^(${BOM}?data:)( ?)([\\s\\S]*)$`);

/**
 * Rewrites one raw event (as the splitter returns it) when its `data` field is a JSON chunk with usage. Comments, `event:`,
 * `id:` and `retry:` lines, line endings and the blank-line terminator are kept; a multi-line `data` field (joined with
 * newlines, as the SSE rules say) becomes one line. Events without usage, `[DONE]` and non-JSON data are returned untouched.
 */
export function rewriteSseEvent(rawEvent: string, ctx: ShimContext): SseRewrite {
    const unchanged: SseRewrite = { text: rawEvent, resolved: null };
    if (!rawEvent.includes('usage')) return unchanged;
    const lines = splitLines(rawEvent);
    const dataLines: Array<{ index: number; match: RegExpExecArray }> = [];
    lines.forEach((line, index) => {
        const match = DATA_LINE.exec(line.text);
        if (match) dataLines.push({ index, match });
    });
    const first = dataLines[0];
    if (!first) return unchanged;
    const payload = dataLines.map((d) => d.match[3] ?? '').join('\n');
    const { data, resolved } = shimSsePayload(payload, ctx);
    if (!resolved) return unchanged;
    const drop = new Set(dataLines.slice(1).map((d) => d.index));
    let text = '';
    lines.forEach((line, index) => {
        if (drop.has(index)) return;
        text += (index === first.index ? `${first.match[1]}${first.match[2]}${data}` : line.text) + line.end;
    });
    return { text, resolved };
}

/**
 * Runs a whole SSE text through the splitter and the rewriting; returns the forwarded text. For tests and for callers
 * that hold the full response (the streaming proxy feeds a `SseSplitter` chunk by chunk and calls `rewriteSseEvent`).
 */
export function processSseText(text: string, ctx: ShimContext): string {
    const splitter = new SseSplitter();
    const events = [...splitter.feed(text), ...splitter.flush()];
    return events.map((event) => rewriteSseEvent(event, ctx).text).join('');
}

function splitLines(raw: string): Array<{ text: string; end: string }> {
    const lines: Array<{ text: string; end: string }> = [];
    let start = 0;
    while (start < raw.length) {
        let i = start;
        while (i < raw.length && raw.charCodeAt(i) !== 10 && raw.charCodeAt(i) !== 13) i++;
        let end = '';
        if (i < raw.length) end = raw.charCodeAt(i) === 13 && raw.charCodeAt(i + 1) === 10 ? '\r\n' : raw.charAt(i);
        lines.push({ text: raw.slice(start, i), end });
        start = i + end.length;
    }
    return lines;
}
