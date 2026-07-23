import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

describe('ZMP Device entry contract', () => {
  it('provides the project-root Vite entry requested by zmp start --device', () => {
    const deviceEntry = readRepositoryFile('apps/mini-app/index.html');

    expect(deviceEntry).toContain('<div id="app"></div>');
    expect(deviceEntry).toContain('src="/src/main.tsx"');
  });

  it('uses the ZMP #app mount point in both Device and build entries', () => {
    const buildEntry = readRepositoryFile('apps/mini-app/src/index.html');
    const applicationEntry = readRepositoryFile('apps/mini-app/src/main.tsx');

    expect(buildEntry).toContain('<div id="app"></div>');
    expect(applicationEntry).toContain("document.querySelector('#app')");
  });
});
