# OpenClaw 框架开发规则指南

本文档总结了 OpenClaw 项目的框架规则和安全规则，供后续开发参考。

---

## 一、项目结构规则

### 1.1 目录结构

```
src/
├── agents/           # AI Agent 核心逻辑
│   ├── auth-profiles/   # 认证配置系统
│   ├── tools/           # Agent 工具
│   └── pi-embedded-*/   # Pi Agent 运行时
├── channels/         # 消息渠道抽象层
├── config/           # 配置加载和类型定义
├── gateway/          # Gateway 服务器
├── infra/            # 基础设施（存储、网络等）
├── logging/          # 日志系统
├── security/         # 安全审计和修复
├── providers/        # 第三方服务集成（OAuth等）
└── [channel-name]/   # 具体渠道实现（telegram, discord, slack等）

extensions/           # 渠道扩展插件
apps/                 # 原生应用（macOS, iOS, Android）
ui/                   # 前端界面
```

### 1.2 文件命名规则

- 使用 `kebab-case` 命名文件：`model-auth.ts`, `auth-profiles.ts`
- 测试文件使用 `.test.ts` 后缀：`model-auth.test.ts`
- 类型定义文件使用 `types.` 前缀：`types.models.ts`, `types.plugin.ts`

---

## 二、模型提供商添加规则

### 2.1 添加新提供商的步骤

1. **定义常量** (`src/agents/models-config.providers.ts`)
```typescript
// 1. Base URL
const NEW_PROVIDER_BASE_URL = "https://api.provider.com/v1";

// 2. 默认参数
const NEW_PROVIDER_DEFAULT_MAX_TOKENS = 8192;

// 3. 定价（USD per million tokens）
const NEW_PROVIDER_COST = {
  input: 0.10,
  output: 0.30,
  cacheRead: 0.05,
  cacheWrite: 0.08,
};
```

2. **创建 Provider 构建函数**
```typescript
function buildNewProvider(): ProviderConfig {
  return {
    baseUrl: NEW_PROVIDER_BASE_URL,
    api: "openai-completions",  // 或 "anthropic-messages"
    models: [
      {
        id: "model-id",
        name: "Model Display Name",
        reasoning: false,          // 是否支持推理
        input: ["text"],           // 或 ["text", "image"]
        cost: NEW_PROVIDER_COST,
        contextWindow: 128000,
        maxTokens: NEW_PROVIDER_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
```

3. **在 `resolveImplicitProviders()` 中注册**
```typescript
const newProviderKey =
  resolveEnvApiKeyVarName("new-provider") ??
  resolveApiKeyFromProfiles({ provider: "new-provider", store: authStore });
if (newProviderKey) {
  providers["new-provider"] = { ...buildNewProvider(), apiKey: newProviderKey };
}
```

4. **添加环境变量支持** (`src/agents/model-auth.ts`)
```typescript
if (normalized === "new-provider") {
  return pick("NEW_PROVIDER_API_KEY") ?? pick("ALTERNATIVE_API_KEY");
}
```

### 2.2 API 类型选择

| API 类型 | 适用场景 |
|---------|---------|
| `openai-completions` | OpenAI 兼容 API（大多数国内厂商） |
| `anthropic-messages` | Anthropic 兼容 API |
| `google-generative-ai` | Google Gemini |
| `bedrock-converse-stream` | AWS Bedrock |
| `github-copilot` | GitHub Copilot |

### 2.3 模型定义规范

```typescript
type ModelDefinitionConfig = {
  id: string;           // 模型 ID（API 调用时使用）
  name: string;         // 显示名称
  reasoning: boolean;   // 是否支持推理/思考
  input: ("text" | "image")[];  // 支持的输入类型
  cost: {
    input: number;      // 输入 token 价格（USD/百万）
    output: number;     // 输出 token 价格
    cacheRead: number;  // 缓存读取价格
    cacheWrite: number; // 缓存写入价格
  };
  contextWindow: number;  // 上下文窗口大小
  maxTokens: number;      // 最大输出 token
};
```

---

## 三、安全规则

### 3.1 文件权限

**必须遵守的权限设置：**

| 资源类型 | 权限 | 说明 |
|---------|------|------|
| 配置目录 | `0o700` | 仅所有者可访问 |
| 敏感配置文件 | `0o600` | 仅所有者可读写 |
| 凭据文件 | `0o600` | 仅所有者可读写 |

**实现方式：**
```typescript
// src/infra/json-file.ts
export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(pathname, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.chmodSync(pathname, 0o600);  // 关键：设置文件权限
}
```

### 3.2 敏感文件列表

以下文件必须使用 `0o600` 权限：
- `auth-profiles.json` - 认证凭据
- `sessions.json` - 会话数据
- `openclaw.json` - 主配置（可能包含 API Key）
- `models.json` - 模型配置
- `credentials/*.json` - OAuth 凭据

### 3.3 日志脱敏

**必须脱敏的模式：**
```typescript
// src/logging/redact.ts
const DEFAULT_REDACT_PATTERNS = [
  // 环境变量
  `[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\\s*[=:]\\s*([^\\s]+)`,
  // JSON 字段
  `"(apiKey|token|secret|password)"\\s*:\\s*"([^"]+)"`,
  // Authorization 头
  `Authorization\\s*[:=]\\s*Bearer\\s+([A-Za-z0-9._\\-+=]+)`,
  // 常见 Token 前缀
  `sk-[A-Za-z0-9_-]{8,}`,      // OpenAI
  `ghp_[A-Za-z0-9]{20,}`,      // GitHub
  `xox[baprs]-[A-Za-z0-9-]+`,  // Slack
];
```

**脱敏函数使用：**
```typescript
import { redactSensitiveText } from "../logging/redact.js";

// 在日志中使用
log.info("Request", { data: redactSensitiveText(sensitiveData) });
```

### 3.4 存储位置隔离

**敏感数据必须存储在用户主目录：**
```
~/.openclaw/                    # 用户配置目录（不在项目仓库内）
├── openclaw.json              # 主配置
├── auth-profiles.json         # 认证凭据
├── models.json                # 模型配置
└── credentials/               # OAuth 凭据
```

**禁止在项目目录存储敏感信息**

### 3.5 .gitignore 规则

以下文件必须在 `.gitignore` 中：
```gitignore
.env
*.key
*.pem
auth-profiles.json
credentials/
```

### 3.6 文件锁

**并发写入敏感文件时必须使用文件锁：**
```typescript
import lockfile from "proper-lockfile";

export async function updateWithLock(params: {
  updater: (store: Store) => boolean;
}): Promise<Store | null> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(filePath, LOCK_OPTIONS);
    // ... 更新操作
  } finally {
    if (release) await release();
  }
}
```

---

## 四、配置系统规则

### 4.1 配置类型定义

配置类型定义在 `src/config/types.*.ts`：
```typescript
// src/config/types.models.ts
export type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  auth?: "api-key" | "aws-sdk" | "oauth" | "token";
  api?: ModelApi;
  models: ModelDefinitionConfig[];
};
```

### 4.2 环境变量命名规则

```
{PROVIDER}_API_KEY     # 主要 API Key
{PROVIDER}_OAUTH_TOKEN # OAuth Token
```

示例：
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `DASHSCOPE_API_KEY`
- `ARK_API_KEY` (Volcengine)

### 4.3 配置优先级

1. 命令行参数
2. 环境变量
3. Auth Profiles (`~/.openclaw/auth-profiles.json`)
4. 配置文件 (`~/.openclaw/openclaw.json`)
5. 默认值

---

## 五、代码风格规则

### 5.1 TypeScript 规范

- 使用 TypeScript 严格模式
- 优先使用 `type` 而非 `interface`
- 导出类型时使用 `export type`

### 5.2 导入规则

```typescript
// 1. Node.js 内置模块
import fs from "node:fs";
import path from "node:path";

// 2. 第三方模块
import lockfile from "proper-lockfile";

// 3. 内部模块（使用 .js 扩展名）
import { loadConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
```

### 5.3 错误处理

```typescript
// 使用 try-catch 并提供有意义的错误信息
try {
  // ...
} catch (err) {
  throw new Error(`Failed to load provider "${provider}": ${String(err)}`);
}
```

### 5.4 日志规范

```typescript
import { log } from "./constants.js";

log.info("Operation succeeded", { key: value });
log.warn("Warning message", { error: err });
log.error("Error occurred", { error: err, context: ctx });
```

---

## 六、测试规则

### 6.1 测试文件位置

测试文件与源文件放在同一目录：
```
src/agents/
├── model-auth.ts
├── model-auth.test.ts
```

### 6.2 测试命名

```typescript
// 使用 describe 和 it 描述功能
describe("resolveEnvApiKey", () => {
  it("returns API key from environment variable", () => {
    // ...
  });
});
```

### 6.3 运行测试

```bash
pnpm test              # 运行所有测试
pnpm test:watch        # 监听模式
pnpm test:coverage     # 覆盖率报告
```

---

## 七、提交规范

### 7.1 Commit Message 格式

```
<type>(<scope>): <description>

<body>
```

**Type 类型：**
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档
- `refactor`: 重构
- `test`: 测试
- `chore`: 构建/工具

**示例：**
```
feat(volcengine): add doubao-seed-1-8-251228 as default model

Add the latest Doubao Seed 1.8 flagship model as the first/default
model for the Volcengine provider.
```

---

## 八、快速检查清单

添加新模型提供商时：

- [ ] 在 `models-config.providers.ts` 中定义常量和构建函数
- [ ] 在 `resolveImplicitProviders()` 中注册提供商
- [ ] 在 `model-auth.ts` 中添加环境变量支持
- [ ] 确保使用 `saveJsonFile()` 保存敏感配置
- [ ] 敏感信息在日志中已脱敏
- [ ] 添加相应的测试
- [ ] 更新文档（如需要）

---

*最后更新: 2026-02-01*
