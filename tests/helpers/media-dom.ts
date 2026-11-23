// DOM helpers for the Media tab tests: find a button, a field or a select by its label, type, choose, click, and let the
// pending promises settle. Labels are the English strings of the feature (the test contexts speak English).
import { flush } from './fakes';

export async function settle(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await flush();
}

export function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
    if (!found) {
        const labels = [...root.querySelectorAll('button')].map((node) => node.textContent?.trim()).join(' | ');
        throw new Error(`no button "${label}"; buttons: ${labels}`);
    }
    return found;
}

export function hasButton(root: ParentNode, label: string): boolean {
    return [...root.querySelectorAll('button')].some((node) => node.textContent?.trim() === label);
}

export async function click(root: ParentNode, label: string): Promise<void> {
    buttonNamed(root, label).click();
    await settle();
}

export function field<T extends HTMLElement = HTMLInputElement>(root: ParentNode, label: string): T {
    const found = root.querySelector<T>(
        `input[aria-label="${label}"], textarea[aria-label="${label}"], select[aria-label="${label}"]`,
    );
    if (!found) throw new Error(`no field "${label}"`);
    return found;
}

export function hasField(root: ParentNode, label: string): boolean {
    return (
        root.querySelector(
            `input[aria-label="${label}"], textarea[aria-label="${label}"], select[aria-label="${label}"]`,
        ) !== null
    );
}

export function type(root: ParentNode, label: string, value: string): void {
    const node = field<HTMLInputElement | HTMLTextAreaElement>(root, label);
    node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
}

export function choose(root: ParentNode, label: string, value: string): void {
    const node = field<HTMLSelectElement>(root, label);
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
}

export function check(root: ParentNode, label: string, on: boolean): void {
    const box = [...root.querySelectorAll<HTMLInputElement>('label.checkbox_label')]
        .find((node) => node.textContent?.trim() === label)
        ?.querySelector('input');
    if (!box) throw new Error(`no toggle "${label}"`);
    box.checked = on;
    box.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Gives a file input a file and fires `change`. */
export function pickFile(input: HTMLInputElement, file: File): void {
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function text(root: ParentNode): string {
    return root.textContent ?? '';
}

/** A File of `bytes` bytes (zero-filled). */
export function fileOf(name: string, type: string, bytes: number): File {
    return new File([new Uint8Array(bytes)], name, { type });
}
