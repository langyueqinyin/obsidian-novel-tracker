import { LLMConfig, LLMProvider } from "./provider";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatProvider } from "./openai-compat";

export function createProvider(config: LLMConfig): LLMProvider {
  if (!config.apiKey) {
    throw new Error("尚未配置 API key，请到插件设置里填写");
  }
  return config.provider === "anthropic"
    ? new AnthropicProvider(config)
    : new OpenAICompatProvider(config);
}

export * from "./provider";
