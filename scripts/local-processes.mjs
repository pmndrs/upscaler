/**
 * Shared process plumbing for the GPU harness scripts: resolve the dev-server
 * origin a script should drive, spawn Vite pinned to exactly that origin, and
 * tear child processes + temp directories down without racing them.
 *
 * GPU-free and side-effect-free on import, so it is unit-tested in CI.
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');

/** Origin the bench harnesses drive when no `--url` is given. */
export const DEFAULT_BENCH_URL = 'http://127.0.0.1:5199';

/**
 * Normalize a `--url` value into the pieces a Vite spawn needs.
 * @param {string | true | undefined} raw - CLI value; `undefined` selects `fallback`.
 * @param {string} fallback - Origin used when `raw` is absent.
 * @returns {{ origin: string, hostname: string, port: number }} `hostname` is
 *   bracket-free (`::1`, not `[::1]`) because Vite's `--host` wants the bare form.
 */
export function resolveServerUrl(raw, fallback) {
    if (raw === true) throw new Error('--url needs a value, e.g. --url http://127.0.0.1:5600');
    const value = raw ?? fallback;
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`--url must be an absolute http(s) origin; got ${JSON.stringify(value)}.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error(`--url must use http or https; got ${url.protocol}`);
    if (url.pathname !== '/' || url.search || url.hash)
        throw new Error(`--url must be an origin with no path or query; got ${value}.`);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return { origin: url.origin, hostname: url.hostname.replace(/^\[|\]$/g, ''), port };
}

/**
 * Parse an optional numeric port flag.
 * @param {string | true | undefined} raw - CLI value.
 * @param {string} flag - Flag name for the error message.
 * @returns {number | undefined} The port, or `undefined` when the flag is absent.
 */
export function parsePort(raw, flag) {
    if (raw === undefined) return undefined;
    // `true` is a bare flag (`--port` with no value) — Number(true) would read as port 1.
    const port = /^\d+$/.test(String(raw)) && raw !== true ? Number(raw) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error(`${flag} must be a port number between 1 and 65535; got ${JSON.stringify(raw)}.`);
    return port;
}

/**
 * Vite CLI arguments that serve `config` on exactly `server`'s host + port.
 * `--strictPort` matters: without it a busy port makes Vite silently pick the
 * next one, and the harness then waits on (or worse, drives) whatever already
 * owns the requested port.
 * @param {string} config - Vite config path, relative to the repo root.
 * @param {{ hostname: string, port: number }} server - From {@link resolveServerUrl}.
 * @param {string[]} [extra] - Extra Vite arguments (e.g. a leading `preview`).
 * @returns {string[]} Arguments for `node <vite bin>`.
 */
export function viteServerArguments(config, server, extra = []) {
    return [
        VITE_BIN,
        ...extra,
        '--config',
        config,
        '--host',
        server.hostname,
        '--port',
        String(server.port),
        '--strictPort',
    ];
}

/**
 * Spawn Vite directly (not through `npm run`, whose wrapper can orphan the
 * real server on SIGTERM).
 * @param {string} config - Vite config path, relative to the repo root.
 * @param {{ hostname: string, port: number }} server - Where to serve.
 * @param {import('node:child_process').SpawnOptions & { extra?: string[] }} [options]
 * @returns {import('node:child_process').ChildProcess} The Vite process.
 */
export function spawnVite(config, server, { extra, ...options } = {}) {
    return spawn(process.execPath, viteServerArguments(config, server, extra), {
        cwd: ROOT,
        stdio: 'ignore',
        ...options,
    });
}

/**
 * Poll `url` until it answers 2xx. With `child`, fail fast if that process
 * exits first (e.g. `--strictPort` refused a busy port) instead of timing out.
 * @param {string} url - URL to poll.
 * @param {{ attempts?: number, intervalMs?: number, child?: import('node:child_process').ChildProcess, allowSuccessfulExit?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function waitForUrl(url, { attempts = 150, intervalMs = 100, child, allowSuccessfulExit = false } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (child && (child.exitCode !== null || child.signalCode !== null) &&
            !(allowSuccessfulExit && child.exitCode === 0))
            throw new Error(
                `Server for ${url} exited before answering (code ${child.exitCode ?? child.signalCode}). ` +
                    'Is the port already in use? Pick another with --url.',
            );
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // The process is still starting.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

/**
 * SIGTERM a child and wait for its `exit`, escalating to SIGKILL after
 * `graceMs`. Resolves (never rejects) once the process is gone or the kill
 * timeout lapses — callers delete the child's files next, and deleting a
 * Chrome profile while Chrome still writes its cache fails with ENOTEMPTY.
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 * @param {{ graceMs?: number, killMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function stopChild(child, { graceMs = 3000, killMs = 2000 } = {}) {
    if (!child) return;
    try {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = new Promise((resolveExit) => child.once('exit', () => resolveExit(true)));
        const timeout = (ms) => new Promise((resolveWait) => setTimeout(() => resolveWait(false), ms));
        if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
            const killer = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
                ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            await Promise.race([
                new Promise(resolveKill => { killer.once('exit', resolveKill); killer.once('error', resolveKill); }),
                timeout(killMs),
            ]);
            await Promise.race([exited, timeout(killMs)]);
            return;
        }
        child.kill('SIGTERM');
        if (await Promise.race([exited, timeout(graceMs)])) return;
        child.kill('SIGKILL');
        await Promise.race([exited, timeout(killMs)]);
    } finally {
        // Windows descendants can inherit pipes even after the owned parent exits.
        // Release our stream handles so a completed harness does not stay alive.
        for (const stream of child.stdio ?? []) stream?.destroy?.();
    }
}

/**
 * Close an explicitly owned browser through CDP before stopping its launcher.
 * Edge may relaunch outside the original launcher's process tree on Windows.
 * @param {{call?: Function, send?: Function, close: Function, socket?: {url: string}} | null} client - Owned CDP client
 * @param {{timeoutMs?: number}} options - Bounded shutdown wait
 */
export async function closeOwnedCdpBrowser(client, { timeoutMs = 2000 } = {}) {
    if (!client) return;
    let timer;
    try {
        if (client.socket?.url) {
            const endpoint = new URL(client.socket.url);
            const base = (endpoint.protocol === 'wss:' ? 'https://' : 'http://') + endpoint.host;
            const version = await fetch(base + '/json/version', { signal: AbortSignal.timeout(timeoutMs) }).then(r => r.json());
            // Browser.close belongs to the browser session, not the page session.
            const socket = new WebSocket(version.webSocketDebuggerUrl);
            try {
                await new Promise(resolveClose => {
                    timer = setTimeout(resolveClose, timeoutMs);
                    socket.addEventListener('open', () => socket.send(JSON.stringify({ id:1, method:'Browser.close' })), { once:true });
                    socket.addEventListener('message', resolveClose, { once:true });
                    socket.addEventListener('close', resolveClose, { once:true });
                    socket.addEventListener('error', resolveClose, { once:true });
                });
            } finally { socket.close(); }
            return;
        }
        const send = client.call ?? client.send;
        await Promise.race([
            Promise.resolve(send.call(client, 'Browser.close', {}, timeoutMs)).catch(() => {}),
            new Promise(resolveClose => { timer = setTimeout(resolveClose, timeoutMs); }),
        ]);
    } catch {
        // The owned browser may already have exited; the launcher cleanup follows.
    } finally { clearTimeout(timer); client.close(); }
}

/**
 * Remove a temp directory, retrying through the transient ENOTEMPTY/EBUSY a
 * just-exited process can still cause. Teardown must never turn a verdict
 * into a failure, so errors are warned, not thrown.
 * @param {string | null | undefined} path - Directory to remove.
 * @param {string} [label] - What the directory is, for the warning.
 * @param {number} [maxRetries] - Extra retries for slow browser shutdown on Windows.
 * @returns {Promise<boolean>} Whether the directory is gone.
 */
export async function removeTempDirectory(path, label = 'temp directory', maxRetries = 5) {
    if (!path) return true;
    const target = resolve(path);
    const temporaryRoot = resolve(tmpdir());
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(target) === normalize(temporaryRoot) ||
        !normalize(target).startsWith(normalize(temporaryRoot + sep))) {
        console.warn('warning: refusing to remove a directory outside the temporary root: ' + target);
        return false;
    }
    try {
        await rm(path, { recursive: true, force: true, maxRetries, retryDelay: 100 });
        return true;
    } catch (error) {
        console.warn(
            `warning: could not remove ${label} ${path}: ${error instanceof Error ? error.message : error}`,
        );
        return false;
    }
}
