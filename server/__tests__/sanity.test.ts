import { describe, it, expect } from 'vitest';

describe('phase 0 sanity', () => {
  it('vitest is wired', () => {
    expect(1 + 1).toBe(2);
  });

  it('contract specs parse as JSON with name + tool fields', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.resolve(__dirname, 'contracts');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.spec.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(data).toHaveProperty('name');
      expect(data).toHaveProperty('tool');
    }
  });
});
