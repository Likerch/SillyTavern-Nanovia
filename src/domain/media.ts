// Pure logic of the media stage (contracts-media.ts): turning NanoGPT's heterogeneous model lists into MediaModel and
// estimating what a call costs from the catalog price. NO DOM, NO network.
//
// THIS FILE IS A SIGNATURE STUB committed with the contracts so the browser and server agents can build in parallel; the
// server agent (stage 0.7, part a) owns and fills it in. Do not change the exported signatures without telling the other side:
// the browser imports the four `estimate*` functions and `normalizeMediaList`.
import type { MediaModel, MediaPrice, Medium } from '../shared/contracts-media';

/**
 * One model list as NanoGPT sent it (`data` array of `GET /api/v1/images/models?detailed=true`, `/video-models`,
 * `/audio-models?type=tts|stt`) -> MediaModel[]. Tolerant: an entry that cannot be read is dropped, a field that cannot be
 * read gets its neutral value; never throws. For `tts`, music/processing models are kept but flagged `capabilities.music`
 * (selecting speech models is `capabilities.textToImage`-style filtering in the UI, not here).
 */
export function normalizeMediaList(_medium: Medium, _raw: unknown): MediaModel[] {
    return [];
}

/** USD for `n` images of `size` (`WxH` or a size token the price list names); null when not computable. */
export function estimateImageCost(_model: MediaModel, _request: { n?: number; size?: string }): number | null {
    return null;
}

/** USD for a video of `duration` seconds at `resolution`; null when not computable (the price is approximate or missing). */
export function estimateVideoCost(
    _model: MediaModel,
    _request: { duration?: number; resolution?: string },
): number | null {
    return null;
}

/** USD for `chars` characters of speech; null when not computable. */
export function estimateTtsCost(_model: MediaModel, _chars: number): number | null {
    return null;
}

/** USD for `seconds` of audio to transcribe; null when not computable. */
export function estimateSttCost(_model: MediaModel, _seconds: number): number | null {
    return null;
}

/** A price as a short, locale-free string for logs and tests (`0.0017/image`, `0.0017-0.0051/image`, `?`); the UI words it itself. */
export function describePrice(price: MediaPrice): string {
    if (price.from === null) return '?';
    const range = price.to !== null && price.to !== price.from ? `${price.from}-${price.to}` : `${price.from}`;
    return `${range}/${price.unit}`;
}
