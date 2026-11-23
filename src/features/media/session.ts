// What the Media tab remembers while it is closed and opened again, and what its parts tell each other: the section that was
// open, the catalog filters, the half-filled forms of the four studios, and whether the TTS provider is registered in ST.
// One session per page (the feature creates it); nothing here is persisted (images and audio are large, prompts are private).
import type { ModelSort, TtsKind } from '../../core/media-select';
import type { Unsubscribe } from '../../core/types';
import type { Medium } from '../../shared/contracts-media';
import { emptyImageDraft, emptySttDraft, emptyTtsDraft, emptyVideoDraft } from './param-form';
import type { ImageDraft, SttDraft, TtsDraft, VideoDraft } from './param-form';

export type MediaSection = 'catalog' | 'image' | 'tts' | 'stt' | 'video';
export const MEDIA_SECTIONS: readonly MediaSection[] = ['catalog', 'image', 'tts', 'stt', 'video'];

/** The studio each medium's models are used in. */
export const STUDIO_OF: Record<Medium, MediaSection> = { image: 'image', tts: 'tts', stt: 'stt', video: 'video' };

export const CATALOG_PAGE_SIZE = 50;

export interface CatalogFilters {
    medium: Medium;
    search: string;
    uncensored: boolean;
    sort: ModelSort;
    ttsKind: TtsKind;
    /** How many cards are drawn (the list is shown a page at a time). */
    shown: number;
}

/** Whether ST's TTS extension took the «Nanovia» provider. */
export type IntegrationStatus = 'pending' | 'active' | 'unavailable' | 'failed';

export interface IntegrationState {
    status: IntegrationStatus;
    /** Why it is not active (a short technical message, no secrets); null otherwise. */
    message: string | null;
}

export interface MediaSession {
    section: MediaSection;
    filters: CatalogFilters;
    image: ImageDraft;
    tts: TtsDraft;
    stt: SttDraft;
    video: VideoDraft;
    integration(): IntegrationState;
    setIntegration(status: IntegrationStatus, message?: string | null): void;
    onIntegration(listener: () => void): Unsubscribe;
    /** The catalog's «Use» button: the studio of that medium starts with this model, and opens. */
    pickModel(medium: Medium, id: string): void;
}

export function createSession(): MediaSession {
    let integration: IntegrationState = { status: 'pending', message: null };
    const listeners = new Set<() => void>();
    const session: MediaSession = {
        section: 'catalog',
        filters: {
            medium: 'image',
            search: '',
            uncensored: false,
            sort: 'name',
            ttsKind: 'speech',
            shown: CATALOG_PAGE_SIZE,
        },
        image: emptyImageDraft(),
        tts: emptyTtsDraft(),
        stt: emptySttDraft(),
        video: emptyVideoDraft(),
        integration: () => integration,
        setIntegration(status, message = null) {
            integration = { status, message };
            for (const listener of [...listeners]) listener();
        },
        onIntegration(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        pickModel(medium, id) {
            if (medium === 'image') session.image.model = id;
            else if (medium === 'tts') session.tts.model = id;
            else if (medium === 'stt') session.stt.model = id;
            else session.video.model = id;
            session.section = STUDIO_OF[medium];
        },
    };
    return session;
}
