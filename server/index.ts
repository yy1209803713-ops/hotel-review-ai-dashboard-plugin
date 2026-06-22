import * as http from 'node:http';
import { AnalysisBackendService, createConfiguredReviewSources, createInMemoryAnalysisBackendStore } from './backendAnalysis';
import { handleBackendAnalysisRequest } from './backendAnalysisHandler';
import { AnalysisJobWorker, type AnalysisRunner } from './analysisWorker';
import { createFeishuBaseSummaryExporterFactory } from './baseSummaryExporter';
import { loadLocalEnvFiles } from './env';
import { createFeishuBaseReviewSourceFactory } from './reviewSourceRuntime';
import { handleWarmupRequest } from './warmupHandler';
import type { ReviewRecord, ReviewSource } from './reviewSource';

loadLocalEnvFiles();

const port = Number(process.env.WARMUP_PORT || 8787);
const warmupSecret = process.env.WARMUP_SECRET || 'local-warmup-secret';
const backendAnalysisStore = createInMemoryAnalysisBackendStore();
const feishuBaseReviewSource = createFeishuBaseReviewSourceFactory();
const reviewSources = createConfiguredReviewSources({
  feishuBase: feishuBaseReviewSource,
});
const backendAnalysisService = new AnalysisBackendService({
  store: backendAnalysisStore,
  reviewSources,
  baseSummaryExporter: createFeishuBaseSummaryExporterFactory(),
});
const backendAnalysisWorker = new AnalysisJobWorker({
  service: backendAnalysisService,
  store: backendAnalysisStore,
  reviewSources: {
    feishu_base: feishuBaseReviewSource as ReviewSource,
  },
  runner: createLocalAnalysisRunner(),
});
const analysisJobQueue = createSerialJobQueue((jobId) => backendAnalysisWorker.runAnalysisJob(jobId));

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
    return handleWarmupRequest(request, { warmupSecret });
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

function createLocalAnalysisRunner(): AnalysisRunner {
  return {
    async run({ reviews, jobId }) {
      const totalReviews = reviews.length;
      const evidence = reviews.slice(0, 20).map((review, index) => ({
        evidenceId: `${jobId}-evidence-${index + 1}`,
        recordId: review.recordId,
        quote: getReviewContent(review).slice(0, 240),
        sentiment: 'positive',
      }));
      const topic = {
        mergeKey: 'backend-summary',
        topic: '评论摘要',
        displayTopic: '评论摘要',
        category: '综合',
        count: totalReviews,
        sentiment: 'positive',
        commentRecordIds: reviews.map((review) => review.recordId),
        evidencePhrases: evidence.map((item) => item.quote).filter(Boolean).slice(0, 5),
        summary: '后端已读取当前范围评论并生成分析快照。',
      };

      return {
        summary: {
          analysisId: jobId,
          generatedAt: new Date().toISOString(),
          model: 'backend-local-runner',
          status: 'complete',
          scope: {
            hotelName: 'all',
            periodType: 'custom',
            startDate: '',
            endDate: '',
          },
          overview: {
            totalReviews,
            positiveReviews: totalReviews,
            negativeOrRiskReviews: 0,
            mixedReviews: 0,
            neutralReviews: 0,
            averageScore: null,
            replyRate: 0,
          },
          positiveTopics: totalReviews ? [topic] : [],
          negativeTopics: [],
          actionItems: [],
        },
        topics: totalReviews ? [topic] : [],
        evidenceByTopic: {
          'backend-summary': evidence,
        },
      };
    },
  };
}

function getReviewContent(review: ReviewRecord): string {
  const value = review.content ?? review.mappedFields.content ?? review.mappedFields.reviewText;
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}
