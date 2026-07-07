import { requestUrl } from "obsidian";
import { LLMProvider, LLMRequest, LLMConfig } from "./provider";

/** 兼容 OpenAI / DeepSeek / Moonshot / 通义等一切 chat/completions 格式端点 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name = "OpenAI 兼容";

  constructor(private config: LLMConfig) {}

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

    const resp = await requestUrl({
      url: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (resp.status >= 400) {
      throw new Error(`API 错误 ${resp.status}: ${resp.text.slice(0, 500)}`);
    }

    const data = resp.json;
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("模型返回了空回复");
    return text;
  }
}
