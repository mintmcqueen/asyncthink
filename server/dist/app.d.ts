/**
 * Application singletons.
 *
 * Wires the per-process singletons (adapter registry, executor, thread
 * store, delegate) so tool handlers can access them without re-instantiating.
 *
 * v3 swap point: this is where DI substitutes RemoteCompanionExecutor and
 * Firestore-backed stores when the cloud server is built.
 *
 * v2.2 additions:
 *   - `taskExecutor` singleton (LocalInProcessTaskExecutor) for delegate-
 *     async + delegate forks (Phase 4 unifies Council to use this).
 *   - `manifestRegistry` is now passed into FsSkillRegistry so pinIsCurrent
 *     derivation works (R6b-D.3).
 */
import { AdapterRegistry } from './adapters/index.js';
import { FsManifestRegistry } from './adapters/registry.js';
import { LocalSubprocessExecutor } from './exec/localSubprocess.js';
import { LocalInProcessTaskExecutor } from './exec/localInProcessTaskExecutor.js';
import { JsonlThreadStore } from './stores/jsonlThreadStore.js';
import { FsTaskStore } from './stores/fsTaskStore.js';
import { FsSkillRegistry } from './stores/skillRegistry.js';
import { JsonlAuditLog } from './stores/jsonlAuditLog.js';
import { FsSettingsStore } from './stores/fsSettingsStore.js';
import { FsSubagentRegistry } from './stores/fsSubagentRegistry.js';
import { Delegate } from './delegate/delegate.js';
import { Council } from './asyncthink/council.js';
import { AsyncThinkingServer } from './asyncthink/thinking.js';
export declare function getAdapters(): AdapterRegistry;
export declare function getExecutor(): LocalSubprocessExecutor;
export declare function getThreadStore(): JsonlThreadStore;
export declare function getTaskStore(): FsTaskStore;
export declare function getDelegate(): Delegate;
export declare function getCouncil(): Council;
export declare function getThinking(): AsyncThinkingServer;
export declare function getSkillRegistry(): FsSkillRegistry;
export declare function getAuditLog(): JsonlAuditLog;
export declare function getManifestRegistry(): FsManifestRegistry;
export declare function getTaskExecutor(): LocalInProcessTaskExecutor;
export declare function getSettingsStore(): FsSettingsStore;
export declare function getSubagentRegistry(): FsSubagentRegistry;
/**
 * Cross-registry validation: surface skill ↔ adapter conflicts as stderr
 * warnings so operators see misconfigured skills before any caller hits
 * the runtime error. Best-effort; never throws.
 */
/**
 * v2.6.0 — bootstrap built-in subagents on first run. Idempotent: existing
 * customizations win. Called from index.ts after singleton wiring.
 */
export declare function bootstrapBuiltins(): Promise<void>;
export declare function validateRegistries(): Promise<void>;
