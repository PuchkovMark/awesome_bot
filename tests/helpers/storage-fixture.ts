import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function storageFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'awesome-storage-'));
  return {
    directory,
    path: join(directory, 'test.sqlite'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
