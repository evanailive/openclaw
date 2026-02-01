import {
  buildChannelConfigSchema,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import {
  listFeishuAccountIds,
  resolveFeishuAccount,
  resolveDefaultFeishuAccountId,
  FeishuConfigSchema,
  type ResolvedFeishuAccount,
} from "./config.js";
import {
  sendFeishuTextMessage,
  type FeishuCredentials,
  type FeishuEvent,
  decryptEventContent,
} from "./api.js";

const DEFAULT_ACCOUNT_ID = "default";

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount> = {
  id: "feishu",

  meta: {
    id: "feishu",
    label: "Feishu (飞书)",
    selectionLabel: "飞书/Lark",
    docsPath: "/channels/feishu",
    blurb: "Connect to Feishu/Lark messaging platform",
    order: 50,
    aliases: ["lark"],
    quickstartAllowFrom: true,
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: true,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },

  reload: { configPrefixes: ["channels.feishu"] },
  configSchema: buildChannelConfigSchema(FeishuConfigSchema),

  config: {
    listAccountIds: (cfg) => listFeishuAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFeishuAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFeishuAccountId(cfg),

    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
      const feishuCfg = (cfg.channels?.feishu ?? {}) as Record<string, unknown>;

      if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            feishu: {
              ...feishuCfg,
              enabled,
            },
          },
        };
      }

      const accounts = (feishuCfg.accounts ?? {}) as Record<string, unknown>;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          feishu: {
            ...feishuCfg,
            accounts: {
              ...accounts,
              [resolvedAccountId]: {
                ...(accounts[resolvedAccountId] as Record<string, unknown> | undefined),
                enabled,
              },
            },
          },
        },
      };
    },

    deleteAccount: ({ cfg, accountId }) => {
      const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
      const feishuCfg = (cfg.channels?.feishu ?? {}) as Record<string, unknown>;

      if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
        const { appId, appSecret, encryptKey, verificationToken, name, ...rest } = feishuCfg;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            feishu: rest,
          },
        };
      }

      const accounts = { ...(feishuCfg.accounts as Record<string, unknown> | undefined) };
      delete accounts[resolvedAccountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          feishu: {
            ...feishuCfg,
            accounts,
          },
        },
      };
    },

    isConfigured: (account) => Boolean(account.appId?.trim() && account.appSecret?.trim()),

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId?.trim() && account.appSecret?.trim()),
    }),

    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveFeishuAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),

    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^feishu:/i, ""))
        .map((entry) => entry.toLowerCase()),
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg.channels?.feishu as Record<string, unknown> | undefined)?.accounts?.[
          resolvedAccountId as keyof typeof cfg.channels.feishu
        ],
      );
      const basePath = useAccountPath
        ? `channels.feishu.accounts.${resolvedAccountId}.`
        : "channels.feishu.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: `Use "openclaw allow feishu:<user_id>" to approve`,
        normalizeEntry: (raw: string) => raw.replace(/^feishu:/i, ""),
      };
    },
  },

  status: {
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.appId?.trim() && account.appSecret?.trim()),
      running: runtime?.running ?? false,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, runtime: runtimeEnv, log } = ctx;

      if (!account.appId || !account.appSecret) {
        log?.warn?.("Feishu account not configured (missing appId or appSecret)");
        return;
      }

      const httpRuntime = getFeishuRuntime().plugins.http;
      if (!httpRuntime) {
        log?.warn?.("HTTP plugin not available");
        return;
      }

      const webhookPath = `/webhook/feishu/${account.accountId}`;

      // 注册 webhook 处理器
      httpRuntime.registerHttpHandler({
        method: "POST",
        path: webhookPath,
        handler: async (req, res) => {
          try {
            const body = await parseRequestBody(req);
            const event = JSON.parse(body) as FeishuEvent;

            // URL 验证请求
            if (event.type === "url_verification" && event.challenge) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ challenge: event.challenge }));
              return;
            }

            // 解密事件（如果需要）
            let eventData = event;
            if ((event as { encrypt?: string }).encrypt && account.encryptKey) {
              const decrypted = decryptEventContent({
                encrypt: (event as { encrypt: string }).encrypt,
                encryptKey: account.encryptKey,
              });
              eventData = JSON.parse(decrypted) as FeishuEvent;
            }

            // 处理消息事件
            if (eventData.header?.event_type === "im.message.receive_v1") {
              await handleMessageEvent(eventData, account, ctx);
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ code: 0 }));
          } catch (error) {
            log?.error?.("Error handling Feishu webhook", { error });
            res.writeHead(500);
            res.end("Internal Server Error");
          }
        },
      });

      log?.info?.(`Feishu webhook registered at ${webhookPath}`);
      ctx.setStatus({
        accountId: account.accountId,
        enabled: true,
        configured: true,
        running: true,
      });
    },

    stopAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.account.accountId,
        enabled: ctx.account.enabled,
        configured: Boolean(ctx.account.appId && ctx.account.appSecret),
        running: false,
      });
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 4000,

    chunker: (text, limit) => {
      // 简单的文本分块
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > 0) {
        if (remaining.length <= limit) {
          chunks.push(remaining);
          break;
        }
        // 尝试在换行符处分割
        let splitAt = remaining.lastIndexOf("\n", limit);
        if (splitAt <= 0) {
          splitAt = limit;
        }
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).trimStart();
      }
      return chunks;
    },

    resolveTarget: ({ to }) => {
      if (!to?.trim()) {
        return { ok: false, error: new Error("Missing target") };
      }
      // 飞书 ID 格式: open_id (ou_xxx), chat_id (oc_xxx)
      const trimmed = to.trim();
      if (trimmed.startsWith("ou_") || trimmed.startsWith("oc_")) {
        return { ok: true, to: trimmed };
      }
      return { ok: false, error: new Error(`Invalid Feishu target: ${to}`) };
    },

    sendText: async ({ to, text, accountId, deps }) => {
      const cfg = deps.getConfig();
      const account = resolveFeishuAccount({ cfg, accountId });

      if (!account.appId || !account.appSecret) {
        throw new Error("Feishu account not configured");
      }

      const credentials: FeishuCredentials = {
        appId: account.appId,
        appSecret: account.appSecret,
      };

      const result = await sendFeishuTextMessage({
        to,
        text,
        credentials,
      });

      return {
        channel: "feishu",
        messageId: result.messageId,
        to,
      };
    },

    sendMedia: async ({ to, text, mediaUrl, accountId, deps }) => {
      // 目前简化处理：发送带媒体链接的文本
      const cfg = deps.getConfig();
      const account = resolveFeishuAccount({ cfg, accountId });

      if (!account.appId || !account.appSecret) {
        throw new Error("Feishu account not configured");
      }

      const credentials: FeishuCredentials = {
        appId: account.appId,
        appSecret: account.appSecret,
      };

      const messageText = text ? `${text}\n\n${mediaUrl}` : mediaUrl ?? "";

      const result = await sendFeishuTextMessage({
        to,
        text: messageText,
        credentials,
      });

      return {
        channel: "feishu",
        messageId: result.messageId,
        to,
      };
    },
  },
};

// 辅助函数

async function parseRequestBody(req: { on: Function }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleMessageEvent(
  event: FeishuEvent,
  account: ResolvedFeishuAccount,
  ctx: { log?: { info?: Function; error?: Function } },
): Promise<void> {
  const message = event.event?.message;
  const sender = event.event?.sender;

  if (!message || !sender) {
    return;
  }

  const senderId = sender.sender_id?.open_id;
  const chatId = message.chat_id;
  const messageType = message.message_type;
  const content = message.content;

  if (!senderId || !content) {
    return;
  }

  ctx.log?.info?.("Received Feishu message", {
    senderId,
    chatId,
    messageType,
  });

  // TODO: 将消息传递给 OpenClaw 核心处理
  // 这需要调用 runtime 的消息处理函数
  // getFeishuRuntime().channel.handleIncomingMessage(...)
}
