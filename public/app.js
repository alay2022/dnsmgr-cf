const API = window.API_BASE || "";
let state = {
  token: localStorage.getItem("dnsmgr_token") || "",
  user: JSON.parse(localStorage.getItem("dnsmgr_user") || "null"),
  page: "domains",
  domains: [],
  currentDomainId: null,
};

function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}/api${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

function saveSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem("dnsmgr_token", token);
  localStorage.setItem("dnsmgr_user", JSON.stringify(user));
}
function logout() {
  state.token = "";
  state.user = null;
  localStorage.removeItem("dnsmgr_token");
  localStorage.removeItem("dnsmgr_user");
  render();
}

// ---------------- 处理「登录直达链接」跳转 ----------------
(function handleDirectLogin() {
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  if (location.pathname.includes("direct-login") && token) {
    localStorage.setItem("dnsmgr_token", token);
    state.token = token;
    history.replaceState({}, "", "/");
  }
})();

// ---------------- 登录页 ----------------
function renderLogin() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-box">
        <h2>DNSMGR-CF 登录</h2>
        <input id="username" placeholder="用户名" value="admin" />
        <input id="password" type="password" placeholder="密码" value="admin" />
        <button id="loginBtn">登录</button>
      </div>
    </div>`;
  document.getElementById("loginBtn").onclick = async () => {
    try {
      const username = document.getElementById("username").value;
      const password = document.getElementById("password").value;
      const data = await api("/auth/login", { method: "POST", body: { username, password } });
      saveSession(data.token, data.user);
      if (data.forcePasswordChange) toast("检测到你仍在使用默认密码 admin，请尽快修改", "error");
      render();
    } catch (e) {
      toast(e.message, "error");
    }
  };
}

// ---------------- 主框架 ----------------
const NAV = [
  { key: "domains", label: "域名 / 解析记录" },
  { key: "providers", label: "解析平台账号" },
  { key: "ssl", label: "SSL 证书" },
  { key: "users", label: "用户管理", adminOnly: true },
  { key: "notify", label: "通知渠道" },
  { key: "applink", label: "开放API / 登录直达链接", adminOnly: true },
];

function renderShell() {
  const app = document.getElementById("app");
  const navHtml = NAV.filter((n) => !n.adminOnly || state.user.role === "admin")
    .map((n) => `<a data-page="${n.key}" class="${state.page === n.key ? "active" : ""}">${n.label}</a>`)
    .join("");
  app.innerHTML = `
    <div class="sidebar">
      <h1>DNSMGR-CF</h1>
      <nav>${navHtml}<a id="logoutLink">退出登录 (${state.user.username})</a></nav>
    </div>
    <div class="main" id="main"></div>`;
  app.querySelectorAll("[data-page]").forEach((a) => (a.onclick = () => { state.page = a.dataset.page; render(); }));
  document.getElementById("logoutLink").onclick = logout;
  renderPage();
}

function renderPage() {
  const main = document.getElementById("main");
  main.innerHTML = "";
  const renderers = {
    domains: renderDomains,
    providers: renderProviders,
    ssl: renderSsl,
    users: renderUsers,
    notify: renderNotify,
    applink: renderApplink,
  };
  (renderers[state.page] || renderDomains)(main);
}

// ---------------- 域名 / 解析记录 ----------------
async function renderDomains(main) {
  main.innerHTML = `<div class="card"><h3>域名列表</h3><div id="domainList">加载中...</div></div>
                     <div class="card" id="recordsCard" style="display:none">
                       <h3>解析记录 <span id="recDomainName"></span></h3>
                       <div id="recordForm"></div>
                       <div id="recordList"></div>
                     </div>`;
  try {
    const domains = await api("/domains");
    state.domains = domains;
    document.getElementById("domainList").innerHTML = domains.length
      ? `<table><tr><th>域名</th><th>平台</th><th>状态</th><th>操作</th></tr>${domains
          .map(
            (d) => `<tr><td>${d.domain_name}</td><td>${d.provider_type}</td><td>${d.status}</td>
              <td><button data-id="${d.id}" class="viewRecords">解析记录</button></td></tr>`
          )
          .join("")}</table>`
      : `<p>暂无域名，请先在「解析平台账号」中添加账号并同步域名。</p>`;
    document.querySelectorAll(".viewRecords").forEach((btn) => (btn.onclick = () => loadRecords(Number(btn.dataset.id))));
  } catch (e) {
    document.getElementById("domainList").innerHTML = `<p style="color:red">${e.message}</p>`;
  }
}

async function loadRecords(domainId) {
  state.currentDomainId = domainId;
  const domain = state.domains.find((d) => d.id === domainId);
  document.getElementById("recordsCard").style.display = "block";
  document.getElementById("recDomainName").textContent = `- ${domain?.domain_name || ""}`;
  document.getElementById("recordForm").innerHTML = `
    <input id="rr" placeholder="主机记录 如 www / @" />
    <select id="type">
      <option>A</option><option>AAAA</option><option>CNAME</option><option>TXT</option><option>MX</option><option>NS</option>
    </select>
    <input id="value" placeholder="记录值" />
    <input id="ttl" placeholder="TTL" value="600" style="width:80px" />
    <button id="addRecordBtn">添加记录</button>`;
  document.getElementById("addRecordBtn").onclick = async () => {
    try {
      await api(`/domains/${domainId}/records`, {
        method: "POST",
        body: {
          rr: document.getElementById("rr").value,
          type: document.getElementById("type").value,
          value: document.getElementById("value").value,
          ttl: Number(document.getElementById("ttl").value) || 600,
        },
      });
      toast("添加成功", "success");
      loadRecords(domainId);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  document.getElementById("recordList").innerHTML = "加载中...";
  try {
    const records = await api(`/domains/${domainId}/records`);
    document.getElementById("recordList").innerHTML = records.length
      ? `<table><tr><th>主机记录</th><th>类型</th><th>值</th><th>TTL</th><th>操作</th></tr>${records
          .map(
            (r) => `<tr><td>${r.rr}</td><td>${r.type}</td><td>${r.value}</td><td>${r.ttl}</td>
              <td><button class="danger delRecord" data-id="${r.id}">删除</button></td></tr>`
          )
          .join("")}</table>`
      : `<p>暂无解析记录</p>`;
    document.querySelectorAll(".delRecord").forEach(
      (btn) =>
        (btn.onclick = async () => {
          if (!confirm("确认删除该记录？")) return;
          try {
            await api(`/domains/${domainId}/records/${btn.dataset.id}`, { method: "DELETE" });
            toast("已删除", "success");
            loadRecords(domainId);
          } catch (e) {
            toast(e.message, "error");
          }
        })
    );
  } catch (e) {
    document.getElementById("recordList").innerHTML = `<p style="color:red">${e.message}</p>`;
  }
}

// ---------------- 解析平台账号 ----------------
const PROVIDER_TYPES = [
  ["cloudflare", "CloudFlare"],
  ["tencent", "腾讯云 DNSPod"],
  ["aliyun", "阿里云"],
  ["huaweicloud", "华为云"],
  ["baiducloud", "百度智能云"],
  ["west", "西部数码"],
  ["volcengine", "火山引擎"],
  ["dnsla", "DNSLA"],
  ["namesilo", "Namesilo"],
  ["powerdns", "PowerDNS"],
];
const PROVIDER_CRED_FIELDS = {
  cloudflare: [
    ["apiToken", "API Token（推荐，填了这个下面两项可留空）"],
    ["email", "邮箱（仅用 Global API Key 时需要）"],
    ["apiKey", "Global API Key（仅老版鉴权需要）"],
  ],
  tencent: [["secretId", "secretId"], ["secretKey", "secretKey"]],
  aliyun: [["accessKeyId", "accessKeyId"], ["accessKeySecret", "accessKeySecret"]],
  huaweicloud: [["accessKeyId", "accessKeyId"], ["secretAccessKey", "secretAccessKey"]],
  baiducloud: [["accessKeyId", "accessKeyId"], ["secretAccessKey", "secretAccessKey"]],
  west: [["username", "username"], ["apiPassword", "apiPassword"]],
  volcengine: [["accessKeyId", "accessKeyId"], ["secretAccessKey", "secretAccessKey"], ["region", "region(可选,默认cn-north-1)"]],
  dnsla: [["apiKey", "apiKey"], ["apiSecret", "apiSecret"]],
  namesilo: [["apiKey", "apiKey"]],
  powerdns: [["apiUrl", "apiUrl,如 https://ns.example.com:8081"], ["apiKey", "apiKey"], ["serverId", "serverId(可选,默认localhost)"]],
};

async function renderProviders(main) {
  main.innerHTML = `<div class="card"><h3>新增解析平台账号</h3>
      <select id="pType"></select>
      <input id="pName" placeholder="备注名称" />
      <div id="credFields"></div>
      <button id="addProviderBtn">保存</button>
    </div>
    <div class="card"><h3>已添加账号</h3><div id="providerList">加载中...</div></div>`;

  const typeSelect = document.getElementById("pType");
  typeSelect.innerHTML = PROVIDER_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  const renderCredFields = () => {
    const fields = PROVIDER_CRED_FIELDS[typeSelect.value] || [];
    document.getElementById("credFields").innerHTML = fields
      .map(([key, label]) => `<input data-f="${key}" placeholder="${label}" /><br/><br/>`)
      .join("");
  };
  typeSelect.onchange = renderCredFields;
  renderCredFields();

  document.getElementById("addProviderBtn").onclick = async () => {
    const credentials = {};
    document.querySelectorAll("#credFields input").forEach((i) => {
      if (i.value) credentials[i.dataset.f] = i.value; // 空字段不提交，避免覆盖为空字符串
    });
    try {
      await api("/providers", {
        method: "POST",
        body: { type: typeSelect.value, name: document.getElementById("pName").value || typeSelect.value, credentials },
      });
      toast("添加成功", "success");
      renderProviders(main);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const list = await api("/providers");
  document.getElementById("providerList").innerHTML = list.length
    ? `<table><tr><th>名称</th><th>类型</th><th>操作</th></tr>${list
        .map(
          (p) => `<tr><td>${p.name}</td><td>${p.type}</td>
          <td><button class="testP" data-id="${p.id}">测试</button>
              <button class="syncP" data-id="${p.id}">同步域名</button>
              <button class="danger delP" data-id="${p.id}">删除</button></td></tr>`
        )
        .join("")}</table>`
    : `<p>暂未添加任何解析平台账号</p>`;

  document.querySelectorAll(".testP").forEach(
    (btn) => (btn.onclick = async () => {
      try {
        const r = await api(`/providers/${btn.dataset.id}/test`, { method: "POST" });
        toast(r.ok ? `连接成功，检测到 ${r.domainCount} 个域名` : r.error, r.ok ? "success" : "error");
      } catch (e) {
        toast(e.message, "error");
      }
    })
  );
  document.querySelectorAll(".syncP").forEach(
    (btn) => (btn.onclick = async () => {
      try {
        const r = await api(`/providers/${btn.dataset.id}/sync-domains`, { method: "POST" });
        toast(`已同步 ${r.synced} 个域名`, "success");
      } catch (e) {
        toast(e.message, "error");
      }
    })
  );
  document.querySelectorAll(".delP").forEach(
    (btn) => (btn.onclick = async () => {
      if (!confirm("确认删除该账号？")) return;
      await api(`/providers/${btn.dataset.id}`, { method: "DELETE" });
      renderProviders(main);
    })
  );
}

// ---------------- SSL 证书 ----------------
async function renderSsl(main) {
  main.innerHTML = `<div class="card"><h3>申请证书</h3>
    <select id="sslDomain"></select>
    <input id="cn" placeholder="主域名 如 www.example.com" />
    <input id="sans" placeholder="附加SAN，逗号分隔（可选）" />
    <button id="issueBtn">申请</button>
    <p style="color:var(--muted);font-size:12px">申请过程会自动通过该域名绑定的解析平台写入/清理 _acme-challenge TXT 记录完成 DNS-01 验证，可能需要1~3分钟。</p>
    </div>
    <div class="card"><h3>证书列表</h3><div id="certList">选择上方域名后查看</div></div>`;

  const domains = await api("/domains");
  document.getElementById("sslDomain").innerHTML = domains.map((d) => `<option value="${d.id}">${d.domain_name}</option>`).join("");
  const loadCerts = async () => {
    const domainId = document.getElementById("sslDomain").value;
    const certs = await api(`/domains/${domainId}/certs`);
    document.getElementById("certList").innerHTML = certs.length
      ? `<table><tr><th>CN</th><th>状态</th><th>到期时间</th><th>操作</th></tr>${certs
          .map(
            (c) => `<tr><td>${c.common_name}</td><td><span class="tag ${c.status}">${c.status}</span></td>
              <td>${c.expires_at ? new Date(c.expires_at * 1000).toLocaleDateString() : "-"}</td>
              <td>${
                c.status === "issued"
                  ? `<button class="dl" data-id="${c.id}">下载</button> <button class="renew secondary" data-id="${c.id}">续签</button>`
                  : ""
              }</td></tr>`
          )
          .join("")}</table>`
      : `<p>该域名暂无证书</p>`;

    document.querySelectorAll(".dl").forEach(
      (btn) => (btn.onclick = async () => {
        const data = await api(`/domains/${domainId}/certs/${btn.dataset.id}/download`);
        const blob = new Blob([`${data.certPem}\n${data.keyPem}`], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `cert-${btn.dataset.id}.pem`;
        a.click();
      })
    );
    document.querySelectorAll(".renew").forEach(
      (btn) => (btn.onclick = async () => {
        try {
          const r = await api(`/domains/${domainId}/certs/${btn.dataset.id}/renew`, { method: "POST" });
          toast("已提交续签，正在后台处理中，可能需要1~3分钟", "success");
          loadCerts();
          pollCertStatus(domainId, Number(btn.dataset.id), loadCerts);
        } catch (e) {
          toast(e.message, "error");
        }
      })
    );
  };
  document.getElementById("sslDomain").onchange = loadCerts;
  if (domains.length) loadCerts();

  document.getElementById("issueBtn").onclick = async () => {
    const domainId = document.getElementById("sslDomain").value;
    const cn = document.getElementById("cn").value;
    const sansRaw = document.getElementById("sans").value;
    const sans = sansRaw ? sansRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    try {
      const r = await api(`/domains/${domainId}/certs`, { method: "POST", body: { commonName: cn, sans } });
      toast("已提交申请，正在后台签发中，可能需要1~3分钟，请不要重复点击", "success");
      loadCerts();
      pollCertStatus(domainId, r.certId, loadCerts);
    } catch (e) {
      toast(e.message, "error");
    }
  };
}

/** 每隔5秒刷新一次证书列表，最多轮询2分钟，直到状态不再是pending（签发在Worker后台异步执行，不依赖本次页面停留） */
function pollCertStatus(domainId, certId, onUpdate, triesLeft = 24) {
  if (triesLeft <= 0) return;
  setTimeout(async () => {
    try {
      const certs = await api(`/domains/${domainId}/certs`);
      const cert = certs.find((c) => c.id === certId);
      if (cert && cert.status === "issued") {
        toast(`证书 ${cert.common_name} 签发成功`, "success");
        onUpdate();
      } else if (cert && cert.status === "failed") {
        toast(`证书 ${cert.common_name} 签发失败，请查看 wrangler tail 日志`, "error");
        onUpdate();
      } else {
        onUpdate();
        pollCertStatus(domainId, certId, onUpdate, triesLeft - 1);
      }
    } catch (e) {
      pollCertStatus(domainId, certId, onUpdate, triesLeft - 1);
    }
  }, 5000);

// ---------------- 用户管理 ----------------
async function renderUsers(main) {
  main.innerHTML = `<div class="card"><h3>新增用户</h3>
    <input id="uName" placeholder="用户名" />
    <input id="uPass" placeholder="密码" type="password" />
    <select id="uRole"><option value="user">普通用户</option><option value="admin">管理员</option></select>
    <button id="addUserBtn">创建</button></div>
    <div class="card"><h3>用户列表</h3><div id="userList">加载中...</div></div>`;

  document.getElementById("addUserBtn").onclick = async () => {
    try {
      await api("/users", {
        method: "POST",
        body: {
          username: document.getElementById("uName").value,
          password: document.getElementById("uPass").value,
          role: document.getElementById("uRole").value,
        },
      });
      toast("创建成功", "success");
      renderUsers(main);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const users = await api("/users");
  document.getElementById("userList").innerHTML = `<table><tr><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr>${users
    .map(
      (u) => `<tr><td>${u.username}</td><td>${u.role}</td><td>${u.status}</td>
        <td>${
          u.username !== "admin"
            ? `<button class="secondary toggleStatus" data-id="${u.id}" data-status="${u.status === "active" ? "disabled" : "active"}">${
                u.status === "active" ? "禁用" : "启用"
              }</button> <button class="grantP" data-id="${u.id}">授权域名</button>`
            : ""
        }</td></tr>`
    )
    .join("")}</table>`;

  document.querySelectorAll(".toggleStatus").forEach(
    (btn) => (btn.onclick = async () => {
      await api(`/users/${btn.dataset.id}/status`, { method: "PUT", body: { status: btn.dataset.status } });
      renderUsers(main);
    })
  );
  document.querySelectorAll(".grantP").forEach(
    (btn) => (btn.onclick = async () => {
      const domains = await api("/domains");
      const domainId = prompt(`输入要授权的域名ID（可选：\n${domains.map((d) => `${d.id}: ${d.domain_name}`).join("\n")}）`);
      if (!domainId) return;
      const perm = confirm("点击「确定」授予读写权限，点击「取消」授予只读权限") ? "readwrite" : "readonly";
      await api(`/users/${btn.dataset.id}/domain-perms`, { method: "POST", body: { domainId: Number(domainId), perm } });
      toast("授权成功", "success");
    })
  );
}

// ---------------- 通知渠道 ----------------
const NOTIFY_TYPES = [
  ["email", "邮件"],
  ["wechat_mp", "微信公众号"],
  ["telegram", "Telegram"],
  ["dingtalk", "钉钉"],
  ["feishu", "飞书"],
  ["wecom", "企业微信"],
  ["serverchan", "Server酱"],
];
const NOTIFY_FIELDS = {
  email: ["apiKey", "from", "to"],
  wechat_mp: ["appId", "appSecret", "templateId", "toOpenId"],
  telegram: ["botToken", "chatId"],
  dingtalk: ["webhookUrl", "secret"],
  feishu: ["webhookUrl"],
  wecom: ["webhookUrl"],
  serverchan: ["sendKey"],
};

async function renderNotify(main) {
  main.innerHTML = `<div class="card"><h3>新增通知渠道</h3>
    <select id="nType"></select>
    <div id="nFields"></div>
    <button id="addNotifyBtn">保存</button></div>
    <div class="card"><h3>已配置渠道</h3><div id="notifyList">加载中...</div></div>`;

  const sel = document.getElementById("nType");
  sel.innerHTML = NOTIFY_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  const renderFields = () => {
    document.getElementById("nFields").innerHTML = (NOTIFY_FIELDS[sel.value] || [])
      .map((f) => `<input data-f="${f}" placeholder="${f}" />`)
      .join("");
  };
  sel.onchange = renderFields;
  renderFields();

  document.getElementById("addNotifyBtn").onclick = async () => {
    const config = {};
    document.querySelectorAll("#nFields input").forEach((i) => (config[i.dataset.f] = i.value));
    try {
      await api("/notify", { method: "POST", body: { type: sel.value, config } });
      toast("保存成功", "success");
      renderNotify(main);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const list = await api("/notify");
  document.getElementById("notifyList").innerHTML = list.length
    ? `<table><tr><th>类型</th><th>状态</th><th>操作</th></tr>${list
        .map(
          (n) => `<tr><td>${n.type}</td><td>${n.enabled ? "启用" : "禁用"}</td>
          <td><button class="testN" data-id="${n.id}">测试</button> <button class="danger delN" data-id="${n.id}">删除</button></td></tr>`
        )
        .join("")}</table>`
    : `<p>暂未配置通知渠道</p>`;

  document.querySelectorAll(".testN").forEach(
    (btn) => (btn.onclick = async () => {
      const r = await api(`/notify/${btn.dataset.id}/test`, { method: "POST" });
      toast(r.ok ? "发送成功，请查收" : r.error, r.ok ? "success" : "error");
    })
  );
  document.querySelectorAll(".delN").forEach(
    (btn) => (btn.onclick = async () => {
      await api(`/notify/${btn.dataset.id}`, { method: "DELETE" });
      renderNotify(main);
    })
  );
}

// ---------------- 开放API / 登录直达链接 ----------------
async function renderApplink(main) {
  main.innerHTML = `<div class="card"><h3>API Key（供 IDC 系统调用「获取域名登录直达链接」接口）</h3>
    <p style="font-size:12px;color:var(--muted)">
      调用方式：POST ${API || location.origin}/api/open/applink&nbsp;
      body: {"apiKey":"...","apiSecret":"...","domainId":1} → 返回 {"url": "https://.../direct-login?token=..."}
    </p>
    <button id="createKeyBtn">生成新的 API Key</button>
    <div id="keyList">加载中...</div></div>`;

  document.getElementById("createKeyBtn").onclick = async () => {
    const r = await api("/open/keys", { method: "POST", body: { userId: state.user.id, remark: "IDC对接" } });
    alert(`API Key: ${r.apiKey}\nAPI Secret: ${r.apiSecret}\n\n请妥善保存，Secret仅显示这一次！`);
    renderApplink(main);
  };

  const list = await api("/open/keys");
  document.getElementById("keyList").innerHTML = list.length
    ? `<table><tr><th>API Key</th><th>备注</th><th>状态</th><th>操作</th></tr>${list
        .map(
          (k) => `<tr><td>${k.key}</td><td>${k.remark || ""}</td><td>${k.status}</td>
          <td><button class="danger delKey" data-id="${k.id}">吊销</button></td></tr>`
        )
        .join("")}</table>`
    : `<p>暂无API Key</p>`;

  document.querySelectorAll(".delKey").forEach(
    (btn) => (btn.onclick = async () => {
      await api(`/open/keys/${btn.dataset.id}`, { method: "DELETE" });
      renderApplink(main);
    })
  );
}

// ---------------- 渲染入口 ----------------
async function render() {
  if (!state.token) {
    renderLogin();
    return;
  }
  if (!state.user) {
    try {
      const me = await api("/auth/me");
      state.user = { id: me.id, username: me.username, role: me.role };
      localStorage.setItem("dnsmgr_user", JSON.stringify(state.user));
    } catch (e) {
      logout();
      return;
    }
  }
  renderShell();
}

render();
