import { requestUrl } from "obsidian";
import { LLMProvider, LLMRequest, LLMConfig, UsageCallback, withRetry } from "./provider";

export class AnthropicProvider implements LLMProvider {
  readonly name = "Anthropic";

  constructor(private config: LLMConfig, private onUsage?: UsageCallback) {}

  async complete(req: LLMRequest): Promise<string> {
    const baseUrl = this.config.baseUrl || "https://api.anthropic.com";
    const body = {
      model: this.config.model,
      max_tokens: req.maxTokens ?? this.config.maxTokens,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const resp = await withRetry(async () => {
      const r = await requestUrl({
        url: `${baseUrl.replace(/\/$/, "")}/v1/messages`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        throw: false,
      });
      if (r.status >= 400) {
        throw new Error(`Anthropic API 错误 ${r.status}: ${r.text.slice(0, 500)}`);
      }
      return r;
    });

    const data = resp.json;
    if (data.usage) {
      this.onUsage?.({
        input: data.usage.input_tokens ?? 0,
        output: data.usage.output_tokens ?? 0,
      });
    }
    const parts = (data.content ?? []) as Array<{ type: string; text?: string }>;
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    if (!text) throw new Error("Anthropic 返回了空回复");
    return text;
  }
}
