// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    button,
    chip,
    clear,
    el,
    field,
    icon,
    select,
    setButtonErrorHandler,
    textArea,
    textInput,
    toggle,
    uid,
} from '../../src/ui';
import { classNames } from '../../src/ui/dom';
import { flush } from '../helpers/fakes';

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    setButtonErrorHandler((error) => console.error(error));
});

describe('el', () => {
    it('builds elements with classes, data, attributes and handlers', () => {
        const onClick = vi.fn();
        const node = el(
            'div',
            {
                class: ['a', null, 'b', false],
                data: { id: 5 },
                attrs: { role: 'x', hidden: true, nope: false, empty: null },
                title: 'T',
                on: { click: onClick },
            },
            ['text', 3, null, el('span')],
        );
        expect(node.className).toBe('a b');
        expect(node.dataset['id']).toBe('5');
        expect(node.getAttribute('role')).toBe('x');
        expect(node.hasAttribute('hidden')).toBe(true);
        expect(node.hasAttribute('nope')).toBe(false);
        expect(node.title).toBe('T');
        expect(node.textContent).toBe('text3');
        node.click();
        expect(onClick).toHaveBeenCalledOnce();
    });

    it('treats text as text, never as markup', () => {
        const node = el('div', { text: '<img src=x onerror=alert(1)>' }, '<b>child</b>');
        expect(node.querySelector('img')).toBeNull();
        expect(node.querySelector('b')).toBeNull();
        expect(node.textContent).toBe('<img src=x onerror=alert(1)><b>child</b>');
    });

    it('classNames and clear and icon', () => {
        expect(classNames(undefined)).toBe('');
        expect(classNames('x')).toBe('x');
        const node = el('div', {}, [el('i'), el('i')]);
        clear(node);
        expect(node.childNodes).toHaveLength(0);
        expect(icon('check').className).toBe('fa-solid fa-check fa-fw');
        expect(icon('fa-key').className).toContain('fa-key');
    });
});

describe('button', () => {
    it('labels itself, or uses the title as its accessible name when it is icon-only', () => {
        const labelled = button({ label: 'Save', icon: 'check' });
        expect(labelled.textContent).toBe('Save');
        expect(labelled.getAttribute('type')).toBe('button');
        const iconOnly = button({ icon: 'check', title: 'Do it' });
        expect(iconOnly.getAttribute('aria-label')).toBe('Do it');
    });

    it('disables itself while an async handler runs, and enables again after', async () => {
        let release: () => void = () => {};
        const node = button({ label: 'Go', onClick: () => new Promise<void>((resolve) => void (release = resolve)) });
        node.click();
        expect(node.disabled).toBe(true);
        expect(node.classList.contains('nanovia-busy')).toBe(true);
        node.click();
        release();
        await flush();
        expect(node.disabled).toBe(false);
        expect(node.classList.contains('nanovia-busy')).toBe(false);
    });

    it('routes a failing handler (sync or async) to the error handler', async () => {
        const seen: unknown[] = [];
        setButtonErrorHandler((error) => seen.push(error));
        button({
            label: 'a',
            onClick: () => {
                throw new Error('sync');
            },
        }).click();
        const asyncButton = button({
            label: 'b',
            onClick: async () => {
                throw new Error('async');
            },
        });
        asyncButton.click();
        await flush();
        expect(seen.map((e) => (e as Error).message)).toEqual(['sync', 'async']);
        expect(asyncButton.disabled).toBe(false);
    });

    it('stays disabled when created disabled', async () => {
        const handler = vi.fn();
        const node = button({ label: 'x', disabled: true, onClick: handler });
        node.click();
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('controls', () => {
    it('select shows the value, falls back to the first option, and reports changes', () => {
        const onChange = vi.fn();
        const node = select({
            value: 'b',
            options: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
            ],
            label: 'Pick',
            onChange,
        });
        expect(node.value).toBe('b');
        expect(node.getAttribute('aria-label')).toBe('Pick');
        node.value = 'a';
        node.dispatchEvent(new Event('change'));
        expect(onChange).toHaveBeenCalledWith('a');
        const fallback = select({ value: 'zzz', options: [{ value: 'a', label: 'A' }], onChange });
        expect(fallback.value).toBe('a');
    });

    it('toggle reports its state and links label and input', () => {
        const onChange = vi.fn();
        const node = toggle({ label: 'On', checked: true, hint: 'hint', onChange });
        document.body.appendChild(node);
        const input = node.querySelector('input')!;
        expect(input.checked).toBe(true);
        expect(node.getAttribute('for')).toBe(input.id);
        expect(node.title).toBe('hint');
        input.checked = false;
        input.dispatchEvent(new Event('change'));
        expect(onChange).toHaveBeenCalledWith(false);
    });

    it('a password field is never autofilled or spell-checked', () => {
        const secret = textInput({ value: '', type: 'password' });
        expect(secret.type).toBe('password');
        expect(secret.getAttribute('autocomplete')).toBe('off');
        expect(secret.getAttribute('spellcheck')).toBe('false');
        expect(textInput({ value: 'x' }).getAttribute('autocomplete')).toBeNull();
    });

    it('textInput fires input and change, and textArea fires input', () => {
        const onInput = vi.fn();
        const onChange = vi.fn();
        const node = textInput({ value: 'v', placeholder: 'p', maxLength: 5, onInput, onChange });
        expect(node.value).toBe('v');
        expect(node.getAttribute('placeholder')).toBe('p');
        expect(node.getAttribute('maxlength')).toBe('5');
        node.value = 'new';
        node.dispatchEvent(new Event('input'));
        node.dispatchEvent(new Event('change'));
        expect(onInput).toHaveBeenCalledWith('new');
        expect(onChange).toHaveBeenCalledWith('new');
        const area = textArea({ value: 'a', rows: 4, onInput });
        area.value = 'b';
        area.dispatchEvent(new Event('input'));
        expect(onInput).toHaveBeenLastCalledWith('b');
        expect(area.getAttribute('rows')).toBe('4');
    });

    it('chip carries its kind, and field wraps label, control and hint', () => {
        const c = chip('OK', 'ok', 'why');
        expect(c.className).toBe('nanovia-chip nanovia-chip-ok');
        expect(c.title).toBe('why');
        expect(chip('x').className).toContain('nanovia-chip-muted');
        const row = field('Label', el('input'), 'Hint');
        expect(row.querySelector('.nanovia-field-label')?.textContent).toBe('Label');
        expect(row.querySelector('.nanovia-field-control input')).not.toBeNull();
        expect(row.querySelector('.nanovia-field-hint')?.textContent).toBe('Hint');
        expect(field('L', el('input')).querySelector('.nanovia-field-hint')).toBeNull();
    });

    it('uid never repeats', () => {
        expect(uid()).not.toBe(uid());
        expect(uid('x')).toMatch(/^x-\d+$/);
    });
});
