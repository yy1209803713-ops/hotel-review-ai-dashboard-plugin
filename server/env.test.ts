import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLocalEnvFiles } from './env';

describe('loadLocalEnvFiles', () => {
  afterEach(() => {
    delete process.env.LARK_APP_ID;
    delete process.env.LARK_APP_SECRET;
    delete process.env.WARMUP_SECRET;
    delete process.env.VITE_BACKEND_ENDPOINT_URL;
  });

  it('loads values from .env and .env.local without overwriting shell env', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hotel-review-ai-env-'));
    writeFileSync(join(cwd, '.env'), 'LARK_APP_ID=file-app\nWARMUP_SECRET=file-warmup\n', 'utf8');
    writeFileSync(
      join(cwd, '.env.local'),
      'LARK_APP_SECRET=local-secret\nVITE_BACKEND_ENDPOINT_URL=https://backend.example.com\n',
      'utf8',
    );

    process.env.LARK_APP_ID = 'shell-app';

    loadLocalEnvFiles(cwd, process.env);

    expect(process.env.LARK_APP_ID).toBe('shell-app');
    expect(process.env.LARK_APP_SECRET).toBe('local-secret');
    expect(process.env.WARMUP_SECRET).toBe('file-warmup');
    expect(process.env.VITE_BACKEND_ENDPOINT_URL).toBe('https://backend.example.com');
  });
});
