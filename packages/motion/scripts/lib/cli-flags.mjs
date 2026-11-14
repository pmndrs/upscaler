// Copied from the upscaler repo's scripts/cli-flags.mjs (MOTION-VECTORS-PLAN §3.4: small glue is
// copied, not shared), so the motion package needs nothing from the upscaler.
// Strict `--flag value` parsing for the GPU measurement scripts. Their old
// parsers ignored anything unrecognised, so a typo (or `--help`) silently fell
// through to a full headless-Chrome GPU run with default settings.

/**
 * Parses `--name value` / `--name` (boolean) arguments against an allowlist.
 * `--help` and `-h` always parse to `{ help: true }`.
 * @param {string[]} argv - Arguments after the script path
 * @param {readonly string[]} known - Accepted flag names, without the `--`
 * @returns {Record<string, string | true>} Parsed options
 * @throws {Error} On an unknown flag or a stray positional argument
 */
export function parseFlags(argv, known) {
    const allowed = new Set(known);
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (value === '--help' || value === '-h') {
            options.help = true;
            continue;
        }
        if (!value.startsWith('--')) throw new Error(`Unexpected argument ${value}.`);
        const key = value.slice(2);
        if (!allowed.has(key)) throw new Error(`Unknown option --${key}.`);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) options[key] = true;
        else {
            options[key] = next;
            index++;
        }
    }
    return options;
}

/**
 * Parses a script's CLI, printing usage and exiting on `--help` (status 0) or
 * on a parse error (status 1) — before any server or browser is started.
 * @param {string[]} argv - Arguments after the script path
 * @param {readonly string[]} known - Accepted flag names, without the `--`
 * @param {string} usage - Help text
 * @returns {Record<string, string | true>} Parsed options
 */
export function parseCliOrExit(argv, known, usage) {
    let options;
    try {
        options = parseFlags(argv, known);
    } catch (error) {
        console.error(`${error instanceof Error ? error.message : error}\n\n${usage}`);
        process.exit(1);
    }
    if (options.help) {
        console.log(usage);
        process.exit(0);
    }
    return options;
}
