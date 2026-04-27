/**
 * asyncthink_config tool — adapter, skill, and task introspection.
 *
 * v2.2 surface:
 *   list_adapters    → registered adapters with binary availability +
 *                      env-readiness + tierLimits
 *   list_skills      → all loaded skills with pinsModel + pinIsCurrent
 *   reload_skills    → force re-scan of skill directories
 *   list_tasks       → alias for tasks_list (R4-D.2)
 *   cancel_task      → alias for tasks_cancel (R4-D.2)
 *
 * The general config get/set/reset surface remains reserved for a future
 * persistence layer; v2.2 returns "not yet implemented" for those.
 */
import { z } from 'zod';
import { existsSync } from 'fs';
import { delimiter, join } from 'path';
import { getManifestRegistry, getSkillRegistry, getTaskExecutor, } from '../app.js';
import { TaskNotFoundError } from '../core/taskExecutor.js';
export function registerConfigTool(server) {
    server.registerTool('asyncthink_config', {
        title: 'AsyncThink Configuration',
        description: 'Introspect adapters, skills, and tasks. Use list_adapters to check availability of subordinate CLIs (now includes per-tier limits); list_skills to see what skill ids resolve via the registry; reload_skills after editing a user skill file; list_tasks / cancel_task for async-task introspection.',
        inputSchema: {
            action: z
                .enum([
                'list_adapters',
                'list_skills',
                'reload_skills',
                'list_tasks',
                'cancel_task',
                'get',
                'set',
                'reset',
            ])
                .describe('Action to perform.'),
            // Optional input for cancel_task / list_tasks.
            taskId: z.string().optional().describe('Task id (cancel_task only).'),
            cursor: z.string().optional().describe('Pagination cursor (list_tasks only).'),
            limit: z
                .number()
                .int()
                .min(1)
                .max(200)
                .optional()
                .describe('Page size (list_tasks only; default 50).'),
        },
    }, async (args) => {
        const action = args.action;
        let payload;
        switch (action) {
            case 'list_adapters': {
                const manifests = await getManifestRegistry().loadAll();
                const adapters = manifests.map((m) => {
                    const binaryPath = whichSync(m.binary);
                    const envMissing = adapterEnvMissing(m.requiredEnv);
                    return {
                        id: m.id,
                        displayName: m.displayName,
                        binary: m.binary,
                        binaryPath,
                        binaryAvailable: !!binaryPath,
                        tiers: m.tiers,
                        defaultTier: m.defaultTier,
                        defaultTimeoutMs: m.defaultTimeoutMs,
                        envOk: envMissing.length === 0,
                        envMissing,
                        description: m.description,
                        tierLimits: m.tierLimits,
                    };
                });
                payload = { adapters };
                break;
            }
            case 'list_skills': {
                const skills = await getSkillRegistry().list();
                payload = {
                    skills: skills.map((s) => ({
                        name: s.name,
                        adapter: s.adapter,
                        intelligence: s.intelligence,
                        model: s.model,
                        filesGlob: s.filesGlob,
                        timeoutMs: s.timeoutMs,
                        description: s.description,
                        source: s.source,
                        credentials: s.credentials,
                        pinsModel: s.pinsModel ?? null,
                        pinIsCurrent: s.pinIsCurrent,
                    })),
                };
                break;
            }
            case 'reload_skills': {
                await getSkillRegistry().reload();
                const skills = await getSkillRegistry().list();
                payload = { reloaded: true, skillCount: skills.length };
                break;
            }
            case 'list_tasks': {
                const result = await getTaskExecutor().list({
                    cursor: args.cursor,
                    limit: args.limit,
                    principal: null,
                });
                payload = result;
                break;
            }
            case 'cancel_task': {
                if (!args.taskId) {
                    payload = { error: 'invalid_args', message: 'cancel_task requires taskId.' };
                    break;
                }
                try {
                    const state = await getTaskExecutor().cancel(args.taskId);
                    payload = state;
                }
                catch (err) {
                    if (err instanceof TaskNotFoundError) {
                        payload = { error: 'task_not_found', message: err.message };
                        break;
                    }
                    payload = {
                        error: 'task_error',
                        message: err instanceof Error ? err.message : String(err),
                    };
                }
                break;
            }
            case 'get':
            case 'set':
            case 'reset':
                payload = {
                    status: 'not_implemented',
                    note: 'General config persistence ships in v2.3+. v2.2 surface is read-only via list_adapters / list_skills / list_tasks plus the cancel_task action.',
                };
                break;
            default:
                payload = { status: 'error', error: `Unknown action: ${String(action)}` };
        }
        return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
            structuredContent: payload,
        };
    });
}
/**
 * Required-env semantics: empty array means none required. Non-empty means
 * AT LEAST ONE of the listed env vars must be set. Returns the list of
 * candidates that are unset (empty if at least one is set).
 */
function adapterEnvMissing(required) {
    if (required.length === 0)
        return [];
    const setVars = required.filter((v) => process.env[v] && process.env[v].length > 0);
    if (setVars.length > 0)
        return [];
    return required;
}
function whichSync(bin) {
    if (bin.includes('/')) {
        return existsSync(bin) ? bin : undefined;
    }
    const PATH = process.env.PATH ?? '';
    const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
    for (const dir of PATH.split(delimiter)) {
        if (!dir)
            continue;
        for (const ext of exts) {
            const p = join(dir, bin + ext);
            if (existsSync(p))
                return p;
        }
    }
    return undefined;
}
