/**
 * AsyncThink Configuration Management
 *
 * Features:
 * - XDG-compliant persistent storage (~/.local/share/asyncthink/)
 * - Runtime configuration
 * - Task storage location management
 *
 * Configuration Priority:
 * 1. Persisted config file (highest priority for runtime changes)
 * 2. Environment variables
 * 3. Default values
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// =============================================================================
// Configuration Schema
// =============================================================================

export interface AsyncThinkConfig {
  /** Default number of sub-queries per research task (1-3, max 3) */
  defaultWorkerCount: number;

  /** Worker timeout in milliseconds (Claude Code subprocess) */
  workerTimeoutMs: number;

  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  /** Worker command (default: 'claude') */
  workerCommand: string;

  /** Worker args template (default: ['--print']) - prompt appended */
  workerArgs: string[];

  /** Enable Gemini workers (requires GOOGLE_API_KEY or GEMINI_API_KEY) */
  enableGemini: boolean;

  /** Gemini model for fast workers (default: gemini-2.5-flash) */
  geminiModel: string;

  /** Gemini worker timeout in milliseconds (much faster than Claude Code) */
  geminiTimeoutMs: number;

  /** Last modified timestamp */
  lastModified?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: AsyncThinkConfig = {
  defaultWorkerCount: 3,
  workerTimeoutMs: 120000, // 2 minutes - Claude Code may need more time
  logLevel: 'info',
  workerCommand: 'claude',
  workerArgs: ['--print', '--dangerously-skip-permissions'],
  enableGemini: true, // Enable by default if API key is available
  geminiModel: 'gemini-3-pro-preview',
  geminiTimeoutMs: 30000, // 30 seconds - Gemini is much faster
};

// =============================================================================
// XDG Paths
// =============================================================================

function defaultDataDir(): string {
  // XDG_DATA_HOME or default to ~/.local/share
  const xdgDataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdgDataHome, 'asyncthink');
}

function defaultTasksDir(): string {
  return join(defaultDataDir(), 'tasks');
}

function defaultConfigPath(): string {
  return join(defaultDataDir(), 'config.json');
}

// =============================================================================
// Configuration Manager Class
// =============================================================================

export class ConfigManager {
  private config: AsyncThinkConfig;
  private configPath: string;
  private dataDir: string;
  private tasksDir: string;
  private loaded = false;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.configPath = defaultConfigPath();
    this.dataDir = defaultDataDir();
    this.tasksDir = defaultTasksDir();
  }

  /**
   * Ensure the data and tasks directories exist
   */
  ensureDirectories(): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
      console.error(`[Config] Created data directory: ${this.dataDir}`);
    }
    if (!existsSync(this.tasksDir)) {
      mkdirSync(this.tasksDir, { recursive: true });
      console.error(`[Config] Created tasks directory: ${this.tasksDir}`);
    }
  }

  /**
   * Load configuration from disk
   */
  load(): AsyncThinkConfig {
    if (this.loaded) {
      return this.config;
    }

    try {
      if (existsSync(this.configPath)) {
        const data = readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(data) as Partial<AsyncThinkConfig>;

        // Merge with defaults (in case new fields were added)
        this.config = {
          ...DEFAULT_CONFIG,
          ...parsed,
        };

        console.error(`[Config] Loaded from: ${this.configPath}`);
      } else {
        // Apply environment variable overrides
        this.applyEnvOverrides();
        console.error('[Config] Using defaults (no config file found)');
      }
    } catch (error: any) {
      console.error(`[Config] Error loading config: ${error.message}`);
      this.config = { ...DEFAULT_CONFIG };
      this.applyEnvOverrides();
    }

    this.loaded = true;
    return this.config;
  }

  /**
   * Apply environment variable overrides
   */
  private applyEnvOverrides(): void {
    // ASYNCTHINK_DEFAULT_WORKERS
    if (process.env.ASYNCTHINK_DEFAULT_WORKERS) {
      const workers = parseInt(process.env.ASYNCTHINK_DEFAULT_WORKERS, 10);
      if (!isNaN(workers) && workers >= 1 && workers <= 5) {
        this.config.defaultWorkerCount = workers;
      }
    }

    // ASYNCTHINK_TIMEOUT_MS
    if (process.env.ASYNCTHINK_TIMEOUT_MS) {
      const timeout = parseInt(process.env.ASYNCTHINK_TIMEOUT_MS, 10);
      if (!isNaN(timeout) && timeout >= 30000) {
        this.config.workerTimeoutMs = timeout;
      }
    }

    // ASYNCTHINK_LOG_LEVEL
    if (process.env.ASYNCTHINK_LOG_LEVEL) {
      const level = process.env.ASYNCTHINK_LOG_LEVEL as any;
      if (['debug', 'info', 'warn', 'error'].includes(level)) {
        this.config.logLevel = level;
      }
    }
  }

  /**
   * Save configuration to disk
   */
  save(): void {
    try {
      this.ensureDirectories();

      // Update last modified
      this.config.lastModified = new Date().toISOString();

      writeFileSync(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf-8'
      );

      console.error(`[Config] Saved to: ${this.configPath}`);
    } catch (error: any) {
      console.error(`[Config] Error saving config: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get current configuration
   */
  get(): AsyncThinkConfig {
    if (!this.loaded) {
      this.load();
    }
    return { ...this.config };
  }

  /**
   * Get a specific config value
   */
  getValue<K extends keyof AsyncThinkConfig>(
    key: K
  ): AsyncThinkConfig[K] {
    if (!this.loaded) {
      this.load();
    }
    return this.config[key];
  }

  /**
   * Update multiple config values and persist
   */
  update(updates: Partial<AsyncThinkConfig>): void {
    if (!this.loaded) {
      this.load();
    }

    // Validate updates
    if (updates.defaultWorkerCount !== undefined) {
      if (updates.defaultWorkerCount < 1 || updates.defaultWorkerCount > 5) {
        throw new Error('defaultWorkerCount must be between 1 and 5');
      }
    }

    if (updates.logLevel !== undefined) {
      if (!['debug', 'info', 'warn', 'error'].includes(updates.logLevel)) {
        throw new Error('logLevel must be one of: debug, info, warn, error');
      }
    }

    // Apply updates
    this.config = {
      ...this.config,
      ...updates,
    };

    this.save();
  }

  /**
   * Reset configuration to defaults and persist
   */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.save();
    console.error('[Config] Reset to defaults');
  }

  /**
   * Get the config file path
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Get the data directory path
   */
  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Get the tasks directory path
   */
  getTasksDir(): string {
    return this.tasksDir;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let configInstance: ConfigManager | null = null;

/**
 * Get the singleton ConfigManager instance
 */
export function getConfigManager(): ConfigManager {
  if (!configInstance) {
    configInstance = new ConfigManager();
  }
  return configInstance;
}

/**
 * Reset the config manager (for testing)
 */
export function resetConfigManager(): void {
  configInstance = null;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Get full config
 */
export function getConfig(): AsyncThinkConfig {
  return getConfigManager().get();
}

/**
 * Update config
 */
export function updateConfig(updates: Partial<AsyncThinkConfig>): void {
  getConfigManager().update(updates);
}

/**
 * Get tasks directory
 */
export function getTasksDir(): string {
  return getConfigManager().getTasksDir();
}
