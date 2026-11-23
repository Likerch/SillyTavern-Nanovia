#!/usr/bin/env node
// Nanovia local stand: SillyTavern 1.19 from a local source tree (no Docker) + the built extension and server plugin
// + the mock NanoGPT. Everything it creates lives in tools/stand/runtime/ (git-ignored); the SillyTavern source tree
// itself is never modified.
//
//   npm run stand [-- <command>]       npm run stand:stop        (or: node tools/stand/stand.mjs <command>)
//
// Commands: start (default) | setup | stop | restart | status | logs | reset. See `help` and docs/DEPLOY.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployExtension, deployPlugin, EXTENSION_FOLDER, PLUGIN_FOLDER } from '../../scripts/deploy-local.mjs';
import { ensureDir, exists, isLink, linkDir, readJson, removeTree, writeJson } from './lib/fsutil.mjs';
import { setYaml } from './lib/yaml.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const env = process.env;

const RUNTIME = path.resolve(env.STAND_RUNTIME ?? path.join(HERE, 'runtime'));
/** The stand's own "server directory": a copy of ST's src/ and entry files, links to its heavy read-only folders. */
const ST_ROOT = path.join(RUNTIME, 'st');
const PLUGIN_DIR = path.join(ST_ROOT, 'plugins', PLUGIN_FOLDER);
const DATA = path.join(RUNTIME, 'data');
const USER = path.join(DATA, 'default-user');
const EXT_DIR = path.join(USER, 'extensions');
const CONFIG_DIR = path.join(RUNTIME, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const LOGS = path.join(RUNTIME, 'logs');
const PIDS = path.join(RUNTIME, 'pids.json');
const STATE = path.join(RUNTIME, 'stand.json');

const ST_PORT = Number(env.STAND_ST_PORT ?? 8130);
const MOCK_PORT = Number(env.STAND_MOCK_PORT ?? 5300);
const PROXY_PORT = Number(env.STAND_PROXY_PORT ?? 8788);
const ST_URL = `http://127.0.0.1:${ST_PORT}/`;
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_BASE = `${MOCK_ORIGIN}/api/v1`;
/** Any HTTP answer means the proxy listener is alive (the plugin owns the route table; /health is the documented one). */
const PROXY_HEALTH = `http://127.0.0.1:${PROXY_PORT}/health`;

/** Seed values: a fake key that only the mock accepts (any `sk-nano-<8+ chars>` passes there). */
const MOCK_KEY = 'sk-nano-stand-mock-key-0000';
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';

/** ST 1.19 source tree: STAND_ST_DIR, else a sibling `st-local-docker/src-1.19.0` of the repository or its parents. */
function findStDir() {
    if (env.STAND_ST_DIR) return path.resolve(env.STAND_ST_DIR);
    for (let dir = path.dirname(REPO), i = 0; i < 6 && dir !== path.dirname(dir); dir = path.dirname(dir), i++) {
        const candidate = path.join(dir, 'st-local-docker', 'src-1.19.0');
        if (fs.existsSync(candidate)) return candidate;
    }
    return path.resolve(REPO, '..', 'st-local-docker', 'src-1.19.0');
}
const ST_DIR = findStDir();

const HELP = `Nanovia stand

Usage: node tools/stand/stand.mjs <command> [options]     (npm run stand [-- <command>], npm run stand:stop)

  start     (default) set up on first use, refresh the installed build, start the mock NanoGPT (:${MOCK_PORT}) and SillyTavern (:${ST_PORT})
  setup     create tools/stand/runtime/ (ST tree, config, data, extension, plugin)
              --force     rebuild the ST tree and rewrite settings.json / secrets.json
              --copy      copy dist/ instead of linking it (a link makes a rebuild live after a page reload)
  stop      stop both
  restart   stop + start (a rebuilt plugin needs it)
  status    what is installed and running
  logs [st|mock] [-n 80]
  reset     stop and wipe data, config, logs and the installed plugin (--all also wipes the ST tree copy)

Environment: STAND_ST_DIR (SillyTavern 1.19 source tree with node_modules), STAND_ST_PORT (${ST_PORT}), STAND_MOCK_PORT (${MOCK_PORT}),
STAND_PROXY_PORT (${PROXY_PORT}, the plugin's proxy), STAND_RUNTIME.
Paths: ST ${ST_DIR}
       runtime ${RUNTIME}`;

/* ------------------------------------------------------------------ output and helpers */

const say = (line = '') => console.log(line);
const ok = (line) => console.log(`  ok    ${line}`);
const warn = (line) => console.log(`  warn  ${line}`);
const fail = (line) => console.log(`  FAIL  ${line}`);

function die(message) {
    console.error(`stand: ${message}`);
    process.exit(1);
}

function parseOptions(argv) {
    const options = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('-')) options._.push(arg);
        else if (arg === '-n' && argv[i + 1]) options.n = argv[++i];
        else options[arg.replace(/^--?/, '')] = true;
    }
    return options;
}

function httpGet(url, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => {
            req.destroy();
            resolve({ status: 0, body: '' });
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function killTree(pid) {
    if (!isAlive(pid)) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
    }
    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // already gone
        }
    }
}

function tail(file, lines = 40) {
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
}

/* ------------------------------------------------------------------ setup pieces */

/** The ST tree must exist and carry its node_modules (the stand never installs them: see docs/DEPLOY.md). */
function checkSillyTavern() {
    const required = [
        'server.js',
        'package.json',
        'src',
        'public',
        'default/config.yaml',
        'default/content/settings.json',
        'node_modules',
    ];
    const missing = required.filter((file) => !fs.existsSync(path.join(ST_DIR, file)));
    if (missing.length) {
        die(
            `SillyTavern source tree not usable at ${ST_DIR} (missing: ${missing.join(', ')}).\n` +
                'Set STAND_ST_DIR to a SillyTavern 1.19 checkout with node_modules (git clone --branch 1.19.0 https://github.com/SillyTavern/SillyTavern, then `npm ci --omit=dev` inside it).',
        );
    }
    const version = readJson(path.join(ST_DIR, 'package.json')).version;
    if (!String(version).startsWith('1.19')) warn(`SillyTavern ${version} found, the stand targets 1.19.x`);
    return version;
}

function writeConfig() {
    let text = fs.readFileSync(path.join(ST_DIR, 'default', 'config.yaml'), 'utf8').replace(/\r\n/g, '\n');
    const edits = [
        [['dataRoot'], DATA],
        [['listen'], false],
        [['port'], ST_PORT],
        [['browserLaunch', 'enabled'], false],
        [['whitelistMode'], true],
        [['basicAuthMode'], false],
        [['enableUserAccounts'], false],
        [['logging', 'enableAccessLog'], false],
        [['backups', 'chat', 'enabled'], false],
        [['extensions', 'enabled'], true],
        [['extensions', 'autoUpdate'], false],
        [['extensions', 'models', 'autoDownload'], false],
        [['enableDownloadableTokenizers'], false],
        [['enableServerPlugins'], true],
        [['enableServerPluginsAutoUpdate'], false],
    ];
    for (const [keys, value] of edits) {
        const next = setYaml(text, keys, value);
        if (next === null) warn(`config.yaml: key ${keys.join('.')} not found (different ST version?)`);
        else text = next;
    }
    // The default whitelist already holds ::1 and 127.0.0.1.
    ensureDir(CONFIG_DIR);
    fs.writeFileSync(CONFIG_FILE, text, 'utf8');
    ok(`config.yaml (port ${ST_PORT}, listen false, whitelist on, enableServerPlugins true, no auto-updates)`);
}

/**
 * The stand's server directory. ST computes it from the real path of src/server-directory.js, so src/ has to be a
 * real copy (a link would send ST's `plugins/` and `public/` back into the shared tree); node_modules, public and
 * default are read-only for ST and are linked.
 */
function installStTree(stVersion, force) {
    const state = readJson(STATE, {});
    const current =
        exists(path.join(ST_ROOT, 'src', 'server-directory.js')) &&
        state.stDir === ST_DIR &&
        state.stVersion === stVersion;
    if (current && !force) {
        ok(`ST tree kept (${path.relative(REPO, ST_ROOT)})`);
        return;
    }
    ensureDir(ST_ROOT);
    removeTree(path.join(ST_ROOT, 'src'));
    fs.cpSync(path.join(ST_DIR, 'src'), path.join(ST_ROOT, 'src'), { recursive: true });
    for (const file of ['server.js', 'package.json', 'plugins.js', 'webpack.config.js']) {
        if (fs.existsSync(path.join(ST_DIR, file))) fs.copyFileSync(path.join(ST_DIR, file), path.join(ST_ROOT, file));
    }
    for (const dir of ['node_modules', 'public', 'default']) linkDir(path.join(ST_DIR, dir), path.join(ST_ROOT, dir));
    ok(`ST tree ${stVersion}: src/ copied, node_modules, public, default linked from ${ST_DIR}`);
}

/** Settings of the stand's user: Chat Completion "Custom" straight at the mock, so ST -> mock works before any connection exists. */
function buildSettings() {
    const settings = readJson(path.join(ST_DIR, 'default', 'content', 'settings.json'));
    settings.firstRun = false;
    settings.main_api = 'openai';
    settings.power_user = { ...settings.power_user, auto_load_chat: true, auto_connect: true };
    settings.oai_settings = {
        ...settings.oai_settings,
        chat_completion_source: 'custom',
        custom_url: MOCK_BASE,
        custom_model: DEFAULT_MODEL,
        custom_include_body: '',
        custom_exclude_body: '',
        custom_include_headers: '',
        stream_openai: true,
        max_context_unlocked: true,
        openai_max_context: 65536,
        openai_max_tokens: 1200,
    };
    return settings;
}

function seedUser(force) {
    ensureDir(USER);
    const settingsFile = path.join(USER, 'settings.json');
    if (!fs.existsSync(settingsFile) || force) {
        writeJson(settingsFile, buildSettings());
        ok(`settings.json: Chat Completion "custom" -> ${MOCK_BASE}`);
    } else {
        ok('settings.json kept (--force rewrites it)');
    }
    const secretsFile = path.join(USER, 'secrets.json');
    if (!fs.existsSync(secretsFile) || force) {
        const secret = (id, label) => [{ id, value: MOCK_KEY, label, active: true }];
        writeJson(secretsFile, {
            api_key_nanogpt: secret('00000000-0000-4000-8000-0000000000a1', 'Mock NanoGPT key'),
            api_key_custom: secret('00000000-0000-4000-8000-0000000000c1', 'Mock (stand)'),
        });
        ok('secrets.json: a mock NanoGPT key (api_key_nanogpt) and a custom key for the direct mock source');
    } else {
        ok('secrets.json kept');
    }
}

/**
 * Installs the built extension: link mode keeps a real folder with a copy of manifest.json and a junction to dist/,
 * so a rebuild is live after a page reload. Without dist/index.js nothing is linked yet (start retries).
 */
function installExtension(copyMode) {
    const dest = path.join(EXT_DIR, EXTENSION_FOLDER);
    const built = fs.existsSync(path.join(REPO, 'dist', 'index.js'));
    if (!built) {
        removeTree(dest);
        warn('extension: dist/index.js is missing - run `npm run build`, then `npm run stand` again');
        return { installed: false };
    }
    if (copyMode) {
        removeTree(dest);
        ok(deployExtension(dest, { repo: REPO }));
        return { installed: true, mode: 'copy' };
    }
    ensureDir(dest);
    fs.copyFileSync(path.join(REPO, 'manifest.json'), path.join(dest, 'manifest.json'));
    if (!isLink(path.join(dest, 'dist'))) linkDir(path.join(REPO, 'dist'), path.join(dest, 'dist'));
    ok(`extension ${readJson(path.join(REPO, 'manifest.json')).version}: dist/ linked to the repository`);
    return { installed: true, mode: 'link' };
}

/** Installs the built plugin and points it at the mock. The config.json of the stand's plugin is the stand's own. */
function installPlugin() {
    if (!fs.existsSync(path.join(REPO, 'server', 'index.js'))) {
        warn('plugin: server/index.js is missing - run `npm run build:server`, then `npm run stand` again');
        return { installed: false };
    }
    ok(deployPlugin(PLUGIN_DIR, { repo: REPO }));
    writeJson(path.join(PLUGIN_DIR, 'config.json'), { port: PROXY_PORT, upstreamBase: MOCK_BASE, timeoutMs: 30000 });
    ok(`plugin config.json: proxy port ${PROXY_PORT}, upstreamBase ${MOCK_BASE}`);
    return { installed: true };
}

/* ------------------------------------------------------------------ commands */

function isSetUp() {
    return (
        fs.existsSync(CONFIG_FILE) &&
        fs.existsSync(path.join(USER, 'settings.json')) &&
        fs.existsSync(path.join(ST_ROOT, 'server.js'))
    );
}

async function setup(options) {
    say('Setting up the Nanovia stand');
    const stVersion = checkSillyTavern();
    ok(`SillyTavern ${stVersion} at ${ST_DIR}`);
    if (isAlive(readJson(PIDS, {}).st?.pid)) die('the stand is running - run `stop` first');
    for (const dir of [RUNTIME, DATA, USER, EXT_DIR, CONFIG_DIR, LOGS]) ensureDir(dir);
    writeConfig();
    installStTree(stVersion, options.force);
    seedUser(options.force);
    const extension = installExtension(options.copy);
    const plugin = installPlugin();
    writeJson(STATE, {
        setupAt: new Date().toISOString(),
        stDir: ST_DIR,
        stVersion,
        ports: { st: ST_PORT, mock: MOCK_PORT, proxy: PROXY_PORT },
        extension,
        plugin,
    });
    say();
    say('Setup finished.');
}

function spawnLogged(name, args, cwd, extraEnv = {}) {
    ensureDir(LOGS);
    const logFile = path.join(LOGS, `${name}.log`);
    fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} ${name} start =====\n`);
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, args, {
        cwd,
        env: { ...env, ...extraEnv },
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
    });
    child.unref();
    fs.closeSync(out);
    return child.pid;
}

async function waitFor(url, pid, label, logFile, timeoutMs) {
    const started = Date.now();
    let ticks = 0;
    while (Date.now() - started < timeoutMs) {
        const response = await httpGet(url, 2000);
        if (response.status >= 200 && response.status < 500) return response;
        if (pid && !isAlive(pid)) {
            fail(`${label} exited during startup. Last log lines:`);
            say(tail(logFile, 40));
            return null;
        }
        await sleep(1000);
        if (++ticks % 15 === 0) say(`  ...   waiting for ${label} (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    fail(`${label} did not answer ${url} within ${Math.round(timeoutMs / 1000)} s (log: ${logFile})`);
    return null;
}

async function start() {
    if (!isSetUp()) await setup({});
    else {
        // Pick up a rebuild: relink dist/, recopy the plugin (ST loads plugins at start only).
        checkSillyTavern();
        installExtension(readJson(STATE, {}).extension?.mode === 'copy');
        installPlugin();
    }
    const pids = readJson(PIDS, {});

    if (isAlive(pids.mock?.pid)) {
        ok(`mock NanoGPT already running (pid ${pids.mock.pid})`);
    } else {
        if ((await httpGet(`${MOCK_ORIGIN}/__mock/health`, 1500)).status === 200)
            die(`port ${MOCK_PORT} is taken by another mock`);
        const pid = spawnLogged(
            'mock',
            [path.join(REPO, 'tools', 'mock-nanogpt', 'server.mjs'), '--port', String(MOCK_PORT)],
            REPO,
        );
        pids.mock = { pid, port: MOCK_PORT, startedAt: new Date().toISOString() };
        writeJson(PIDS, pids);
        if (!(await waitFor(`${MOCK_ORIGIN}/__mock/health`, pid, 'mock NanoGPT', path.join(LOGS, 'mock.log'), 15000)))
            process.exit(1);
        ok(`mock NanoGPT started (pid ${pid})`);
    }

    if (isAlive(pids.st?.pid)) {
        ok(`SillyTavern already running (pid ${pids.st.pid})`);
    } else {
        if ((await httpGet(ST_URL, 1500)).status !== 0) die(`port ${ST_PORT} is taken by another process`);
        const args = [
            path.join(ST_ROOT, 'server.js'),
            `--configPath=${CONFIG_FILE}`,
            `--dataRoot=${DATA}`,
            `--port=${ST_PORT}`,
            '--listen=false',
            '--whitelist=true',
            '--basicAuthMode=false',
            '--browserLaunchEnabled=false',
        ];
        const pid = spawnLogged('st', args, ST_ROOT, { NODE_ENV: 'production', FORCE_COLOR: '0' });
        pids.st = { pid, port: ST_PORT, startedAt: new Date().toISOString() };
        writeJson(PIDS, pids);
        say('  ...   starting SillyTavern (the first start compiles frontend libraries, up to a few minutes)');
        const response = await waitFor(ST_URL, pid, 'SillyTavern', path.join(LOGS, 'st.log'), 300000);
        if (!response) process.exit(1);
        ok(`SillyTavern started (pid ${pid}, HTTP ${response.status})`);
    }

    const proxy = await httpGet(PROXY_HEALTH, 3000);
    say();
    say(`  SillyTavern    ${ST_URL}`);
    say(`  mock NanoGPT   ${MOCK_BASE}   (request log: ${MOCK_ORIGIN}/__mock/requests)`);
    say(
        `  plugin proxy   ${proxy.status ? `up at http://127.0.0.1:${PROXY_PORT}` : 'not answering (plugin not built or not loaded: see `logs st`)'}`,
    );
    say(`  logs           ${path.relative(REPO, LOGS)}`);
}

async function stop() {
    const pids = readJson(PIDS, {});
    for (const name of ['st', 'mock']) {
        const pid = pids[name]?.pid;
        if (isAlive(pid)) {
            killTree(pid);
            for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(250);
            if (isAlive(pid)) fail(`${name}: pid ${pid} is still alive`);
            else ok(`${name} stopped (pid ${pid})`);
        } else {
            ok(`${name} not running`);
        }
    }
    removeTree(PIDS);
    if ((await httpGet(ST_URL, 1000)).status) warn(`something still answers on ${ST_URL} (not started by the stand?)`);
    if ((await httpGet(`${MOCK_ORIGIN}/__mock/health`, 1000)).status)
        warn(`something still answers on ${MOCK_ORIGIN} (not started by the stand?)`);
}

async function reset(options) {
    await stop();
    const targets = [
        DATA,
        CONFIG_DIR,
        LOGS,
        STATE,
        PIDS,
        path.join(ST_ROOT, 'plugins'),
        ...(options.all ? [ST_ROOT] : []),
    ];
    for (const target of targets) removeTree(target);
    ok(`runtime wiped${options.all ? '' : ' (the ST tree copy stays; --all removes it)'}`);
}

async function status() {
    say('Nanovia stand status');
    const state = readJson(STATE, null);
    say(`  SillyTavern source  ${ST_DIR}${fs.existsSync(path.join(ST_DIR, 'server.js')) ? '' : '  (MISSING)'}`);
    say(`  runtime             ${RUNTIME}${state ? `  (setup ${state.setupAt})` : '  (not set up)'}`);
    const extDir = path.join(EXT_DIR, EXTENSION_FOLDER);
    const built = fs.existsSync(path.join(REPO, 'dist', 'index.js'));
    say(
        `  extension           ${exists(extDir) ? (isLink(path.join(extDir, 'dist')) ? 'linked' : 'copied') : 'not installed'}, dist ${built ? 'built' : 'MISSING (npm run build)'}`,
    );
    say(
        `  plugin              ${fs.existsSync(path.join(PLUGIN_DIR, 'index.js')) ? 'installed' : 'not installed'}, server/index.js ${fs.existsSync(path.join(REPO, 'server', 'index.js')) ? 'built' : 'MISSING (npm run build:server)'}`,
    );
    const pids = readJson(PIDS, {});
    const mock = await httpGet(`${MOCK_ORIGIN}/__mock/health`, 1500);
    const st = await httpGet(ST_URL, 3000);
    const proxy = await httpGet(PROXY_HEALTH, 1500);
    const pidNote = (name) =>
        pids[name]?.pid ? ` pid ${pids[name].pid}${isAlive(pids[name].pid) ? '' : ' (dead)'}` : '';
    say(`  mock NanoGPT        ${mock.status === 200 ? 'up' : 'down'} ${MOCK_BASE}${pidNote('mock')}`);
    say(`  SillyTavern         ${st.status ? `up (HTTP ${st.status})` : 'down'} ${ST_URL}${pidNote('st')}`);
    say(`  plugin proxy        ${proxy.status ? `up (HTTP ${proxy.status})` : 'down'} ${PROXY_HEALTH}`);
}

function logs(options) {
    const names = options._.length ? options._ : ['st', 'mock'];
    const lines = Number(options.n ?? 80) || 80;
    for (const name of names) {
        say(`===== ${name}.log (last ${lines} lines) =====`);
        say(tail(path.join(LOGS, `${name}.log`), lines) || '(empty)');
    }
}

async function main() {
    const [command = 'start', ...rest] = process.argv.slice(2);
    const options = parseOptions(rest);
    switch (command) {
        case 'start':
            return start();
        case 'setup':
            return setup(options);
        case 'stop':
            return stop();
        case 'restart':
            await stop();
            return start();
        case 'status':
            return status();
        case 'logs':
            return logs(options);
        case 'reset':
            return reset(options);
        case 'help':
        case '--help':
        case '-h':
            return say(HELP);
        default:
            say(HELP);
            return die(`unknown command "${command}"`);
    }
}

main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exit(1);
});
