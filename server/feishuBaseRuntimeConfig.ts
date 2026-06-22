import { BackendAnalysisError } from './backendAnalysis';

export type FeishuBaseRuntimeEnv = {
  LARK_BASE_AUTH_CODE?: string;
};

export function requireFeishuBaseAuthCode(env: FeishuBaseRuntimeEnv, stage: string, context: string): string {
  const authCode = env.LARK_BASE_AUTH_CODE?.trim();
  if (!authCode) {
    throw new BackendAnalysisError(500, stage, `LARK_BASE_AUTH_CODE is required for ${context}`);
  }
  return authCode;
}
