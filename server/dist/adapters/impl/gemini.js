/**
 * Gemini CLI adapter.
 *
 * Argv shape:
 *   gemini -p <prompt> --output-format json --approval-mode plan -m <model>
 *          [--include-directories <dir1,dir2,...>]
 *
 * Read-only: --approval-mode plan puts Gemini in planning mode, which is the
 * read-only navigation/analysis profile.
 *
 * Session resume: Gemini's --resume flag accepts an index/'latest' from its
 * own session list, not an externally-controlled id. v1 uses the replay
 * strategy: orchestrator prepends prior turns to inv.prompt; this adapter
 * echoes inv.sessionId back (or mints a uuid). Native session resume can be
 * adopted later if live testing shows it's reliable across invocations.
 *
 * Files: passed via --include-directories (Gemini works at directory
 * granularity, not file). The adapter dedupes parent directories of the
 * provided file paths.
 */
import { randomUUID } from 'crypto';
import { dirname } from 'path';
import { resolveModel } from '../tierResolver.js';
const GEMINI_TIERS = {
    high: 'gemini-3.1-pro-preview',
    med: 'gemini-2.5-flash',
    low: 'gemini-2.5-flash-lite',
};
export class GeminiAdapter {
    id = 'gemini';
    readOnly = true;
    resumeStrategy = 'replay';
    defaultTimeoutMs;
    tiers;
    defaultTier;
    constructor(opts = {}) {
        this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 180_000;
        this.tiers = opts.tiers ?? GEMINI_TIERS;
        this.defaultTier = opts.defaultTier ?? 'med';
    }
    async invoke(inv, exec) {
        const model = resolveModel(inv, this.tiers, this.defaultTier);
        const argv = [
            '-p',
            inv.prompt,
            '--output-format',
            'json',
            '--approval-mode',
            'plan',
            // Modern gemini-cli refuses approval-mode overrides outside "trusted"
            // folders. We invoke programmatically from arbitrary cwds; --skip-trust
            // is the documented way to bypass the prompt for headless use. The
            // sandbox is still --approval-mode plan (read-only).
            '--skip-trust',
            '-m',
            model,
        ];
        if (inv.files?.length) {
            const dirs = uniqueDirs(inv.files);
            argv.push('--include-directories', dirs.join(','));
        }
        const result = await exec.run({
            bin: 'gemini',
            argv,
            cwd: inv.cwd ?? process.cwd(),
            env: { ...process.env, ...(inv.env ?? {}) },
            timeoutMs: inv.timeoutMs ?? this.defaultTimeoutMs,
        });
        const text = parseGeminiJson(result.stdout);
        return {
            text,
            sessionId: inv.sessionId ?? randomUUID(),
            raw: { stdout: result.stdout, stderr: result.stderr },
            exitCode: result.exitCode,
            durationMs: result.durationMs,
        };
    }
}
function uniqueDirs(files) {
    const set = new Set();
    for (const f of files)
        set.add(dirname(f));
    return [...set].sort();
}
/**
 * Parse gemini-cli's --output-format=json output.
 *
 * Modern gemini-cli prepends operational noise to stdout in some
 * configurations — most commonly "MCP issues detected. Run /mcp list for
 * status." when the user has gemini's own MCP servers configured but
 * misbehaving. This noise can sit BEFORE the actual JSON object.
 *
 * Strategy: locate the first top-level JSON object in the output and parse
 * just that. If that succeeds and yields a `response` field, use it. If the
 * payload yields an `error.message`, surface a structured error string.
 * If we can't find any JSON, return an empty string (NOT the raw stdout —
 * returning the noise as the answer is the bug F2 fixes).
 *
 * The raw stdout/stderr are still returned in AdapterResult.raw so callers
 * who need to debug can see what actually came out.
 */
function parseGeminiJson(stdout) {
    if (!stdout.trim())
        return '';
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0)
        return '';
    // Scan for the matching closing brace. Gemini's JSON output is a single
    // top-level object; we need to handle string escapes correctly.
    const braceEnd = findMatchingBrace(stdout, jsonStart);
    if (braceEnd < 0)
        return '';
    const candidate = stdout.slice(jsonStart, braceEnd + 1);
    try {
        const obj = JSON.parse(candidate);
        if (typeof obj.response === 'string' && obj.response.length > 0) {
            return obj.response;
        }
        if (obj.error && typeof obj.error.message === 'string') {
            return `[gemini error] ${obj.error.message}`;
        }
        // JSON parsed but had neither field — surface empty rather than the
        // surrounding noise.
        return '';
    }
    catch {
        return '';
    }
}
function findMatchingBrace(s, openAt) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = openAt; i < s.length; i++) {
        const c = s[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (inStr) {
            if (c === '\\')
                escape = true;
            else if (c === '"')
                inStr = false;
            continue;
        }
        if (c === '"')
            inStr = true;
        else if (c === '{')
            depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return -1;
}
