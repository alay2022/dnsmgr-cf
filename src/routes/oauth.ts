import { Hono } from "hono";
import type { Env, JwtPayload } from "../types";
import { requireAuth } from "../middleware/auth";
import { signJwt, verifyJwt } from "../utils/crypto";
import { now, insertAuditLog } from "../db";

export const oauthRoutes = new Hono<{ Bindings: Env }>();

type ProviderKey = "github" | "google" | "nodeloc";

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  clientId?: string;
  clientSecret?: string;
}

function getProviderConfig(env: Env, provider: ProviderKey): ProviderConfig | null {
  switch (provider) {
    case "github":
      if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return null;
      return {
        authorizeUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        userinfoUrl: "https://api.github.com/user",
        scope: "read:user",
        clientId: env.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      };
    case "google":
      if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) return null;
      return {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userinfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
        scope: "openid email profile",
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      };
    case "nodeloc":
      // NodeLoc 不是标准知名OAuth2服务商，具体端点请去NodeLoc自己的"开发者/应用"设置页面查看后填入
      if (
        !env.NODELOC_OAUTH_CLIENT_ID ||
        !env.NODELOC_OAUTH_CLIENT_SECRET ||
        !env.NODELOC_OAUTH_AUTHORIZE_URL ||
        !env.NODELOC_OAUTH_TOKEN_URL ||
        !env.NODELOC_OAUTH_USERINFO_URL
      )
        return null;
      return {
        authorizeUrl: env.NODELOC_OAUTH_AUTHORIZE_URL,
        tokenUrl: env.NODELOC_OAUTH_TOKEN_URL,
        userinfoUrl: env.NODELOC_OAUTH_USERINFO_URL,
        scope: env.NODELOC_OAUTH_SCOPE || "",
        clientId: env.NODELOC_OAUTH_CLIENT_ID,
        clientSecret: env.NODELOC_OAUTH_CLIENT_SECRET,
      };
    default:
      return null;
  }
}

function redirectUri(env: Env, provider: string): string {
  return `${(env.OAUTH_REDIRECT_BASE || "").replace(/\/$/, "")}/api/oauth/${provider}/callback`;
}

/** 前端用这个接口判断显示哪些「用XX登录」按钮（没配置对应Client ID/Secret的就不显示） */
oauthRoutes.get("/providers", (c) => {
  const available = (["github", "google", "nodeloc"] as ProviderKey[]).filter((p) => getProviderConfig(c.env, p));
  return c.json({ available });
});

/**
 * 跳转到第三方授权页。mode=login（登录页用，未登录状态）或 mode=link（已登录，去个人设置里绑定用）。
 * mode=link 时会把当前用户ID签进state，回调时用来关联绑定关系。
 */
oauthRoutes.get("/:provider/start", async (c) => {
  const provider = c.req.param("provider") as ProviderKey;
  const config = getProviderConfig(c.env, provider);
  if (!config) return c.text(`该登录方式未配置，请联系管理员`, 400);

  const mode = c.req.query("mode") === "link" ? "link" : "login";
  let uid: number | undefined;
  if (mode === "link") {
    const token = c.req.query("token");
    if (!token) return c.text("缺少登录态", 400);
    const payload = await verifyJwt<JwtPayload>(token, c.env.JWT_SECRET);
    if (!payload) return c.text("登录已过期", 401);
    uid = payload.uid;
  }

  const state = await signJwt(
    { mode, uid, nonce: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 },
    c.env.JWT_SECRET
  );

  const qs = new URLSearchParams({
    client_id: config.clientId!,
    redirect_uri: redirectUri(c.env, provider),
    scope: config.scope,
    state,
    response_type: "code",
  });
  return c.redirect(`${config.authorizeUrl}?${qs.toString()}`);
});

/** 第三方授权完成后跳回这里，交换token、拉用户信息，登录或绑定 */
oauthRoutes.get("/:provider/callback", async (c) => {
  const provider = c.req.param("provider") as ProviderKey;
  const config = getProviderConfig(c.env, provider);
  const frontendBase = c.env.FRONTEND_BASE || "";
  if (!config) return c.text("该登录方式未配置", 400);

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.redirect(`${frontendBase}/?oauth_error=missing_code`);

  const statePayload = await verifyJwt<{ mode: "login" | "link"; uid?: number }>(state, c.env.JWT_SECRET);
  if (!statePayload) return c.redirect(`${frontendBase}/?oauth_error=invalid_state`);

  try {
    const tokenRes = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.clientId!,
        client_secret: config.clientSecret!,
        code,
        redirect_uri: redirectUri(c.env, provider),
        grant_type: "authorization_code",
      }),
    });
    const tokenData = (await tokenRes.json()) as any;
    const accessToken = tokenData.access_token;
    if (!accessToken) throw new Error(`未能获取access_token: ${JSON.stringify(tokenData)}`);

    const userRes = await fetch(config.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "dnsmgr-cf" },
    });
    const profile = (await userRes.json()) as any;

    // 不同平台的用户ID/用户名字段不一样，做个归一化
    const providerUserId = String(profile.id ?? profile.sub ?? profile.user_id ?? "");
    const providerUsername = profile.username ?? profile.login ?? profile.name ?? profile.email ?? providerUserId;
    if (!providerUserId) throw new Error("无法从第三方平台获取用户ID");

    if (statePayload.mode === "link") {
      // 绑定模式：把这个第三方账号关联到当前登录用户
      await c.env.DB.prepare(
        `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, provider_username, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(provider, provider_user_id) DO UPDATE SET user_id = excluded.user_id, provider_username = excluded.provider_username`
      )
        .bind(statePayload.uid, provider, providerUserId, providerUsername, now())
        .run();
      await insertAuditLog(c.env, statePayload.uid!, "oauth_link", provider, providerUsername);
      return c.redirect(`${frontendBase}/?oauth_linked=${provider}`);
    }

    // 登录模式：查找是否已绑定过这个第三方账号
    const link = await c.env.DB.prepare("SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?")
      .bind(provider, providerUserId)
      .first<{ user_id: number }>();
    if (!link) {
      return c.redirect(`${frontendBase}/?oauth_error=not_linked&provider=${provider}`);
    }
    const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(link.user_id).first<any>();
    if (!user || user.status !== "active") return c.redirect(`${frontendBase}/?oauth_error=user_disabled`);

    const expireSeconds = Number(c.env.JWT_EXPIRE_SECONDS || 86400);
    const jwtToken = await signJwt(
      {
        uid: user.id,
        username: user.username,
        role: user.role,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expireSeconds,
      },
      c.env.JWT_SECRET
    );
    await insertAuditLog(c.env, user.id, "oauth_login", provider);
    return c.redirect(`${frontendBase}/direct-login?token=${jwtToken}`);
  } catch (e: any) {
    console.error(e);
    return c.redirect(`${frontendBase}/?oauth_error=${encodeURIComponent(e.message)}`);
  }
});

/** 已登录用户查看自己绑定了哪些第三方账号 */
oauthRoutes.get("/links", requireAuth, async (c) => {
  const user = c.get("user") as JwtPayload;
  const { results } = await c.env.DB.prepare(
    "SELECT provider, provider_username, created_at FROM oauth_accounts WHERE user_id = ?"
  )
    .bind(user.uid)
    .all();
  return c.json(results);
});

oauthRoutes.delete("/links/:provider", requireAuth, async (c) => {
  const user = c.get("user") as JwtPayload;
  await c.env.DB.prepare("DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?")
    .bind(user.uid, c.req.param("provider"))
    .run();
  return c.json({ ok: true });
});
