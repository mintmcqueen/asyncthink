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
        this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
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
function parseGeminiJson(stdout) {
    if (!stdout.trim())
        return '';
    try {
        const obj = JSON.parse(stdout);
        if (obj.response)
            return obj.response;
        if (obj.error?.message)
            return `[gemini error] ${obj.error.message}`;
    }
    catch {
        // Output wasn't a single JSON object (e.g., stream-json or text fallback).
    }
    return stdout;
}
