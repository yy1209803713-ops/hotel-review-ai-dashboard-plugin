import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadLocalEnvFiles } from './env';

describe('loadLocalEnvFiles', () => {
  it('loads values from .env and .env.local without overwriting shell env', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hotel-review-ai-env-'));
    writeFileSync(join(cwd, '.env'), 'LARK_BASE_AUTH_CODE=file-auth-code\nWARMUP_SECRET=file-warmup\n', 'utf8');
    writeFileSync(
      join(cwd, '.env.local'),
      'LARK_BASE_AUTH_CODE=local-auth-code\nVITE_BACKEND_ENDPOINT_URL=https://backend.example.com\n',
      'utf8',
    );

    const env: NodeJS.ProcessEnv = {
      LARK_BASE_AUTH_CODE: 'shell-auth-code',
    };

    loadLocalEnvFiles(cwd, env);

    expect(env.LARK_BASE_AUTH_CODE).toBe('shell-auth-code');
    expect(env.WARMUP_SECRET).toBe('file-warmup');
    expect(env.VITE_BACKEND_ENDPOINT_URL).toBe('https://backend.example.com');
  });

  it('loads LARK_BASE_AUTH_CODE from local env files when shell env is empty', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hotel-review-ai-env-'));
    writeFileSync(join(cwd, '.env'), 'WARMUP_SECRET=file-warmup\n', 'utf8');
    writeFileSync(
      join(cwd, '.env.local'),
      'LARK_BASE_AUTH_CODE=local-auth-code\nVITE_BACKEND_ENDPOINT_URL=https://backend.example.com\n',
      'utf8',
    );
    const env: NodeJS.ProcessEnv = {};

    loadLocalEnvFiles(cwd, env);

    expect(env.LARK_BASE_AUTH_CODE).toBe('local-auth-code');
    expect(env.WARMUP_SECRET).toBe('file-warmup');
    expect(env.VITE_BACKEND_ENDPOINT_URL).toBe('https://backend.example.com');
  });
});
