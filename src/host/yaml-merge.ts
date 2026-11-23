// A conservative merge of entries into the YAML text of ST's `custom_include_headers` / `custom_include_body`.
//
// ST merges those fields on the server (`yaml.parse` + Object.assign); one parse error drops the whole field, and a
// duplicate key is a parse error. The browser has no YAML library, so this module only handles shapes it can prove it
// understands and refuses everything else:
//   - empty or comment-only text,
//   - a block mapping whose top-level lines are plain `key: value` lines (nested and multi-line values are skipped over),
//   - a JSON object or an array of JSON objects (JSON is YAML).
// The user's own entries are never changed: a key the user already set (headers: compared without case) is left alone
// and ours is not added. Added values are written as JSON, which is always valid YAML.

export type YamlMergeResult =
    { ok: true; text: string; added: string[]; kept: string[] } | { ok: false; reason: string };

export interface YamlMergeOptions {
    /** Compare keys without case (HTTP header names). */
    ignoreCase?: boolean;
}

/** `key:` at the start of a top-level line: quoted, or plain without ':' and '#'. */
const KEY_LINE =
    /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-?:[\]{}&*!|>%@`,][^:#]*?|-[^\s:#][^:#]*?))[ \t]*:(?:[ \t]|$)/;

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const RESERVED_KEY = /^(?:true|false|null|yes|no|on|off|y|n)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatKey(key: string): string {
    return PLAIN_KEY.test(key) && !RESERVED_KEY.test(key) ? key : JSON.stringify(key);
}

function decodeKey(match: RegExpExecArray): string {
    if (match[1] !== undefined) {
        try {
            return JSON.parse(`"${match[1]}"`) as string;
        } catch {
            return match[1];
        }
    }
    if (match[2] !== undefined) return match[2].replace(/''/g, "'");
    return (match[3] ?? '').trim();
}

function split(
    entries: Record<string, unknown>,
    has: (key: string) => boolean,
): { add: [string, unknown][]; kept: string[] } {
    const add: [string, unknown][] = [];
    const kept: string[] = [];
    for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) continue;
        if (has(key)) kept.push(key);
        else add.push([key, value]);
    }
    return { add, kept };
}

/** Merges `entries` into the YAML `existing`; ok:false (with a reason for the debug log) when it cannot do it safely. */
export function mergeYamlEntries(
    existing: string | null | undefined,
    entries: Record<string, unknown>,
    options: YamlMergeOptions = {},
): YamlMergeResult {
    const text = typeof existing === 'string' ? existing : '';
    const fold = (key: string): string => (options.ignoreCase ? key.toLowerCase() : key);
    const lines = text.split(/\r?\n/);
    const isBlank = (line: string): boolean => line.trim() === '' || line.trim().startsWith('#');
    const first = lines.find((line) => !isBlank(line));

    if (first === undefined) {
        const { add, kept } = split(entries, () => false);
        if (add.length === 0) return { ok: true, text, added: [], kept };
        const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
        const body = add.map(([key, value]) => `${formatKey(key)}: ${JSON.stringify(value)}`).join('\n');
        return { ok: true, text: `${base}${body}\n`, added: add.map(([key]) => key), kept };
    }

    const lead = first.trimStart();
    if (lead.startsWith('{') || lead.startsWith('[')) return mergeJson(text, entries, fold);

    if (/^\s/.test(first)) return { ok: false, reason: 'the first entry is indented' };
    if (lead === '-' || lead.startsWith('- ')) return { ok: false, reason: 'a block sequence' };

    const present = new Set<string>();
    for (const line of lines) {
        if (isBlank(line) || /^\s/.test(line)) continue;
        if (/^(?:---|\.\.\.)(?:\s|$)/.test(line)) return { ok: false, reason: 'a document marker' };
        const match = KEY_LINE.exec(line);
        if (!match) return { ok: false, reason: 'a top-level line that is not a plain "key: value"' };
        present.add(fold(decodeKey(match)));
    }

    const { add, kept } = split(entries, (key) => present.has(fold(key)));
    if (add.length === 0) return { ok: true, text, added: [], kept };
    const base = text.endsWith('\n') ? text : `${text}\n`;
    const body = add.map(([key, value]) => `${formatKey(key)}: ${JSON.stringify(value)}`).join('\n');
    return { ok: true, text: `${base}${body}\n`, added: add.map(([key]) => key), kept };
}

function mergeJson(text: string, entries: Record<string, unknown>, fold: (key: string) => string): YamlMergeResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.trim());
    } catch {
        return { ok: false, reason: 'a flow collection that is not plain JSON' };
    }
    if (isRecord(parsed)) {
        const present = new Set(Object.keys(parsed).map(fold));
        const { add, kept } = split(entries, (key) => present.has(fold(key)));
        if (add.length === 0) return { ok: true, text, added: [], kept };
        const merged: Record<string, unknown> = { ...parsed };
        for (const [key, value] of add) merged[key] = value;
        return { ok: true, text: JSON.stringify(merged), added: add.map(([key]) => key), kept };
    }
    if (Array.isArray(parsed) && parsed.every(isRecord)) {
        const present = new Set(parsed.flatMap((item) => Object.keys(item).map(fold)));
        const { add, kept } = split(entries, (key) => present.has(fold(key)));
        if (add.length === 0) return { ok: true, text, added: [], kept };
        const extra: Record<string, unknown> = {};
        for (const [key, value] of add) extra[key] = value;
        return { ok: true, text: JSON.stringify([...parsed, extra]), added: add.map(([key]) => key), kept };
    }
    return { ok: false, reason: 'JSON that is not an object or a list of objects' };
}
