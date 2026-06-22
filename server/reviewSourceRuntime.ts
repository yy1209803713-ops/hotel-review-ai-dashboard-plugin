import { BackendAnalysisError } from './backendAnalysis';
import { requireFeishuBaseAuthCode, type FeishuBaseRuntimeEnv } from './feishuBaseRuntimeConfig';
import { createLarkOpenApiRuntime } from './larkOpenApiRuntime';
import { FeishuBaseReviewSource, type ReviewRecord, type ReviewSource, type ReviewSourceQuery } from './reviewSource';

export type FeishuBaseReviewSourceFactoryOptions = {
  env?: FeishuBaseRuntimeEnv;
  createRuntime?: typeof createLarkOpenApiRuntime;
};

export function createFeishuBaseReviewSourceFactory(options: FeishuBaseReviewSourceFactoryOptions = {}): ReviewSource {
  return new FeishuBaseReviewSourceFactory(options.env ?? process.env, options.createRuntime ?? createLarkOpenApiRuntime);
}

class FeishuBaseReviewSourceFactory implements ReviewSource {
  readonly kind = 'feishu_base';
  private readonly sourcesByAuthCode = new Map<string, Map<string, FeishuBaseReviewSource>>();

  constructor(
    private readonly env: FeishuBaseRuntimeEnv,
    private readonly createRuntime: typeof createLarkOpenApiRuntime,
  ) {}

  async listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]> {
    return this.createSource(query).listReviews(query);
  }

  async getSourceVersion(query: ReviewSourceQuery, reviews?: ReviewRecord[]) {
    return this.createSource(query).getSourceVersion(query, reviews);
  }

  private createSource(query: ReviewSourceQuery): FeishuBaseReviewSource {
    if (!query.baseToken?.trim()) {
      throw new BackendAnalysisError(400, 'resolve_source', 'baseToken is required for feishu_base review source');
    }
    const authCode = requireFeishuBaseAuthCode(this.env, 'resolve_source', 'feishu_base review source');
    const cacheKey = query.baseToken;
    let sources = this.sourcesByAuthCode.get(authCode);
    if (!sources) {
      sources = new Map<string, FeishuBaseReviewSource>();
      this.sourcesByAuthCode.set(authCode, sources);
    }
    let source = sources.get(cacheKey);
    if (!source) {
      source = new FeishuBaseReviewSource({
        runtime: this.createRuntime({
          baseToken: query.baseToken,
          authCode,
        }),
      });
      sources.set(cacheKey, source);
    }

    return source;
  }
}
