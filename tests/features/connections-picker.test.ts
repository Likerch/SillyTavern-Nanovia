// @vitest-environment happy-dom
// The model field of the connection form is the catalog's model picker, and stays a plain text field without a catalog.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderConnectionsTab } from '../../src/features/connections/view';
import { GLM, createCatalogRig } from '../helpers/catalog-fakes';
import type { CatalogRig } from '../helpers/catalog-fakes';
import { createContext } from '../helpers/context';
import type { TestContext } from '../helpers/context';
import { flush } from '../helpers/fakes';
import { createHarness } from '../helpers/harness';
import type { Harness } from '../helpers/harness';

let h: Harness;
let tc: TestContext;
let rig: CatalogRig;
let root: HTMLElement;
let dispose: () => void;

beforeEach(async () => {
    h = createHarness();
    tc = createContext(h);
    rig = createCatalogRig();
    root = document.createElement('div');
    document.body.appendChild(root);
});

afterEach(() => {
    dispose?.();
    root.remove();
    h.restore();
});

async function openForm(): Promise<void> {
    await h.connections.refresh();
    dispose = renderConnectionsTab(root, tc.ctx);
    const create = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New connection');
    create?.click();
    await flush();
    await flush();
}

const modelInput = (): HTMLInputElement => {
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Model id"]');
    if (!input) throw new Error('no model field');
    return input;
};

function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function save(): Promise<void> {
    [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')?.click();
    await flush();
    await flush();
}

describe('the model field of the connection form', () => {
    it('is a combobox over the catalog: focusing it loads the catalog and lists models, picking one sets the id', async () => {
        await rig.store.refresh();
        Object.assign(tc.ctx, { catalog: rig.store });
        await openForm();
        const input = modelInput();
        expect(input.getAttribute('role')).toBe('combobox');
        input.dispatchEvent(new Event('focus'));
        const option = root.querySelector<HTMLElement>(`.nanovia-picker-option[data-model="${GLM}"]`);
        expect(option?.textContent).toContain('GLM 5.3');
        option?.click();
        expect(input.value).toBe(GLM);

        type(root.querySelector<HTMLInputElement>('input[aria-label="Name"]') as HTMLInputElement, 'Pick test');
        await save();
        const [created] = [...h.backend.plugin.connections.values()];
        expect(created).toMatchObject({ name: 'Pick test', modelId: GLM });
    });

    it('still takes any id typed by hand, with or without the catalog', async () => {
        await openForm();
        type(modelInput(), 'custom/typed-id');
        type(root.querySelector<HTMLInputElement>('input[aria-label="Name"]') as HTMLInputElement, 'By hand');
        await save();
        const [created] = [...h.backend.plugin.connections.values()];
        expect(created).toMatchObject({ name: 'By hand', modelId: 'custom/typed-id' });

        // With a loaded catalog an id the catalog does not know is also accepted.
        await rig.store.refresh();
        Object.assign(tc.ctx, { catalog: rig.store });
        dispose();
        root.replaceChildren();
        await openForm();
        type(modelInput(), 'unknown/not-in-catalog');
        type(root.querySelector<HTMLInputElement>('input[aria-label="Name"]') as HTMLInputElement, 'Unknown');
        await save();
        expect([...h.backend.plugin.connections.values()].map((c) => c.modelId)).toContain('unknown/not-in-catalog');
    });

    it('keeps what is typed when the form is redrawn', async () => {
        await rig.store.refresh();
        Object.assign(tc.ctx, { catalog: rig.store });
        await openForm();
        type(modelInput(), 'my/model');
        const mode = root.querySelector<HTMLSelectElement>('select[aria-label="How it connects"]') as HTMLSelectElement;
        mode.value = 'direct';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        expect(modelInput().value).toBe('my/model');
    });
});
