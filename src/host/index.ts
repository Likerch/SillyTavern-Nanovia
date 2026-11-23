// The only door to SillyTavern: the context, events, runtime module imports, and the few UI services ST owns
// (confirmation popup, toasts). The larger doors (plugin client, profiles, secrets, request hook) live in their own
// files and take this module's `ctx` as a dependency.
import { createHostEvents } from './events';
import type { HostEventsImpl } from './events';
import { createHostModules } from './modules';
import type { HostModulesImpl } from './modules';
import type { Logger } from './types';

export type { HostEvents, HostEventsImpl } from './events';
export type { HostModulesImpl, ModuleImporter, ModuleNamespace } from './modules';
export { QVINK_INTERCEPTOR, qvinkState, readStVersion } from './extensions';
export type { QvinkState } from './extensions';
export { createPluginClient, isPluginDown, parseConnectionView, parseStatus } from './plugin-client';
export type { PluginClient, PluginError, PluginErrorCode, PluginResult } from './plugin-client';
export { createPluginAccount } from './plugin-account';
export type { PluginAccount, SpendRange } from './plugin-account';
export { createProfilesHost, profileDrift, profileName } from './profiles';
export type { ProfileResult, ProfileSpec, ProfilesHost } from './profiles';
export { createSecretsHost } from './secrets';
export type { SecretWriteResult, SecretsHost } from './secrets';
export {
    addIncludeBody,
    addIncludeHeaders,
    hintsOf,
    inspectGenerateBody,
    installFetchHook,
    proxyHintsHook,
} from './fetch-hook';
export type {
    DirectRequestInfo,
    FetchHookHandle,
    GenerateRequest,
    RequestHook,
    RequestHooks,
    RequestTarget,
    ResponseInfo,
    ResponseObserver,
} from './fetch-hook';
export { applyPlan, createDirectMode, matchDirectConnection, planDifference, planDirectRequest } from './direct-mode';
export type { DirectConnectionRef, DirectMode, DirectModeDeps, DirectPlan, PlanDifference } from './direct-mode';
export { errorOf, tapUsage } from './usage-tap';
export type { UsageTapArgs } from './usage-tap';
export { isNanoGptUrl, parseProxyUrl } from './targets';
export type { Logger, Unsubscribe } from './types';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

export interface Host {
    /** Never cache the result: getContext() builds a new object on every call and ST reassigns parts of it. */
    ctx(): STContext;
    events: HostEventsImpl;
    modules: HostModulesImpl;
    /** ST's request headers (CSRF token, content type). */
    headers(options?: { omitContentType?: boolean }): Record<string, string>;
    /** ST's UI locale ('ru-ru'), when known. */
    locale(): string | undefined;
    /** ST's own confirmation popup (a plain `confirm` where it is missing). The text is shown as text, never as markup. */
    confirm(message: string, title?: string): Promise<boolean>;
    notify(kind: ToastKind, text: string): void;
    /** Removes every ST listener registered through this host. */
    dispose(): void;
}

function context(): STContext {
    return SillyTavern.getContext();
}

export function createHost(log: Logger): Host {
    const events = createHostEvents(context, log.scope('events'));
    const modules = createHostModules(log.scope('modules'));

    return {
        ctx: context,
        events,
        modules,

        headers: (options) => context().getRequestHeaders(options),

        locale(): string | undefined {
            try {
                const value = context().getCurrentLocale?.();
                return typeof value === 'string' && value ? value : undefined;
            } catch {
                return undefined;
            }
        },

        async confirm(message, title): Promise<boolean> {
            const ctx = context();
            if (typeof ctx.callGenericPopup === 'function' && typeof document !== 'undefined') {
                const body = document.createElement('div');
                if (title) {
                    const heading = document.createElement('h3');
                    heading.textContent = title;
                    body.appendChild(heading);
                }
                const text = document.createElement('div');
                text.textContent = message;
                text.style.whiteSpace = 'pre-wrap';
                body.appendChild(text);
                try {
                    const result = await ctx.callGenericPopup(body, ctx.POPUP_TYPE.CONFIRM);
                    return result === ctx.POPUP_RESULT.AFFIRMATIVE;
                } catch (error) {
                    log.warn('confirmation popup failed', error);
                    return false;
                }
            }
            return typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : false;
        },

        notify(kind, text): void {
            try {
                globalThis.toastr?.[kind](text);
            } catch (error) {
                log.debug('toast failed', error);
            }
        },

        dispose(): void {
            events.dispose();
        },
    };
}
