/**
 * Replays the delegate contract spec against an in-process Delegate using a
 * fake adapter (replay strategy) and a no-op Executor. Verifies the
 * end-to-end flow without needing real CLIs or API keys.
 */

import { describe, it, expect } from 'vitest';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { runDelegateContract, type ContractSpec } from '../runContract.js';
import type { Adapter, AdapterInvocation, AdapterResult, ResumeStrategy } from '../../src/core/adapter.js';
import type { Executor } from '../../src/core/executor.js';

class FakeReplayAdapter implements Adapter {
  readonly id = 'fake-replay';
  readonly readOnly = true as const;
  readonly resumeStrategy: ResumeStrategy = 'replay';
  private turn = 0;

  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    this.turn += 1;
    let text: string;
    if (this.turn === 1) {
      text = 'Stored the codeword.';
    } else if (inv.prompt.includes('what is the codeword?')) {
      // Replay strategy: prior turn ("BANANA") is in the prompt.
      const m = /BANANA/.exec(inv.prompt);
      text = m ? 'The codeword is BANANA.' : 'I do not recall.';
    } else {
      text = 'Acknowledged.';
    }
    return {
      text,
      sessionId: inv.sessionId ?? `fake-${this.turn}`,
      raw: null,
      exitCode: 0,
      durationMs: 1,
    };
  }
}

const noopExecutor: Executor = {
  async run() {
    return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
  },
};

describe('delegate contract spec (CI mode, fake adapter)', () => {
  it('replays delegate.spec.json end-to-end', async () => {
    const specPath = join(__dirname, '..', 'contracts', 'delegate.spec.json');
    const spec: ContractSpec = JSON.parse(await fsp.readFile(specPath, 'utf8'));
    const adapter = new FakeReplayAdapter();
    const lookup = {
      get: (id: string) => (id === adapter.id ? adapter : undefined),
      list: () => [adapter],
    };
    const result = await runDelegateContract(spec, {
      adapters: lookup,
      executor: noopExecutor,
    });
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    // Turn 2 must have recalled the codeword via replay.
    const turn2 = result.steps[1].response;
    expect(turn2.output).toContain('BANANA');
  });
});
