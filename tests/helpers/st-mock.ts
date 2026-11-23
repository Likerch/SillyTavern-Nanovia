// A small fake of SillyTavern 1.19 for browser-side tests. installStMock() installs globalThis.SillyTavern and toastr
// and a fetch that goes to `mock.fetchImpl` (set it to a FakeBackend's fetch). Every test gets a fresh instance.

type Listener = (...args: unknown[]) => unknown;

export class FakeEventSource {
    readonly events = new Map<string, Listener[]>();

    on(event: string, listener: Listener): void {
        this.list(event).push(listener);
    }

    makeFirst(event: string, listener: Listener): void {
        this.list(event).unshift(listener);
    }

    makeLast(event: string, listener: Listener): void {
        const list = this.list(event);
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
        list.push(listener);
    }

    removeListener(event: string, listener: Listener): void {
        const list = this.list(event);
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
    }

    async emit(event: string, ...args: unknown[]): Promise<void> {
        for (const listener of [...this.list(event)]) {
            try {
                await listener(...args);
            } catch {
                // ST swallows listener errors (public/lib/eventemitter.js).
            }
        }
    }

    count(event: string): number {
        return this.list(event).length;
    }

    private list(event: string): Listener[] {
        let list = this.events.get(event);
        if (!list) {
            list = [];
            this.events.set(event, list);
        }
        return list;
    }
}

export const EVENT_TYPES: Record<string, string> = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    SETTINGS_UPDATED: 'settings_updated',
    CONNECTION_PROFILE_CREATED: 'connection_profile_created',
    CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
    CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
};

export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4 };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };

export interface StMock {
    context: STContext;
    eventSource: FakeEventSource;
    extensionSettings: Record<string, unknown>;
    saveSettingsCalls: number;
    /** The CSRF token getRequestHeaders() reports. */
    csrfToken: string;
    locale: string;
    /** What the next callGenericPopup resolves to. */
    popupResult: unknown;
    popups: { content: unknown; type: number }[];
    /** Every fetch made through the mock, newest last. */
    requests: { url: string; init?: RequestInit }[];
    /** Where fetch goes; defaults to a 404. */
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** The fetch that was installed before the mock replaced it. */
    restore(): void;
    toasts: { kind: string; text: string }[];
}

let uuidCounter = 0;

/** Installs globalThis.SillyTavern, toastr and fetch fakes. Returns handles to drive the fake. */
export function installStMock(): StMock {
    const eventSource = new FakeEventSource();
    const previousFetch = globalThis.fetch;
    const previousTavern = (globalThis as unknown as { SillyTavern?: unknown }).SillyTavern;
    const previousToastr = (globalThis as unknown as { toastr?: unknown }).toastr;
    const mock = {
        eventSource,
        extensionSettings: { disabledExtensions: [] } as Record<string, unknown>,
        saveSettingsCalls: 0,
        csrfToken: 'csrf-token-1',
        locale: 'ru-ru',
        popupResult: POPUP_RESULT.AFFIRMATIVE as unknown,
        popups: [] as { content: unknown; type: number }[],
        requests: [] as { url: string; init?: RequestInit }[],
        toasts: [] as { kind: string; text: string }[],
        fetchImpl: async () => new Response('Not found', { status: 404 }),
    } as unknown as StMock;

    const context = {
        get extensionSettings() {
            return mock.extensionSettings;
        },
        eventSource,
        eventTypes: EVENT_TYPES,
        saveSettingsDebounced: () => {
            mock.saveSettingsCalls++;
        },
        getRequestHeaders: (options?: { omitContentType?: boolean }) => {
            const headers: Record<string, string> = { 'X-CSRF-Token': mock.csrfToken };
            if (!options?.omitContentType) headers['Content-Type'] = 'application/json';
            return headers;
        },
        getCurrentLocale: () => mock.locale,
        uuidv4: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
        POPUP_TYPE,
        POPUP_RESULT,
        callGenericPopup: async (content: unknown, type: number) => {
            mock.popups.push({ content, type });
            return mock.popupResult;
        },
        ConnectionManagerRequestService: {
            sendRequest: async () => ({}),
            getProfile: (id: string) => ({ id }),
            validateProfile: () => ({ selected: 'openai' }),
            getSupportedProfiles: () => {
                const manager = mock.extensionSettings['connectionManager'] as { profiles?: unknown[] } | undefined;
                return manager?.profiles ?? [];
            },
        },
    } as unknown as STContext;
    mock.context = context;

    (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
        getContext: () => context,
        libs: {},
    };
    const toast = (kind: string) => (text: string) => void mock.toasts.push({ kind, text });
    (globalThis as unknown as { toastr: unknown }).toastr = {
        success: toast('success'),
        info: toast('info'),
        warning: toast('warning'),
        error: toast('error'),
        clear: () => {},
    };

    (globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        mock.requests.push({ url, init });
        return mock.fetchImpl(input, init);
    };

    mock.restore = () => {
        (globalThis as unknown as { fetch: unknown }).fetch = previousFetch;
        (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = previousTavern;
        (globalThis as unknown as { toastr: unknown }).toastr = previousToastr;
    };

    return mock;
}

/** A Connection Manager profile as ST keeps it. */
export function seedConnectionManager(
    mock: StMock,
    profiles: STConnectionProfile[] = [],
): { profiles: STConnectionProfile[] } {
    const manager = { profiles, selectedProfile: null as string | null };
    mock.extensionSettings['connectionManager'] = manager;
    return manager;
}
