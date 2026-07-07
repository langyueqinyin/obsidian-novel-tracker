import { requestUrl } from "obsidian";
import { LLMProvider, LLMRequest, LLMConfig } from "./provider";

export class AnthropicProvider implements LLMProvider {
  readonly name = "Anthropic";

  constructor(private config: LLMConfig) {}

  async complete(req: LLMRequest): Promise<string> {
    const baseUrl = this.config.baseUrl || "https://api.anthropic.com";
    const body = {
      model: this.config.model,
      max_tokens: req.maxTokens ?? this.config.maxTokens,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const resp = await requestUrl({
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

    if (resp.status >= 400) {
      throw new Error(`Anthropic API 错误 ${resp.status}: ${resp.text.slice(0, 500)}`);
    }

    const data = resp.json;
    const parts = (data.content ?? []) as Array<{ type: string; text?: string }>;
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    if (!text) throw new Error("Anthropic 返回了空回复");
    return text;
  }
}
