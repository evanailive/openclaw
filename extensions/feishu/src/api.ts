/**
 * 飞书开放平台 API 封装
 * 文档: https://open.feishu.cn/document/home/index
 */

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";

export type FeishuCredentials = {
  appId: string;
  appSecret: string;
};

export type FeishuAccessToken = {
  tenant_access_token: string;
  expire: number;
};

// Token 缓存
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * 获取 tenant_access_token
 */
export async function getTenantAccessToken(
  credentials: FeishuCredentials,
): Promise<string> {
  const cacheKey = `${credentials.appId}`;
  const cached = tokenCache.get(cacheKey);

  // 如果缓存有效（提前 5 分钟过期）
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }

  const response = await fetch(
    `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to get tenant access token: ${response.status}`);
  }

  const data = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };

  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu API error: ${data.msg}`);
  }

  // 缓存 token
  tokenCache.set(cacheKey, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });

  return data.tenant_access_token;
}

export type FeishuMessageType = "text" | "post" | "image" | "file" | "interactive";

export type FeishuSendMessageParams = {
  receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id";
  receiveId: string;
  msgType: FeishuMessageType;
  content: string; // JSON string
  credentials: FeishuCredentials;
  replyToMessageId?: string;
};

export type FeishuSendMessageResult = {
  messageId: string;
  chatId?: string;
};

/**
 * 发送消息
 */
export async function sendFeishuMessage(
  params: FeishuSendMessageParams,
): Promise<FeishuSendMessageResult> {
  const token = await getTenantAccessToken(params.credentials);

  const url = new URL(`${FEISHU_API_BASE}/im/v1/messages`);
  url.searchParams.set("receive_id_type", params.receiveIdType);

  const body: Record<string, unknown> = {
    receive_id: params.receiveId,
    msg_type: params.msgType,
    content: params.content,
  };

  if (params.replyToMessageId) {
    body.reply_in_thread = true;
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to send message: ${response.status}`);
  }

  const data = (await response.json()) as {
    code: number;
    msg: string;
    data?: {
      message_id?: string;
      chat_id?: string;
    };
  };

  if (data.code !== 0) {
    throw new Error(`Feishu API error: ${data.msg}`);
  }

  return {
    messageId: data.data?.message_id ?? "",
    chatId: data.data?.chat_id,
  };
}

/**
 * 发送文本消息
 */
export async function sendFeishuTextMessage(params: {
  to: string;
  text: string;
  credentials: FeishuCredentials;
  replyToMessageId?: string;
}): Promise<FeishuSendMessageResult> {
  // 判断目标类型
  const receiveIdType = params.to.startsWith("oc_") ? "chat_id" : "open_id";

  return sendFeishuMessage({
    receiveIdType,
    receiveId: params.to,
    msgType: "text",
    content: JSON.stringify({ text: params.text }),
    credentials: params.credentials,
    replyToMessageId: params.replyToMessageId,
  });
}

/**
 * 发送图片消息
 */
export async function sendFeishuImageMessage(params: {
  to: string;
  imageKey: string;
  credentials: FeishuCredentials;
}): Promise<FeishuSendMessageResult> {
  const receiveIdType = params.to.startsWith("oc_") ? "chat_id" : "open_id";

  return sendFeishuMessage({
    receiveIdType,
    receiveId: params.to,
    msgType: "image",
    content: JSON.stringify({ image_key: params.imageKey }),
    credentials: params.credentials,
  });
}

/**
 * 上传图片获取 image_key
 */
export async function uploadFeishuImage(params: {
  imageBuffer: Buffer;
  imageType: "message" | "avatar";
  credentials: FeishuCredentials;
}): Promise<string> {
  const token = await getTenantAccessToken(params.credentials);

  const formData = new FormData();
  formData.append("image_type", params.imageType);
  formData.append(
    "image",
    new Blob([params.imageBuffer]),
    "image.png",
  );

  const response = await fetch(`${FEISHU_API_BASE}/im/v1/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload image: ${response.status}`);
  }

  const data = (await response.json()) as {
    code: number;
    msg: string;
    data?: {
      image_key?: string;
    };
  };

  if (data.code !== 0 || !data.data?.image_key) {
    throw new Error(`Feishu API error: ${data.msg}`);
  }

  return data.data.image_key;
}

/**
 * 验证 webhook 请求签名
 */
export function verifyWebhookSignature(params: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  body: string;
  signature: string;
}): boolean {
  // 飞书使用 SHA256 签名验证
  // signature = sha256(timestamp + nonce + encryptKey + body)
  const crypto = require("crypto");
  const content = params.timestamp + params.nonce + params.encryptKey + params.body;
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return hash === params.signature;
}

/**
 * 解密事件内容
 */
export function decryptEventContent(params: {
  encrypt: string;
  encryptKey: string;
}): string {
  const crypto = require("crypto");
  const key = crypto.createHash("sha256").update(params.encryptKey).digest();
  const encryptedData = Buffer.from(params.encrypt, "base64");

  // AES-256-CBC 解密
  const iv = encryptedData.slice(0, 16);
  const encrypted = encryptedData.slice(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

  let decrypted = decipher.update(encrypted, undefined, "utf8");
  decrypted += decipher.final("utf8");

  // 去除随机字符串前缀（前16个字符）
  return decrypted.slice(16);
}

/**
 * 飞书事件类型
 */
export type FeishuEvent = {
  schema?: string;
  header?: {
    event_id: string;
    event_type: string;
    create_time: string;
    token: string;
    app_id: string;
    tenant_key: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      sender_type?: string;
      tenant_key?: string;
    };
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      create_time?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: Array<{
        key?: string;
        id?: {
          open_id?: string;
          user_id?: string;
          union_id?: string;
        };
        name?: string;
        tenant_key?: string;
      }>;
    };
  };
  // URL 验证请求
  challenge?: string;
  token?: string;
  type?: string;
};
