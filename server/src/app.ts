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
import { LocalSubprocessExecutor } from './exec/localSubprocess.js';
import { JsonlThreadStore } from './stores/jsonlThreadStore.js';
import { FsTaskStore } from './stores/fsTaskStore.js';
import { Delegate } from './delegate/delegate.js';
import { Council } from './asyncthink/council.js';
import { AsyncThinkingServer } from './asyncthink/thinking.js';

const adapters = AdapterRegistry.withDefaults();
const executor = new LocalSubprocessExecutor();
const threadStore = new JsonlThreadStore();
const taskStore = new FsTaskStore();
const delegate = new Delegate(adapters, threadStore, executor);
const council = new Council(adapters, threadStore, taskStore, executor);
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
