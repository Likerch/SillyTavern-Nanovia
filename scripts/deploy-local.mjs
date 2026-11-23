#!/usr/bin/env node
// Copies the built extension and the server plugin into a local SillyTavern.
//
//   node scripts/deploy-local.mjs [--st <dir>] [--server-only | --extension-only] [--force]     (or: npm run deploy:local -- …)
//
// SillyTavern folder: --st <dir>, else env NANOVIA_ST_DIR, else .dev/deploy.json {"stDir": "…"} (relative to the
// repository), else a sibling `st-local-docker` (searched in the repository's parent folders, so it also works from a
// git worktree). Two layouts are understood: a normal ST checkout (public/scripts/extensions/third-party + plugins/)
// and the Docker layout of st-local-docker (./extensions and ./plugins mounted into the container).
//
// Extension: manifest.json and dist/ only. Plugin: server/index.js and server/package.json only. server/config.json and
// server/data/ are never copied, and the plugin's own config.json and data/ in the target are kept.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_FOLDER = 'SillyTavern-Nanovia';
export const PLUGIN_FOLDER = 'nanovia';

/** What stays in an installed plugin folder across updates (local config and the usage log). */
const PLUGIN_KEEP = new Set(['config.json', 'data']);
const PLUGIN_FILES = ['index.js', 'package.json'];

/** The sibling `st-local-docker` of the repository or of one of its parents (a worktree sits deeper). */
function findLocalDocker(repo) {
    for (let dir = path.dirname(repo), i = 0; i < 6 && dir !== path.dirname(dir); dir = path.dirname(dir), i++) {
        const candidate = path.join(dir, 'st-local-docker');
        if (fs.existsSync(candidate)) return candidate;
    }
    return path.resolve(repo, '..', 'st-local-docker');
}

/** @param {{ args?: string[], env?: Record<string, string | undefined>, repo?: string }} [options] */
export function resolveStDir({ args = [], env = process.env, repo = REPO } = {}) {
    const flag = args.indexOf('--st');
    if (flag !== -1 && args[flag + 1]) return path.resolve(args[flag + 1]);
    if (env.NANOVIA_ST_DIR) return path.resolve(env.NANOVIA_ST_DIR);
    const local = path.join(repo, '.dev', 'deploy.json');
    if (fs.existsSync(local)) {
        const { stDir } = JSON.parse(fs.readFileSync(local, 'utf8'));
        if (stDir) return path.resolve(repo, stDir);
    }
    return findLocalDocker(repo);
}

/** Where the extension and the plugin go for a SillyTavern folder. */
export function stTargets(stDir) {
    const checkout = path.join(stDir, 'public', 'scripts', 'extensions');
    if (fs.existsSync(checkout)) {
        return { extensions: path.join(checkout, 'third-party'), plugins: path.join(stDir, 'plugins') };
    }
    if (fs.existsSync(path.join(stDir, 'extensions'))) {
        return { extensions: path.join(stDir, 'extensions'), plugins: path.join(stDir, 'plugins') };
    }
    throw new Error(
        `Not a SillyTavern folder (no public/scripts/extensions and no extensions/): ${stDir}. Pass --st <dir> or set NANOVIA_ST_DIR.`,
    );
}

function copy(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
}

const version = (repo) => JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json'), 'utf8')).version;

function refuseGitCheckout(dest, force) {
    if (!force && fs.existsSync(path.join(dest, '.git'))) {
        throw new Error(`${dest} is a git checkout; update it with git (or pass --force to replace its files).`);
    }
}

/** Copies manifest.json and dist/ into `dest` (the extension folder). Returns a one-line report. */
export function deployExtension(dest, { repo = REPO, force = false } = {}) {
    if (!fs.existsSync(path.join(repo, 'dist', 'index.js')))
        throw new Error('dist/index.js is missing: run npm run build first');
    refuseGitCheckout(dest, force);
    fs.rmSync(dest, { recursive: true, force: true });
    copy(path.join(repo, 'manifest.json'), path.join(dest, 'manifest.json'));
    copy(path.join(repo, 'dist'), path.join(dest, 'dist'));
    return `extension ${version(repo)} -> ${dest} (reload the SillyTavern page)`;
}

/** Copies server/index.js and server/package.json into `dest` (the plugin folder), keeping its config.json and data/. */
export function deployPlugin(dest, { repo = REPO, force = false } = {}) {
    const source = path.join(repo, 'server');
    if (!fs.existsSync(path.join(source, 'index.js')))
        throw new Error('server/index.js is missing: run npm run build:server first');
    refuseGitCheckout(dest, force);
    if (fs.existsSync(dest)) {
        for (const entry of fs.readdirSync(dest)) {
            if (!PLUGIN_KEEP.has(entry)) fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
        }
    }
    for (const file of PLUGIN_FILES) copy(path.join(source, file), path.join(dest, file));
    return `server plugin -> ${dest} (restart SillyTavern; enableServerPlugins must be true)`;
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        console.log(
            'Usage: node scripts/deploy-local.mjs [--st <SillyTavern dir>] [--server-only | --extension-only] [--force]',
        );
        return;
    }
    const serverOnly = args.includes('--server-only');
    const extensionOnly = args.includes('--extension-only');
    if (serverOnly && extensionOnly) throw new Error('--server-only and --extension-only exclude each other');
    const force = args.includes('--force');
    const stDir = resolveStDir({ args });
    const targets = stTargets(stDir);
    if (!serverOnly) console.log(deployExtension(path.join(targets.extensions, EXTENSION_FOLDER), { force }));
    if (!extensionOnly) console.log(deployPlugin(path.join(targets.plugins, PLUGIN_FOLDER), { force }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try {
        main();
    } catch (error) {
        console.error(`deploy-local: ${error.message}`);
        process.exit(1);
    }
}
