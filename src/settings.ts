import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type NovelTrackerPlugin from "./main";
import { LLMConfig } from "./llm";

import type { StoredThread } from "./ui/chat-view";

export interface NovelTrackerSettings {
  llm: LLMConfig;
  /** 对话面板的聊天串（按文件路径/项目 key 持久化，最多保留最近 30 串） */
  chatThreads: Record<string, StoredThread>;
  /** 一致性检查里作者点过「忽略」的条目，按项目根路径分组，检查时告知模型不要再报 */
  consistencyIgnores: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: NovelTrackerSettings = {
  llm: {
    provider: "anthropic",
    apiKey: "",
    baseUrl: "",
    model: "claude-sonnet-5",
    maxTokens: 8192,
  },
  chatThreads: {},
  consistencyIgnores: {},
};

export class NovelTrackerSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NovelTrackerPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("模型服务").setHeading();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Anthropic 原生，或任意 OpenAI 兼容端点（OpenAI / DeepSeek / Moonshot / 通义等）")
      .addDropdown((dd) =>
        dd
          .addOption("anthropic", "Anthropic")
          .addOption("openai-compat", "OpenAI 兼容")
          .setValue(this.plugin.settings.llm.provider)
          .onChange(async (v) => {
            this.plugin.settings.llm.provider = v as LLMConfig["provider"];
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("API Key")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-...")
          .setValue(this.plugin.settings.llm.apiKey)
          .onChange(async (v) => {
            this.plugin.settings.llm.apiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    const isAnthropic = this.plugin.settings.llm.provider === "anthropic";
    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(
        isAnthropic
          ? "留空使用官方 https://api.anthropic.com"
          : "如 https://api.deepseek.com/v1，留空使用 https://api.openai.com/v1"
      )
      .addText((t) =>
        t
          .setPlaceholder(isAnthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1")
          .setValue(this.plugin.settings.llm.baseUrl)
          .onChange(async (v) => {
            this.plugin.settings.llm.baseUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("模型名")
      .setDesc(isAnthropic ? "如 claude-sonnet-5、claude-haiku-4-5-20251001" : "如 gpt-4o、deepseek-chat")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.llm.model)
          .onChange(async (v) => {
            this.plugin.settings.llm.model = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("单次回复上限 (max_tokens)")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.llm.maxTokens))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.llm.maxTokens = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("连接测试")
      .setDesc("发送一条极短消息验证配置")
      .addButton((b) =>
        b.setButtonText("测试").onClick(async () => {
          b.setDisabled(true).setButtonText("测试中…");
          try {
            const provider = this.plugin.llm();
            const reply = await provider.complete({
              system: "你是连接测试器。只回复「连接成功」四个字。",
              messages: [{ role: "user", content: "测试" }],
              maxTokens: 20,
            });
            new Notice(`✓ ${provider.name}: ${reply.slice(0, 50)}`);
          } catch (e) {
            new Notice(`连接失败: ${(e as Error).message}`, 8000);
          } finally {
            b.setDisabled(false).setButtonText("测试");
          }
        })
      );
  }
}
