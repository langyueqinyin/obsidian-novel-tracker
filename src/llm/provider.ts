export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** 若提供，会指示模型输出纯 JSON（provider 各自实现约束方式） */
  jsonMode?: boolean;
}

export interface LLMUsage {
  input: number;
  output: number;
}

export type UsageCallback = (usage: LLMUsage) => void;

export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<string>;
}

export interface LLMConfig {
  provider: "anthropic" | "openai-compat";
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 对限流(429)/服务端错误(5xx，含 529 Overloaded)/网络故障自动重试。
 * 指数退避 + 抖动，最多 4 次尝试。服务器过载时单次重试往往还撞在高峰上，
 * 所以给够次数和间隔（约 2s → 4s → 8s）。
 */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error)?.message ?? e);
      const retriable = /\b(429|5\d\d)\b|overloaded|timeout|network|fetch|socket|ECONN|ETIMEDOUT/i.test(msg);
      if (!retriable || attempt === maxAttempts) throw e;
      // 2^attempt 秒 + 0-1s 抖动
      await sleep(Math.pow(2, attempt) * 1000 + Math.random() * 1000);
    }
  }
  throw lastErr;
}

/** 从模型回复中提取 JSON（容忍 markdown 代码块包裹和前后闲话） */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("模型回复中找不到 JSON");
  // 从第一个括号开始，按括号配平截取
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1));
      }
    }
  }
  throw new Error("JSON 括号不配平，模型输出可能被截断（可在设置里调大 max_tokens）");
}
