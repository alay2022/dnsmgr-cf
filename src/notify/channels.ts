export interface NotifyMessage {
  title: string;
  content: string; // 支持简单文本，部分渠道支持markdown
}

export type NotifyChannelType =
  | "email"
  | "wechat_mp"
  | "telegram"
  | "dingtalk"
  | "feishu"
  | "wecom"
  | "serverchan";

/**
 * 各渠道 config 字段约定：
 * - email:      { provider: 'resend'|'smtp_relay', apiKey?: string, from?: string, to: string }
 *               （Workers 无法直接发 SMTP，推荐通过 Resend/MailChannels 等 HTTP API 网关发送）
 * - wechat_mp:  { appId, appSecret, templateId, toOpenId }
 * - telegram:   { botToken, chatId }
 * - dingtalk:   { webhookUrl, secret? }
 * - feishu:     { webhookUrl }
 * - wecom:      { webhookUrl }
 * - serverchan: { sendKey }
 */
export async function sendNotify(type: NotifyChannelType, config: Record<string, any>, msg: NotifyMessage): Promise<void> {
  switch (type) {
    case "email":
      return sendEmail(config, msg);
    case "wechat_mp":
      return sendWechatMp(config, msg);
    case "telegram":
      return sendTelegram(config, msg);
    case "dingtalk":
      return sendDingtalk(config, msg);
    case "feishu":
      return sendFeishu(config, msg);
    case "wecom":
      return sendWecom(config, msg);
    case "serverchan":
      return sendServerChan(config, msg);
    default:
      throw new Error(`不支持的通知渠道: ${type}`);
  }
}

async function sendEmail(config: any, msg: NotifyMessage) {
  // 使用 Resend HTTP API 作为默认邮件网关（Workers 环境下最简单可靠的方案之一）
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.from || "DNSMGR <notify@yourdomain.com>",
      to: [config.to],
      subject: msg.title,
      text: msg.content,
    }),
  });
  if (!res.ok) throw new Error(`邮件发送失败: ${await res.text()}`);
}

async function sendWechatMp(config: any, msg: NotifyMessage) {
  const tokenRes = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.appId}&secret=${config.appSecret}`
  );
  const tokenData = (await tokenRes.json()) as any;
  if (!tokenData.access_token) throw new Error(`获取微信access_token失败: ${JSON.stringify(tokenData)}`);

  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${tokenData.access_token}`,
    {
      method: "POST",
      body: JSON.stringify({
        touser: config.toOpenId,
        template_id: config.templateId,
        data: {
          title: { value: msg.title },
          content: { value: msg.content },
        },
      }),
    }
  );
  const data = (await res.json()) as any;
  if (data.errcode !== 0) throw new Error(`微信公众号推送失败: ${JSON.stringify(data)}`);
}

async function sendTelegram(config: any, msg: NotifyMessage) {
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: `*${msg.title}*\n${msg.content}`,
      parse_mode: "Markdown",
    }),
  });
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`Telegram推送失败: ${JSON.stringify(data)}`);
}

async function sendDingtalk(config: any, msg: NotifyMessage) {
  let url = config.webhookUrl;
  if (config.secret) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${config.secret}`;
    const { hmacSignBase64 } = await import("../utils/crypto");
    const sign = encodeURIComponent(await hmacSignBase64(stringToSign, config.secret, "SHA-256"));
    url = `${config.webhookUrl}&timestamp=${timestamp}&sign=${sign}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { title: msg.title, text: `### ${msg.title}\n${msg.content}` },
    }),
  });
  const data = (await res.json()) as any;
  if (data.errcode !== 0) throw new Error(`钉钉推送失败: ${JSON.stringify(data)}`);
}

async function sendFeishu(config: any, msg: NotifyMessage) {
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg_type: "text",
      content: { text: `${msg.title}\n${msg.content}` },
    }),
  });
  const data = (await res.json()) as any;
  if (data.code !== 0) throw new Error(`飞书推送失败: ${JSON.stringify(data)}`);
}

async function sendWecom(config: any, msg: NotifyMessage) {
  const res = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content: `**${msg.title}**\n${msg.content}` },
    }),
  });
  const data = (await res.json()) as any;
  if (data.errcode !== 0) throw new Error(`企业微信推送失败: ${JSON.stringify(data)}`);
}

async function sendServerChan(config: any, msg: NotifyMessage) {
  const res = await fetch(`https://sctapi.ftqq.com/${config.sendKey}.send`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ title: msg.title, desp: msg.content }).toString(),
  });
  const data = (await res.json()) as any;
  if (data.code !== 0) throw new Error(`Server酱推送失败: ${JSON.stringify(data)}`);
}
