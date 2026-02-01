import { z } from "zod";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

// 飞书账户配置 Schema
export const FeishuAccountSchemaBase = z
  .object({
    enabled: z.boolean().optional(),
    appId: z.string().optional(),
    appSecret: z.string().optional(),
    encryptKey: z.string().optional(),
    verificationToken: z.string().optional(),
    name: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional(),
  })
  .strict();

export const FeishuConfigSchema = FeishuAccountSchemaBase.extend({
  accounts: z.record(z.string(), FeishuAccountSchemaBase.optional()).optional(),
});

export type FeishuAccountConfig = z.infer<typeof FeishuAccountSchemaBase>;
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>;

export type ResolvedFeishuAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  encryptKey?: string;
  verificationToken?: string;
  config: FeishuAccountConfig;
};

const DEFAULT_ACCOUNT_ID = "default";

/**
 * 列出所有飞书账户 ID
 */
export function listFeishuAccountIds(cfg: OpenClawConfig): string[] {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  if (!feishuCfg) {
    return [];
  }

  const accountIds = new Set<string>();

  // 检查顶级配置
  if (feishuCfg.appId) {
    accountIds.add(DEFAULT_ACCOUNT_ID);
  }

  // 检查 accounts 子配置
  if (feishuCfg.accounts) {
    for (const accountId of Object.keys(feishuCfg.accounts)) {
      if (feishuCfg.accounts[accountId]) {
        accountIds.add(accountId);
      }
    }
  }

  return Array.from(accountIds);
}

/**
 * 解析飞书账户配置
 */
export function resolveFeishuAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const { cfg, accountId } = params;
  const resolvedAccountId = accountId?.trim() || DEFAULT_ACCOUNT_ID;
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;

  if (!feishuCfg) {
    return {
      accountId: resolvedAccountId,
      enabled: false,
      config: {},
    };
  }

  // 尝试从 accounts 子配置获取
  const accountConfig = feishuCfg.accounts?.[resolvedAccountId];

  // 合并顶级配置和账户配置
  const mergedConfig: FeishuAccountConfig = {
    ...feishuCfg,
    ...accountConfig,
  };

  // 移除 accounts 字段
  delete (mergedConfig as Record<string, unknown>).accounts;

  return {
    accountId: resolvedAccountId,
    name: mergedConfig.name,
    enabled: mergedConfig.enabled !== false,
    appId: mergedConfig.appId,
    appSecret: mergedConfig.appSecret,
    encryptKey: mergedConfig.encryptKey,
    verificationToken: mergedConfig.verificationToken,
    config: mergedConfig,
  };
}

/**
 * 获取默认账户 ID
 */
export function resolveDefaultFeishuAccountId(cfg: OpenClawConfig): string {
  const accountIds = listFeishuAccountIds(cfg);
  return accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}
