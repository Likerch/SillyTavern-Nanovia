import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deployExtension, deployPlugin, resolveStDir, stTargets } from '../../scripts/deploy-local.mjs';

let root: string;
const write = (file: string, text = 'x') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
};
const exists = (...parts: string[]) => fs.existsSync(path.join(root, ...parts));

/** A fake built repository: what `npm run build` leaves, plus the local files that must never travel. */
function fakeRepo() {
    const repo = path.join(root, 'repo');
    write(path.join(repo, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
    write(path.join(repo, 'dist', 'index.js'), 'client');
    write(path.join(repo, 'dist', 'style.css'), 'css');
    write(path.join(repo, 'src', 'secret.ts'), 'not copied');
    write(path.join(repo, 'server', 'index.js'), 'plugin');
    write(path.join(repo, 'server', 'package.json'), '{}');
    write(path.join(repo, 'server', 'config.json'), '{"token":"local-only"}');
    write(path.join(repo, 'server', 'data', 'usage.jsonl'), 'local-only');
    return repo;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanovia-deploy-'));
});
afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('deploy-local', () => {
    it('finds the targets of a checkout layout and of the Docker layout, and refuses anything else', () => {
        const checkout = path.join(root, 'checkout');
        fs.mkdirSync(path.join(checkout, 'public', 'scripts', 'extensions'), { recursive: true });
        expect(stTargets(checkout)).toEqual({
            extensions: path.join(checkout, 'public', 'scripts', 'extensions', 'third-party'),
            plugins: path.join(checkout, 'plugins'),
        });
        const docker = path.join(root, 'docker');
        fs.mkdirSync(path.join(docker, 'extensions'), { recursive: true });
        expect(stTargets(docker)).toEqual({
            extensions: path.join(docker, 'extensions'),
            plugins: path.join(docker, 'plugins'),
        });
        expect(() => stTargets(path.join(root, 'empty'))).toThrow(/Not a SillyTavern folder/);
    });

    it('resolves the SillyTavern folder from --st, the environment, .dev/deploy.json, then a sibling st-local-docker', () => {
        const repo = path.join(root, 'work', 'repo');
        fs.mkdirSync(repo, { recursive: true });
        expect(resolveStDir({ args: ['--st', 'somewhere'], env: { NANOVIA_ST_DIR: 'env' }, repo })).toBe(
            path.resolve('somewhere'),
        );
        expect(resolveStDir({ args: [], env: { NANOVIA_ST_DIR: path.join(root, 'env') }, repo })).toBe(
            path.join(root, 'env'),
        );
        fs.mkdirSync(path.join(root, 'st-local-docker'));
        expect(resolveStDir({ args: [], env: {}, repo })).toBe(path.join(root, 'st-local-docker'));
        write(path.join(repo, '.dev', 'deploy.json'), JSON.stringify({ stDir: '../chosen' }));
        expect(resolveStDir({ args: [], env: {}, repo })).toBe(path.join(root, 'work', 'chosen'));
    });

    it('copies the manifest and dist/ and nothing else for the extension', () => {
        const repo = fakeRepo();
        const dest = path.join(root, 'st', 'SillyTavern-Nanovia');
        write(path.join(dest, 'stale.js'));
        const report = deployExtension(dest, { repo });
        expect(report).toContain('9.9.9');
        expect(fs.readdirSync(dest).sort()).toEqual(['dist', 'manifest.json']);
        expect(fs.readdirSync(path.join(dest, 'dist')).sort()).toEqual(['index.js', 'style.css']);
    });

    it('copies index.js and package.json for the plugin, keeping the target config.json and data/', () => {
        const repo = fakeRepo();
        const dest = path.join(root, 'st', 'plugins', 'nanovia');
        write(path.join(dest, 'config.json'), '{"port":9000}');
        write(path.join(dest, 'data', 'usage-2026-11-23.jsonl'), 'kept');
        write(path.join(dest, 'old.js'), 'removed');
        deployPlugin(dest, { repo });
        expect(fs.readdirSync(dest).sort()).toEqual(['config.json', 'data', 'index.js', 'package.json']);
        expect(fs.readFileSync(path.join(dest, 'config.json'), 'utf8')).toBe('{"port":9000}');
        expect(fs.existsSync(path.join(dest, 'data', 'usage-2026-11-23.jsonl'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'data', 'usage.jsonl'))).toBe(false);
        expect(fs.readFileSync(path.join(dest, 'index.js'), 'utf8')).toBe('plugin');
    });

    it('never copies server/config.json or server/data/ into a fresh plugin folder', () => {
        const repo = fakeRepo();
        const dest = path.join(root, 'fresh', 'nanovia');
        deployPlugin(dest, { repo });
        expect(fs.readdirSync(dest).sort()).toEqual(['index.js', 'package.json']);
        expect(exists('fresh', 'nanovia', 'config.json')).toBe(false);
    });

    it('asks for a build when the output is missing, and refuses to overwrite a git checkout', () => {
        const repo = fakeRepo();
        fs.rmSync(path.join(repo, 'dist'), { recursive: true });
        fs.rmSync(path.join(repo, 'server', 'index.js'));
        expect(() => deployExtension(path.join(root, 'a'), { repo })).toThrow(/npm run build/);
        expect(() => deployPlugin(path.join(root, 'b'), { repo })).toThrow(/npm run build:server/);

        const built = fakeRepo();
        const checkout = path.join(root, 'clone');
        fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
        expect(() => deployExtension(checkout, { repo: built })).toThrow(/git checkout/);
        expect(() => deployPlugin(checkout, { repo: built })).toThrow(/git checkout/);
        expect(() => deployExtension(checkout, { repo: built, force: true })).not.toThrow();
    });
});
