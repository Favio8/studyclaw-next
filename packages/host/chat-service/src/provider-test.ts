/**
 * 模型连通测试（PRD G2）：用户明确发起的一次真实生成请求。
 *
 * 「获取模型列表成功」不等于生成可用——这里必须真的让模型产出一小段文本，
 * 才能作为「配置已保存且一次明确发起的连通测试成功」的完成证据。
 * @module @studyclaw/chat-service/src/provider-test
 */
import { createDeepSeekToolClient } from './adapter.ts';

export interface ProviderTestResult {
  readonly ok: boolean;
  readonly providerId: string;
  readonly model: string;
  readonly latencyMs: number;
  /** 失败原因（已脱敏）；成功时为简短回显。 */
  readonly message: string;
}

/** Redact anything that looks like a credential before the reason reaches the UI. */
function redact(message: string): string {
  return message
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .slice(0, 300);
}

export async function testProviderConnection(
  config: import('./config.ts').ResolvedChatConfig,
): Promise<ProviderTestResult> {
  const started = Date.now();
  const providerId = config.providerId || 'studyclaw';
  const model = config.model;
  if (config.baseUrl === '' || model === '') {
    return { ok: false, providerId, model, latencyMs: 0, message: '供应商 Base URL 或默认模型为空，请先补全配置' };
  }
  const client = createDeepSeekToolClient({ ...config, maxTokens: 2_048 });
  let reply = '';
  try {
    for await (const chunk of client.request(
      '你是连通性测试端点。只回复用户要求的那一个词，不要任何其他内容。',
      [{ role: 'user', content: '请只回复：连接成功' }],
      null,
      AbortSignal.timeout(30_000),
    )) {
      if (chunk.kind === 'text') reply += chunk.delta;
    }
  } catch (error) {
    return {
      ok: false,
      providerId,
      model,
      latencyMs: Date.now() - started,
      message: redact(error instanceof Error ? error.message : String(error)),
    };
  }
  const trimmed = reply.trim();
  if (trimmed === '') {
    return { ok: false, providerId, model, latencyMs: Date.now() - started, message: '端点返回空响应，未产生任何文本' };
  }
  return { ok: true, providerId, model, latencyMs: Date.now() - started, message: trimmed.slice(0, 60) };
}
