/**
 * Application singletons.
 *
 * Wires the per-process singletons (adapter registry, executor, thread
 * store, delegate) so tool handlers can access them without re-instantiating.
 *
 * v3 swap point: this is where DI substitutes RemoteCompanionExecutor and
 * Firestore-backed stores when the cloud server is built.
 */
import { AdapterRegistry } from './adapters/index.js';
import { FsManifestRegistry } from './adapters/registry.js';
import { LocalSubprocessExecutor } from './exec/localSubprocess.js';
import { JsonlThreadStore } from './stores/jsonlThreadStore.js';
import { FsTaskStore } from './stores/fsTaskStore.js';
import { FsSkillRegistry } from './stores/skillRegistry.js';
import { JsonlAuditLog } from './stores/jsonlAuditLog.js';
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
