/**
 * Minimal WGSL "module" assembler.
 *
 * WGSL has no `#include`, so shader sources are composed from TS template
 * strings. Each part is deduplicated by reference so shared chunks (the
 * constants struct, color helpers) can be listed by every pass that needs
 * them without double-declaring.
 */

/**
 * Concatenates WGSL chunks into a single module source, skipping duplicate
 * chunks (matched by exact string identity after trimming).
 *
 * @param parts - WGSL source chunks in dependency order
 * @returns The assembled WGSL module source
 */
export function assembleShader(...parts: string[]): string {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of parts) {
        const key = part.trim();
        if (key.length === 0 || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out.join('\n\n') + '\n';
}
