import { BackendAnalysisError } from './backendAnalysis';
import { createLarkOpenApiRuntime } from './larkOpenApiRuntime';
import { FeishuBaseReviewSource, type ReviewRecord, type ReviewSource, type ReviewSourceQuery } from './reviewSource';

export type FeishuBaseRuntimeEnv = {
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
};

export type FeishuBaseReviewSourceFactoryOptions = {
  env?: FeishuBaseRuntimeEnv;
  createRuntime?: typeof createLarkOpenApiRuntime;
};

export function createFeishuBaseReviewSourceFactory(options: FeishuBaseReviewSourceFactoryOptions = {}): ReviewSource {
  return new FeishuBaseReviewSourceFactory(options.env ?? process.env, options.createRuntime ?? createLarkOpenApiRuntime);
}

class FeishuBaseReviewSourceFactory implements ReviewSource {
  readonly kind = 'feishu_base';
  private readonly sources = new Map<string, FeishuBaseReviewSource>();

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
    if (!this.env.LARK_APP_ID?.trim()) {
      throw new BackendAnalysisError(500, 'resolve_source', 'LARK_APP_ID is required for feishu_base review source');
    }
    if (!this.env.LARK_APP_SECRET?.trim()) {
      throw new BackendAnalysisError(500, 'resolve_source', 'LARK_APP_SECRET is required for feishu_base review source');
    }

    const cacheKey = `${this.env.LARK_APP_ID}:${query.baseToken}`;
    let source = this.sources.get(cacheKey);
    if (!source) {
      source = new FeishuBaseReviewSource({
        runtime: this.createRuntime({
          baseToken: query.baseToken,
          appId: this.env.LARK_APP_ID,
          appSecret: this.env.LARK_APP_SECRET,
        }),
      });
      this.sources.set(cacheKey, source);
    }

    return source;
  }
}
