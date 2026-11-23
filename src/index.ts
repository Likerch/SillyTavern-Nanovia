// Entry point loaded by SillyTavern as <script type="module">. Lifecycle hooks are the exported functions named in
// manifest.json `hooks`; ST calls them without arguments, each with a 5 s timeout.
// No side effects at module top level: ST imports this module even for the `enable` hook.
import './ui/style.css';
import { startNanovia } from './app/app';
import type { Runtime } from './app/app';
import { SETTINGS_KEY } from './core/settings';

let runtime: Runtime | null = null;
let starting: Promise<Runtime> | null = null;

/** hooks.activate */
export async function onActivate(): Promise<void> {
    if (runtime || starting) return;
    starting = startNanovia();
    try {
        runtime = await starting;
        console.info('[Nanovia] activated');
    } catch (error) {
        console.error('[Nanovia] activation failed', error);
    } finally {
        starting = null;
    }
}

/** hooks.disable: quick cleanup within ST's 5 s window (NANOVIA_API and the fetch wrapper go away with it). */
export async function onDisable(): Promise<void> {
    const pending = starting;
    if (pending) await pending.catch(() => undefined);
    const current = runtime;
    runtime = null;
    await current?.stop();
}

/** hooks.enable */
export async function onEnable(): Promise<void> {
    // ST reloads the page after enabling; activation happens then.
}

/** hooks.install */
export async function onInstall(): Promise<void> {
    // Nothing to prepare: settings get their defaults on the first activation.
}

/** hooks.update */
export async function onUpdate(): Promise<void> {
    // Settings migrations run on activation.
}

/** hooks.delete */
export async function onDelete(): Promise<void> {
    await onDisable();
}

/**
 * hooks.clean: removes Nanovia's settings. Connection Manager profiles and ST secrets that Nanovia wrote stay (the
 * profiles are recognisable by their name prefix); the user deletes them in ST if they want them gone.
 */
export async function onClean(): Promise<void> {
    const current = runtime;
    await onDisable();
    if (current) {
        current.settings.reset();
        return;
    }
    try {
        const context = SillyTavern.getContext();
        delete context.extensionSettings[SETTINGS_KEY];
        context.saveSettingsDebounced();
    } catch (error) {
        console.error('[Nanovia] could not clean settings', error);
    }
}
