/**
 * AsyncThink Orchestrator
 *
 * Spawns workers for async research:
 * - Claude Code workers: Full capability (repo, docs, web) - 45-90s
 * - Gemini workers: Fast feedback/web research - 2-5s
 *
 * Key principles:
 * - Claude Code via `claude --print <prompt>` (non-blocking subprocess)
 * - Gemini via direct API call (fast, synchronous)
 * - Task state persisted to filesystem
 * - Result retrieval by reading stdout file or direct response
 */

import { spawn, ChildProcess } from 'child_process';
import { openSync, closeSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getLedger } from './ledger.js';
import { formatOrganizerPrompt, formatGeminiPrompt } from '../prompts/organizer.js';
import { getConfigManager } from './config.js';
import { getGeminiClient, GeminiClient } from './gemini-client.js';

export type WorkerType = 'claude' | 'gemini';

export interface SpawnResult {
  researchId: string;
  pid?: number;
  taskDir: string;
  workerType: WorkerType;
}

/**
 * Spawn an organizer worker to research a topic
 *
 * The organizer worker is a full Claude Code session that:
 * 1. Decomposes the topic into sub-queries
 * 2. Uses appropriate tools directly (Read/Grep, Gemini, WebSearch, etc.)
 * 3. Returns structured JSON results
 */
export async function spawnOrganizerWorker(
  researchId: string,
  topic: string,
  hint?: string
): Promise<SpawnResult> {
  const ledger = getLedger();
  const config = getConfigManager();

  // Create task directory
  const taskDir = ledger.createTask(researchId, topic);

  // Format the organizer prompt
  const prompt = formatOrganizerPrompt(topic, hint);

  // Prepare stdout/stderr files
  const stdoutPath = join(taskDir, 'stdout');
  const stderrPath = join(taskDir, 'stderr');

  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');

  // Get worker command from config (allows mock for testing)
  const workerCommand = config.getValue('workerCommand');
  const workerArgs = [...config.getValue('workerArgs'), prompt];

  console.error(`[Orchestrator] Spawning organizer worker for: ${researchId}`);
  console.error(`[Orchestrator] Topic: ${topic.slice(0, 100)}...`);
  console.error(`[Orchestrator] Task dir: ${taskDir}`);
  console.error(`[Orchestrator] Command: ${workerCommand} ${workerArgs[0]}...`);

  try {
    // Spawn worker process (Claude Code in print mode, or mock for testing)
    const proc = spawn(workerCommand, workerArgs, {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      shell: workerCommand.endsWith('.sh'), // Use shell for script files
    });

    // Don't wait for child process
    proc.unref();

    // Close our file descriptors (child has its own)
    closeSync(stdoutFd);
    closeSync(stderrFd);

    const pid = proc.pid!;

    // Update ledger with PID
    ledger.updateTask(researchId, {
      pid,
      status: 'running',
      startTime: new Date().toISOString(),
    });

    console.error(`[Orchestrator] Spawned Claude Code worker with PID: ${pid}`);

    return {
      researchId,
      pid,
      taskDir,
      workerType: 'claude' as const,
    };
  } catch (error: any) {
    // Close file descriptors on error
    try {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    } catch {}

    // Update ledger with error
    ledger.updateTask(researchId, {
      status: 'failed',
      error: error.message,
    });

    throw error;
  }
}

/**
 * Execute a Gemini worker for fast feedback/collaboration
 *
 * Unlike Claude Code workers, Gemini workers:
 * 1. Execute quickly (2-30 seconds depending on mode)
 * 2. Can use grounded search when needed
 * 3. Support file uploads for context in ANY mode
 * 4. Best for: metacognitive feedback, critique, deep collaboration
 */
export async function executeGeminiWorker(
  researchId: string,
  topic: string,
  workerType: 'feedback' | 'critique' | 'collaborate' | 'web',
  hint?: string,
  files?: string[]
): Promise<SpawnResult> {
  const ledger = getLedger();
  const config = getConfigManager();

  // Check if Gemini is enabled and available
  if (!config.getValue('enableGemini')) {
    throw new Error('Gemini workers are disabled. Enable via config or use Claude Code workers.');
  }

  if (!GeminiClient.isAvailable()) {
    throw new Error(
      'Gemini API key not found. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable.'
    );
  }

  // Create task directory for result storage
  const taskDir = ledger.createTask(researchId, topic);

  console.error(`[Orchestrator] Executing Gemini worker for: ${researchId}`);
  console.error(`[Orchestrator] Type: ${workerType}, Topic: ${topic.slice(0, 100)}...`);

  // Update ledger to running
  ledger.updateTask(researchId, {
    status: 'running',
    startTime: new Date().toISOString(),
  });

  try {
    const geminiClient = getGeminiClient();

    let result;

    // Use collaborate() if files provided (any mode), otherwise generateContent()
    if (files && files.length > 0) {
      console.error(`[Orchestrator] Using file upload mode with ${files.length} files`);
      result = await geminiClient.collaborate({
        message: topic,
        files: files,
        context: hint,
        enableGroundedSearch: workerType === 'web',
        maxTokens: 8000,
      });
    } else {
      // No files - use quick prompt mode
      const prompt = formatGeminiPrompt(topic, workerType as 'feedback' | 'web' | 'critique', hint);
      result = await geminiClient.generateContent({
        prompt,
        enableGroundedSearch: workerType === 'web',
        maxTokens: 4000,
        temperature: workerType === 'critique' ? 0.8 : 0.7,
      });
    }

    // Build structured result
    const structuredResult = {
      subQueries: [
        {
          type: workerType,
          query: topic,
          result: result.text,
        },
      ],
      synthesis: result.text,
      groundingMetadata: result.groundingMetadata,
      filesUploaded: files?.length || 0,
    };

    // Write result to task directory
    const stdoutPath = join(taskDir, 'stdout');
    writeFileSync(stdoutPath, JSON.stringify(structuredResult, null, 2), 'utf-8');

    // Update ledger with success
    ledger.updateTask(researchId, {
      status: 'complete',
      result: JSON.stringify(structuredResult),
      completeTime: new Date().toISOString(),
    });

    console.error(`[Orchestrator] Gemini worker ${researchId} completed`);

    return {
      researchId,
      taskDir,
      workerType: 'gemini' as const,
    };
  } catch (error: any) {
    // Update ledger with error
    ledger.updateTask(researchId, {
      status: 'failed',
      error: error.message,
      completeTime: new Date().toISOString(),
    });

    console.error(`[Orchestrator] Gemini worker ${researchId} failed: ${error.message}`);
    throw error;
  }
}

/**
 * Check if a worker process is still running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the result from a completed worker
 */
export function readWorkerResult(taskDir: string): string | null {
  const stdoutPath = join(taskDir, 'stdout');

  if (!existsSync(stdoutPath)) {
    return null;
  }

  try {
    const content = readFileSync(stdoutPath, 'utf-8');
    return content.trim() || null;
  } catch (error: any) {
    console.error(`[Orchestrator] Error reading result: ${error.message}`);
    return null;
  }
}

/**
 * Read stderr from a worker (for debugging)
 */
export function readWorkerStderr(taskDir: string): string | null {
  const stderrPath = join(taskDir, 'stderr');

  if (!existsSync(stderrPath)) {
    return null;
  }

  try {
    const content = readFileSync(stderrPath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parse structured JSON result from worker output
 */
export function parseWorkerResult(output: string): {
  subQueries?: Array<{
    type: string;
    query: string;
    result: string;
  }>;
  synthesis?: string;
  error?: string;
} {
  // Try to extract JSON from the output
  // The worker should return only JSON, but there may be extra text

  // First try: direct JSON parse
  try {
    return JSON.parse(output);
  } catch {}

  // Second try: find JSON object in output
  const jsonMatch = output.match(/\{[\s\S]*"subQueries"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  // Third try: find any JSON object
  const anyJsonMatch = output.match(/\{[\s\S]*\}/);
  if (anyJsonMatch) {
    try {
      return JSON.parse(anyJsonMatch[0]);
    } catch {}
  }

  // Failed to parse - return error
  return {
    error: 'Failed to parse worker output as JSON',
    synthesis: output.slice(0, 1000), // Include raw output for debugging
  };
}

/**
 * Check and collect results for completed workers
 */
export function checkAndCollectResults(): Array<{
  researchId: string;
  result: ReturnType<typeof parseWorkerResult>;
}> {
  const ledger = getLedger();
  const results: Array<{
    researchId: string;
    result: ReturnType<typeof parseWorkerResult>;
  }> = [];

  // Get all running tasks
  const runningTasks = ledger.getTasksByStatus('running');

  for (const task of runningTasks) {
    if (!task.pid) continue;

    // Check if process is still running
    if (!isProcessRunning(task.pid)) {
      // Process finished - read result
      const output = readWorkerResult(task.taskDir);

      if (output) {
        const parsed = parseWorkerResult(output);

        // Update ledger
        ledger.updateTask(task.id, {
          status: parsed.error ? 'failed' : 'complete',
          result: JSON.stringify(parsed),
          completeTime: new Date().toISOString(),
          error: parsed.error,
        });

        results.push({
          researchId: task.id,
          result: parsed,
        });

        console.error(`[Orchestrator] Worker ${task.id} completed`);
      } else {
        // No output - check stderr
        const stderr = readWorkerStderr(task.taskDir);

        ledger.updateTask(task.id, {
          status: 'failed',
          error: stderr || 'No output produced',
          completeTime: new Date().toISOString(),
        });

        results.push({
          researchId: task.id,
          result: { error: stderr || 'No output produced' },
        });

        console.error(`[Orchestrator] Worker ${task.id} failed: ${stderr || 'no output'}`);
      }
    }
  }

  return results;
}

/**
 * Check for timed out workers
 */
export function checkTimeouts(): string[] {
  const ledger = getLedger();
  const config = getConfigManager();
  const timeoutMs = config.getValue('workerTimeoutMs');
  const timedOut: string[] = [];

  const runningTasks = ledger.getTasksByStatus('running');
  const now = Date.now();

  for (const task of runningTasks) {
    if (!task.startTime) continue;

    const startTime = new Date(task.startTime).getTime();
    const elapsed = now - startTime;

    if (elapsed > timeoutMs) {
      // Task timed out
      ledger.updateTask(task.id, {
        status: 'failed',
        error: `Timed out after ${Math.round(elapsed / 1000)}s`,
        completeTime: new Date().toISOString(),
      });

      // Try to kill the process
      if (task.pid) {
        try {
          process.kill(task.pid, 'SIGTERM');
        } catch {}
      }

      timedOut.push(task.id);
      console.error(`[Orchestrator] Worker ${task.id} timed out`);
    }
  }

  return timedOut;
}
