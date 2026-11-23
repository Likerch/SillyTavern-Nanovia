// Number formatting shared by the model picker and the Catalog tab. Pure: no DOM, no i18n.

/** Strips trailing zeros of a fixed-point number: 1.50 -> 1.5, 2.00 -> 2. */
export function trimZeros(text: string): string {
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** USD per 1M tokens, three significant digits: 0.0387 -> "0.0387", 0.6 -> "0.6", 15 -> "15", 0 -> "0". */
export function formatPrice(usdPer1M: number): string {
    if (!Number.isFinite(usdPer1M) || usdPer1M <= 0) return '0';
    const text = String(Number(usdPer1M.toPrecision(3)));
    return text.includes('e') ? trimZeros(usdPer1M.toFixed(6)) : text;
}

/** A price pair for a list row: "0.6 / 1.1". */
export function formatPricePair(prompt: number, completion: number): string {
    return `${formatPrice(prompt)} / ${formatPrice(completion)}`;
}

/** Tokens as K/M: 131072 -> "128K" (a multiple of 1024 counts in 1024s), 200000 -> "200K", 1048576 -> "1M"; null -> "?". */
export function formatContext(tokens: number | null): string {
    if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return '?';
    const binary = tokens % 1024 === 0 && tokens >= 1024;
    const k = binary ? 1024 : 1000;
    if (tokens >= k * k) return `${trimZeros((tokens / (k * k)).toFixed(1))}M`;
    if (tokens >= k) return `${trimZeros((tokens / k).toFixed(1))}K`;
    return String(tokens);
}
