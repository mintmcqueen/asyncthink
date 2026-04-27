/**
 * v1 → v2 startup migration.
 *
 * v1 stored in-flight task state at ~/.local/share/asyncthink/ledger.json.
 * v2 uses a different layout (server/src/stores/fsTaskStore.ts persists per
 * task under tasks/<id>/state.json) and the v1 ledger is structurally
 * incompatible. We do not migrate the data — v1 entries were transient
 * worker handles, all stale by definition after a server restart.
 *
 * Strategy: rename the v1 ledger to a .bak so users can inspect it if they
 * want, log a one-line stderr warning, and proceed with v2 startup.
 */
import { existsSync, renameSync } from 'fs';
import { join } from 'path';
export function migrateV1Ledger(dataDir) {
    const dir = dataDir ?? defaultDataDir();
    const v1Path = join(dir, 'ledger.json');
    const backupPath = join(dir, 'ledger.v1.json.bak');
    if (!existsSync(v1Path))
        return { performed: false };
    try {
        renameSync(v1Path, backupPath);
        const warning = `[AsyncThink] Migrated v1 ledger to ${backupPath}. ` +
            `v2 uses a different state layout under ${dir}/tasks/. ` +
            `In-flight tasks from v1 (if any) were stale and have been discarded.`;
        return { performed: true, from: v1Path, to: backupPath, warning };
    }
    catch (err) {
        return {
            performed: false,
            warning: `[AsyncThink] Failed to back up v1 ledger at ${v1Path}: ${err.message}`,
        };
    }
}
function defaultDataDir() {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const xdg = process.env.XDG_DATA_HOME;
    const base = xdg ?? join(home, '.local', 'share');
    return join(base, 'asyncthink');
}
