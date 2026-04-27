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
export interface MigrationResult {
    performed: boolean;
    from?: string;
    to?: string;
    warning?: string;
}
export declare function migrateV1Ledger(dataDir?: string): MigrationResult;
