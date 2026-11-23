import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isLink, linkDir, removeTree } from '../../tools/stand/lib/fsutil.mjs';
import { setYaml } from '../../tools/stand/lib/yaml.mjs';

let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanovia-stand-'));
});
afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('stand file helpers', () => {
    it('removes a tree without entering a linked folder (the shared ST tree must survive a reset)', () => {
        const shared = path.join(root, 'shared');
        fs.mkdirSync(shared);
        fs.writeFileSync(path.join(shared, 'keep.txt'), 'keep');
        const runtime = path.join(root, 'runtime');
        fs.mkdirSync(path.join(runtime, 'inner'), { recursive: true });
        fs.writeFileSync(path.join(runtime, 'inner', 'a.txt'), 'a');
        linkDir(shared, path.join(runtime, 'node_modules'));
        expect(isLink(path.join(runtime, 'node_modules'))).toBe(true);
        expect(fs.readFileSync(path.join(runtime, 'node_modules', 'keep.txt'), 'utf8')).toBe('keep');

        removeTree(runtime);
        expect(fs.existsSync(runtime)).toBe(false);
        expect(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('re-links over an existing link and ignores a missing path', () => {
        const a = path.join(root, 'a');
        const b = path.join(root, 'b');
        fs.mkdirSync(a);
        fs.mkdirSync(b);
        fs.writeFileSync(path.join(b, 'in-b.txt'), 'b');
        const link = path.join(root, 'link');
        linkDir(a, link);
        linkDir(b, link);
        expect(fs.existsSync(path.join(link, 'in-b.txt'))).toBe(true);
        expect(() => removeTree(path.join(root, 'nothing'))).not.toThrow();
    });
});

describe('stand config editing', () => {
    const yaml = [
        '# header',
        'dataRoot: ./data',
        'listen: false # keep local',
        'browserLaunch:',
        '  enabled: true',
        '  browser: default',
        'port: 8000',
        '',
    ].join('\n');

    it('sets scalars, nested keys and keeps comments and layout', () => {
        let text = setYaml(yaml, ['port'], 8130)!;
        text = setYaml(text, ['browserLaunch', 'enabled'], false)!;
        text = setYaml(text, ['dataRoot'], 'D:\\runtime\\data')!;
        expect(text).toContain('port: 8130');
        expect(text).toContain('  enabled: false');
        expect(text).toContain('dataRoot: "D:\\\\runtime\\\\data"');
        expect(text).toContain('listen: false # keep local');
        expect(text).toContain('# header');
        expect(text).toContain('  browser: default');
    });

    it('reports a missing key instead of guessing', () => {
        expect(setYaml(yaml, ['enableServerPlugins'], true)).toBeNull();
        expect(setYaml(yaml, ['browserLaunch', 'nothing'], true)).toBeNull();
    });
});
