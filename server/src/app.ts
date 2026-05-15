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
import { Delegate } from './delegate/delegate.js';
import { Council } from './asyncthink/council.js';
import { AsyncThinkingServer } from './asyncthink/thinking.js';

const manifestRegistry = new FsManifestRegistry();
const executor = new LocalSubprocessExecutor();
const threadStore = new JsonlThreadStore();
const taskStore = new FsTaskStore();
const skillRegistry = new FsSkillRegistry({ manifests: manifestRegistry });
const auditLog = new JsonlAuditLog();
// v2.5.0 — pass auditLog so CodexAdapter can emit codex.overlay.materialize.
const adapters = AdapterRegistry.withDefaults({ auditLog });
const taskExecutor = new LocalInProcessTaskExecutor({
  adapters,
  executor,
  taskStore,
  threadStore,
  auditLog,
  manifests: manifestRegistry,
});
const delegate = new Delegate(adapters, threadStore, executor, auditLog, taskExecutor, manifestRegistry);
// v2.3.1 (H1+H2): wire pre-flight gates into Council so sync forks honor the
// same rate-limit + auth-preflight contract as async forks.
const council = new Council(
  adapters,
  threadStore,
  taskStore,
  executor,
  auditLog,
  taskExecutor,
  manifestRegistry
);
const thinking = new AsyncThinkingServer();

export function getAdapters(): AdapterRegistry {
  return adapters;
}

export function getExecutor(): LocalSubprocessExecutor {
  return executor;
}

export function getThreadStore(): JsonlThreadStore {
  return threadStore;
}

export function getTaskStore(): FsTaskStore {
  return taskStore;
}

export function getDelegate(): Delegate {
  return delegate;
}

export function getCouncil(): Council {
  return council;
}

export function getThinking(): AsyncThinkingServer {
  return thinking;
}

export function getSkillRegistry(): FsSkillRegistry {
  return skillRegistry;
}

export function getAuditLog(): JsonlAuditLog {
  return auditLog;
}

export function getManifestRegistry(): FsManifestRegistry {
  return manifestRegistry;
}

export function getTaskExecutor(): LocalInProcessTaskExecutor {
  return taskExecutor;
}

/**
 * Cross-registry validation: surface skill ↔ adapter conflicts as stderr
 * warnings so operators see misconfigured skills before any caller hits
 * the runtime error. Best-effort; never throws.
 */
export async function validateRegistries(): Promise<void> {
  const { findSkillConflicts, formatSkillConflict } = await import(
    './skills/conflictValidator.js'
  );
  try {
    const [skills, manifests] = await Promise.all([
      skillRegistry.list(),
      manifestRegistry.loadAll(),
    ]);
    for (const issue of findSkillConflicts(skills, manifests)) {
      console.error(formatSkillConflict(issue));
    }
  } catch (err) {
    console.error(
      `[AsyncThink] Skill validation failed (non-fatal): ${(err as Error).message}`
    );
  }
}
