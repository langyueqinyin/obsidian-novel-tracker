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

/**
 * 对限流(429)/服务端错误(5xx)/网络故障自动重试一次。
 * 批量 Track 连跑几十章时，单次网络抖动不该废掉一整章。
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const retriable = /\b(429|5\d\d)\b|timeout|network|fetch|socket|ECONN|ETIMEDOUT/i.test(msg);
    if (!retriable) throw e;
    await new Promise((r) => setTimeout(r, 2500));
    return fn();
  }
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
