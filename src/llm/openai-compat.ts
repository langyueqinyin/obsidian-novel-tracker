import { requestUrl } from "obsidian";
import { LLMProvider, LLMRequest, LLMConfig, UsageCallback, withRetry } from "./provider";

/** 兼容 OpenAI / DeepSeek / Moonshot / 通义等一切 chat/completions 格式端点 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "OpenAI 兼容";

  constructor(private config: LLMConfig, private onUsage?: UsageCallback) {}

  async complete(req: LLMRequest): Promise<string> {
    const baseUrl = this.config.baseUrl || "https://api.openai.com/v1";
    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: req.maxTokens ?? this.config.maxTokens,
      messages: [
        { role: "system", content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };
    if (req.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const resp = await withRetry(async () => {
      const r = await requestUrl({
        url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        throw: false,
      });
      if (r.status >= 400) {
        throw new Error(`API 错误 ${r.status}: ${r.text.slice(0, 500)}`);
      }
      return r;
    });

    const data = resp.json;
    if (data.usage) {
      this.onUsage?.({
        input: data.usage.prompt_tokens ?? 0,
        output: data.usage.completion_tokens ?? 0,
      });
    }
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("模型返回了空回复");
    return text;
  }
}
