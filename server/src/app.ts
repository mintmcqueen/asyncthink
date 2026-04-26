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
import { Delegate } from './delegate/delegate.js';

const adapters = AdapterRegistry.withDefaults();
const executor = new LocalSubprocessExecutor();
const threadStore = new JsonlThreadStore();
const delegate = new Delegate(adapters, threadStore, executor);

export function getAdapters(): AdapterRegistry {
  return adapters;
}

export function getExecutor(): LocalSubprocessExecutor {
  return executor;
}

export function getThreadStore(): JsonlThreadStore {
  return threadStore;
}

export function getDelegate(): Delegate {
  return delegate;
}
