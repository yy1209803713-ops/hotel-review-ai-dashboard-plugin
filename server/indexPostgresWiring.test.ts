import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('server analysis store wiring', () => {
  it('uses the Postgres-backed analysis store in the runtime server entrypoint', () => {
    const source = readFileSync('server/index.ts', 'utf8');

    expect(source).toContain("import { createPostgresAnalysisBackendStore } from './postgresAnalysisStore';");
    expect(source).toContain('const backendAnalysisStore = createPostgresAnalysisBackendStore(postgresPool);');
    expect(source).not.toContain('createInMemoryAnalysisBackendStore');
  });
});
