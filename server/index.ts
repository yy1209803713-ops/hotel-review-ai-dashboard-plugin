import * as http from 'node:http';
import { AnalysisBackendService, createConfiguredReviewSources } from './backendAnalysis';
import { handleBackendAnalysisRequest } from './backendAnalysisHandler';
import { AnalysisJobWorker } from './analysisWorker';
import { createFormalAnalysisCacheRunner } from './formalAnalysisCacheRunner';
import { createFeishuBaseSummaryExporterFactory } from './baseSummaryExporter';
import { createFacilityAnalysisBaseExporterFactory } from './facilityAnalysisBaseExporter';
import { createPostgresPool } from './db/postgres';
import { loadLocalEnvFiles } from './env';
import { handleFacilityAnalysisRequest } from './facilityAnalysisHandler';
import { createFacilityAnalysisRunner } from './facilityAnalysisRunner';
import { createPostgresAnalysisBackendStore } from './postgresAnalysisStore';
import { createPostgresAnalysisCacheRepository } from './postgresAnalysisCache';
import { createPostgresReviewSyncStore } from './postgresReviewSyncStore';
import { createPostgresFacilityAnalysisStore } from './postgresFacilityAnalysisStore';
import { createPostgresWarmupJobStore } from './warmupJobStore';
import { PostgresReviewSource } from './postgresReviewSource';
import { createFeishuBaseReviewSourceFactory } from './reviewSourceRuntime';
import { ReviewSyncService } from './reviewSync';
import { handleReviewSyncRequest } from './syncHandler';
import { createSyncWarmupFollowupQueue, type SyncWarmupOptions } from './syncWarmupFollowup';
import { replayQueuedSyncJobsOnStartup } from './startupSyncReplay';
import { handleWarmupRequest } from './warmupHandler';
import { createWarmupService, WarmupJobWorker } from './warmupJob';
import type { ReviewSource } from './reviewSource';

loadLocalEnvFiles();

const port = Number(process.env.WARMUP_PORT || 8787);
const warmupSecret = process.env.WARMUP_SECRET || 'local-warmup-secret';
const facilityAnalysisSecret = process.env.FACILITY_ANALYSIS_SECRET || warmupSecret;
const feishuBaseReviewSource = createFeishuBaseReviewSourceFactory();
const postgresPool = createPostgresPool();
const backendAnalysisStore = createPostgresAnalysisBackendStore(postgresPool);
const analysisCacheRepository = createPostgresAnalysisCacheRepository(postgresPool);
const reviewSyncStore = createPostgresReviewSyncStore(postgresPool);
const warmupJobStore = createPostgresWarmupJobStore(postgresPool);
const facilityAnalysisStore = createPostgresFacilityAnalysisStore(postgresPool);
const facilityAnalysisRunner = createFacilityAnalysisRunner({
  store: facilityAnalysisStore,
  baseExporter: createFacilityAnalysisBaseExporterFactory({ store: facilityAnalysisStore }),
});
const postgresReviewSource = new PostgresReviewSource({ store: reviewSyncStore });
const reviewSources = createConfiguredReviewSources({
  feishuBase: feishuBaseReviewSource,
  postgres: postgresReviewSource,
});
const reviewSyncService = new ReviewSyncService({
  store: reviewSyncStore,
  sourceReaders: {
    feishu_base: feishuBaseReviewSource as ReviewSource,
  },
});
const backendAnalysisService = new AnalysisBackendService({
  store: backendAnalysisStore,
  reviewSources,
  baseSummaryExporter: createFeishuBaseSummaryExporterFactory(),
});
const formalAnalysisRunner = createFormalAnalysisCacheRunner({
  cacheRepository: analysisCacheRepository,
});
const backendAnalysisWorker = new AnalysisJobWorker({
  service: backendAnalysisService,
  store: backendAnalysisStore,
  reviewSources: {
    feishu_base: feishuBaseReviewSource as ReviewSource,
    postgres: postgresReviewSource as ReviewSource,
  },
  runner: formalAnalysisRunner,
});
const warmupService = createWarmupService({
  store: warmupJobStore,
});
const warmupJobWorker = new WarmupJobWorker({
  store: warmupJobStore,
  reviewSource: postgresReviewSource as ReviewSource,
  runner: formalAnalysisRunner,
});
const analysisJobQueue = createSerialJobQueue((jobId) => backendAnalysisWorker.runAnalysisJob(jobId));
const warmupJobQueue = createSerialJobQueue((jobId) => warmupJobWorker.runWarmupJob(jobId));
const syncWarmupFollowupQueue = createSyncWarmupFollowupQueue({
  runSyncJob: (jobId) => reviewSyncService.runQueuedSyncJob(jobId),
  createWarmupJob: (input) => warmupService.createWarmupJob(input),
  enqueueWarmupJob: (jobId) => warmupJobQueue.enqueue(jobId),
});
const syncJobQueue = createSerialSyncQueue((jobId, sourceKey, warmup) =>
  syncWarmupFollowupQueue.runSyncJobWithWarmup(jobId, sourceKey, warmup),
);
await replayQueuedSyncJobsOnStartup({
  store: reviewSyncStore,
  queue: syncJobQueue,
});

const server = http.createServer((incoming, outgoing) => {
  handleNodeRequest(incoming)
    .then((request) => routeRequest(request))
    .then((response) => writeNodeResponse(outgoing, response))
    .catch((cause) => {
      console.error('__HOTEL_REVIEW_AI_WARMUP_SERVER_ERROR__', cause);
      outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'internal server error' }));
    });
});

server.listen(port, '127.0.0.1', () => {
  console.info('__HOTEL_REVIEW_AI_WARMUP_SERVER_READY__', JSON.stringify({
    url: `http://127.0.0.1:${port}/api/hotel-review-ai/warmup`,
  }));
});

async function routeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/hotel-review-ai/warmup') {
    return handleWarmupRequest(request, {
      warmupSecret,
      service: warmupService,
      onWarmupJobCreated: (jobId) => warmupJobQueue.enqueue(jobId),
    });
  }
  if (url.pathname === '/api/hotel-review-ai/facilities/analyze') {
    return handleFacilityAnalysisRequest(request, {
      secret: facilityAnalysisSecret,
      runner: facilityAnalysisRunner,
    });
  }
  if (url.pathname.startsWith('/api/hotel-review-ai/sync/')) {
    return handleReviewSyncRequest(request, {
      service: reviewSyncService,
      onSyncJobCreated: (jobId, sourceKey) => syncJobQueue.enqueue(jobId, sourceKey),
      onWarmupRequested: ({ syncJobId, sourceKey, warmup }) => syncJobQueue.attachWarmup(syncJobId, sourceKey, warmup),
    });
  }
  return handleBackendAnalysisRequest(request, {
    service: backendAnalysisService,
    onJobCreated: (jobId) => analysisJobQueue.enqueue(jobId),
  });
}

async function handleNodeRequest(incoming: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = `http://${incoming.headers.host || `127.0.0.1:${port}`}${incoming.url || '/'}`;
  return new Request(url, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body,
  });
}

async function writeNodeResponse(outgoing: http.ServerResponse, response: Response): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function createSerialJobQueue(runJob: (jobId: string) => Promise<unknown>) {
  const pendingJobIds: string[] = [];
  const pendingSet = new Set<string>();
  let running = false;

  const drain = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      while (pendingJobIds.length) {
        const jobId = pendingJobIds.shift();
        if (!jobId) {
          continue;
        }
        pendingSet.delete(jobId);
        try {
          await runJob(jobId);
        } catch (cause) {
          console.error('__HOTEL_REVIEW_AI_ANALYSIS_JOB_ERROR__', cause);
        }
      }
    } finally {
      running = false;
      if (pendingJobIds.length) {
        void drain();
      }
    }
  };

  return {
    enqueue(jobId: string): void {
      if (pendingSet.has(jobId)) {
        return;
      }
      pendingSet.add(jobId);
      pendingJobIds.push(jobId);
      void drain();
    },
  };
}

function createSerialSyncQueue(runJob: (jobId: string, sourceKey?: Parameters<typeof syncWarmupFollowupQueue.runSyncJobWithWarmup>[1], warmup?: SyncWarmupOptions) => Promise<unknown>) {
  const pendingJobs: string[] = [];
  const pendingSet = new Set<string>();
  const warmupByJobId = new Map<string, {
    sourceKey: Parameters<typeof syncWarmupFollowupQueue.runSyncJobWithWarmup>[1];
    warmup: SyncWarmupOptions;
  }>();
  let running = false;

  const drain = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      while (pendingJobs.length) {
        const jobId = pendingJobs.shift();
        if (!jobId) {
          continue;
        }
        pendingSet.delete(jobId);
        const warmup = warmupByJobId.get(jobId);
        warmupByJobId.delete(jobId);
        try {
          await runJob(jobId, warmup?.sourceKey, warmup?.warmup);
        } catch (cause) {
          console.error('__HOTEL_REVIEW_AI_SYNC_JOB_ERROR__', cause);
        }
      }
    } finally {
      running = false;
      if (pendingJobs.length) {
        void drain();
      }
    }
  };

  return {
    enqueue(jobId: string): void {
      if (pendingSet.has(jobId)) {
        return;
      }
      pendingSet.add(jobId);
      pendingJobs.push(jobId);
      void drain();
    },
    attachWarmup(jobId: string, sourceKey: Parameters<typeof syncWarmupFollowupQueue.runSyncJobWithWarmup>[1], warmup: SyncWarmupOptions): void {
      warmupByJobId.set(jobId, { sourceKey, warmup });
    },
  };
}
