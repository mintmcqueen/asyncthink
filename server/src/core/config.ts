/**
 * Server configuration (XDG-compliant persistence).
 *
 * v1 implementation will be ported from src.v1/lib/config.ts in Phase 1+, with
 * Gemini-specific keys removed. v3 swaps to a remote-config service or env-vars
 * sourced from the hosted service.
 */

export interface AsyncThinkConfig {
  /** Default subprocess timeout for all adapters (ms). */
  defaultTimeoutMs: number;
  /** Maximum number of concurrent council forks per asyncthink chain. */
  defaultWorkerCount: number;
  /** Max idle time before threads are auto-swept closed (ms). */
  threadIdleMs: number;
  /** Audit log retention (days). */
  auditRetentionDays: number;
  /** Logging verbosity. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface ConfigManager {
  get(): AsyncThinkConfig;
  getValue<K extends keyof AsyncThinkConfig>(key: K): AsyncThinkConfig[K];
  update(patch: Partial<AsyncThinkConfig>): void;
  reset(): void;
  /** Path on disk where the config file lives. */
  getConfigPath(): string;
  /** XDG data dir for tasks/threads/audit. */
  getDataDir(): string;
  /** Ensure XDG dirs exist. */
  ensureDirectories(): void;
}
