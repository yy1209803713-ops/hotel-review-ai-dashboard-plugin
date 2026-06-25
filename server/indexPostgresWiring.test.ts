import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('server analysis store wiring', () => {
  it('uses the Postgres-backed analysis store in the runtime server entrypoint', () => {
    const source = readFileSync('server/index.ts', 'utf8');

    expect(source).toContain("import { createPostgresAnalysisBackendStore } from './postgresAnalysisStore';");
    expect(source).toContain('const backendAnalysisStore = createPostgresAnalysisBackendStore(postgresPool);');
    expect(source).not.toContain('createInMemoryAnalysisBackendStore');
  });

  it('wires warmup jobs to Postgres and sync follow-up queue in the runtime server entrypoint', () => {
    const source = readFileSync('server/index.ts', 'utf8');

    expect(source).toContain("import { createPostgresWarmupJobStore } from './warmupJobStore';");
    expect(source).toContain('const warmupJobStore = createPostgresWarmupJobStore(postgresPool);');
    expect(source).toContain('const warmupService = createWarmupService({');
    expect(source).toContain('const warmupJobWorker = new WarmupJobWorker({');
    expect(source).toContain('const syncWarmupFollowupQueue = createSyncWarmupFollowupQueue({');
    expect(source).toContain('onWarmupRequested: ({ syncJobId, sourceKey, warmup }) => syncJobQueue.attachWarmup(syncJobId, sourceKey, warmup)');
    expect(source).toContain('onWarmupJobCreated: (jobId) => warmupJobQueue.enqueue(jobId)');
  });
});
