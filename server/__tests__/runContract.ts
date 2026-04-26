/**
 * runContract — replay JSON acceptance specs against the delegate tool.
 *
 * Phase 2 implementation: exercises the Delegate handler end-to-end with a
 * caller-supplied adapter lookup (fake or real). Same JSON spec runs in two
 * modes:
 *   - CI: pass a fake-adapter lookup; offline, fast, deterministic.
 *   - Live: pass AdapterRegistry.withDefaults(); real CLIs hit real APIs.
 *
 * Predicates supported in `expect`:
 *   "@nonempty"          — value is a non-empty string or array
 *   "@string"            — value is any string
 *   "@contains:<sub>"    — value is a string containing <sub>
 *   "@from:steps[N].x"   — equals the prior step's response.x
 *   <literal>            — strict equality
 */

import { promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AdapterLookup } from '../src/delegate/delegate.js';
import { Delegate } from '../src/delegate/delegate.js';
import { JsonlThreadStore } from '../src/stores/jsonlThreadStore.js';
import type { Executor } from '../src/core/executor.js';

export interface ContractSpec {
  name: string;
  tool: string;
  description?: string;
  steps: ContractStep[];
}

export interface ContractStep {
  input: Record<string, unknown>;
  expect: Record<string, unknown>;
}

export interface ContractRunOptions {
  adapters: AdapterLookup;
  executor: Executor;
}

export interface ContractRunResult {
  steps: { ok: true; response: Record<string, unknown> }[];
}

export async function runDelegateContract(
  spec: ContractSpec,
  opts: ContractRunOptions
): Promise<ContractRunResult> {
  if (spec.tool !== 'delegate') {
    throw new Error(`Spec tool "${spec.tool}" is not supported by runDelegateContract`);
  }
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'asyncthink-contract-'));
  const store = new JsonlThreadStore({ rootDir: tmp });
  const delegate = new Delegate(opts.adapters, store, opts.executor);
  const responses: Record<string, unknown>[] = [];
  try {
    for (const [idx, step] of spec.steps.entries()) {
      const input = resolveRefs(step.input, responses);
      const response = (await delegate.run(input as never)) as unknown as Record<
        string,
        unknown
      >;
      responses.push(response);
      assertExpect(step.expect, response, responses, `step ${idx}`);
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  return { steps: responses.map((r) => ({ ok: true, response: r })) };
}

function resolveRefs(
  obj: Record<string, unknown>,
  responses: Record<string, unknown>[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = resolveValue(v, responses);
  }
  return out;
}

function resolveValue(value: unknown, responses: Record<string, unknown>[]): unknown {
  if (typeof value !== 'string') return value;
  const fromMatch = /^@from:steps\[(\d+)]\.(.+)$/.exec(value);
  if (fromMatch) {
    const idx = Number(fromMatch[1]);
    const field = fromMatch[2];
    const src = responses[idx];
    if (!src) throw new Error(`@from references missing step ${idx}`);
    return src[field];
  }
  return value;
}

function assertExpect(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  responses: Record<string, unknown>[],
  ctx: string
): void {
  for (const [k, raw] of Object.entries(expected)) {
    const actualValue = actual[k];
    const expValue = resolveValue(raw, responses);
    if (typeof expValue === 'string' && expValue.startsWith('@')) {
      checkPredicate(expValue, actualValue, `${ctx}.${k}`);
    } else if (expValue !== actualValue) {
      throw new Error(
        `${ctx}.${k}: expected ${JSON.stringify(expValue)}, got ${JSON.stringify(actualValue)}`
      );
    }
  }
}

function checkPredicate(predicate: string, actual: unknown, path: string): void {
  if (predicate === '@nonempty') {
    if (typeof actual === 'string' ? actual.length === 0 : !Array.isArray(actual) || actual.length === 0) {
      throw new Error(`${path}: expected non-empty string/array, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  if (predicate === '@string') {
    if (typeof actual !== 'string') {
      throw new Error(`${path}: expected string, got ${typeof actual}`);
    }
    return;
  }
  const containsMatch = /^@contains:(.+)$/.exec(predicate);
  if (containsMatch) {
    const sub = containsMatch[1];
    if (typeof actual !== 'string' || !actual.includes(sub)) {
      throw new Error(`${path}: expected string containing ${JSON.stringify(sub)}, got ${JSON.stringify(actual)}`);
    }
    return;
  }
  throw new Error(`${path}: unknown predicate ${predicate}`);
}
