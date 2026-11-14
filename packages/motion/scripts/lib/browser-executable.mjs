// Copied from the upscaler repo's scripts/browser-executable.mjs (MOTION-VECTORS-PLAN §3.4: small glue is
// copied, not shared), so the motion package needs nothing from the upscaler.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function browserCandidates(platform = process.platform, env = process.env) {
    if (platform === 'win32') {
        const program = env.ProgramFiles ?? 'C:/Program Files';
        const x86 = env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)';
        const local = env.LOCALAPPDATA;
        return [
            join(program, 'Google/Chrome/Application/chrome.exe'),
            join(x86, 'Google/Chrome/Application/chrome.exe'),
            ...(local ? [join(local, 'Google/Chrome/Application/chrome.exe')] : []),
            join(x86, 'Microsoft/Edge/Application/msedge.exe'),
            join(program, 'Microsoft/Edge/Application/msedge.exe'),
            ...(local ? [join(local, 'Microsoft/Edge/Application/msedge.exe')] : []),
        ];
    }
    if (platform === 'darwin') return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

/** Explicit paths are authoritative; a typo must not silently select a different browser. */
export function browserExecutable(explicit, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
    const selected = explicit ?? env.CHROME_PATH;
    if (selected !== undefined) {
        if (typeof selected !== 'string' || !selected.trim()) throw new Error('Browser path needs a value.');
        if (!exists(selected)) throw new Error('Browser executable does not exist: ' + selected);
        return selected;
    }
    const executable = browserCandidates(platform, env).find(exists);
    if (!executable) throw new Error('Chrome/Edge not found. Pass --chrome <path> or set CHROME_PATH.');
    return executable;
}
