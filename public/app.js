const API = window.API_BASE || "";
let state = {
  token: localStorage.getItem("dnsmgr_token") || "",
  user: JSON.parse(localStorage.getItem("dnsmgr_user") || "null"),
  page: "overview",
  domains: [],
  currentDomainId: null,
  favorites: [],
  jumpToDomainId: null,
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
  { key: "overview", label: "概览" },
  { key: "domainList", label: "域名列表", adminOnly: true },
  { key: "domains", label: "域名解析记录" },
  { key: "providers", label: "解析平台账号" },
  { key: "ssl", label: "SSL 证书" },
  { key: "users", label: "用户管理", adminOnly: true },
  { key: "notify", label: "通知渠道" },
  { key: "applink", label: "开放API / 登录直达链接", adminOnly: true },
  { key: "tools", label: "工具箱" },
];

async function renderShell() {
  const app = document.getElementById("app");
  const navHtml = NAV.filter((n) => !n.adminOnly || state.user.role === "admin")
    .map((n) => `<a data-page="${n.key}" class="${state.page === n.key ? "active" : ""}">${n.label}</a>`)
    .join("");

  try {
    state.favorites = await api("/domains/favorites");
  } catch {
    state.favorites = [];
  }
  const favHtml = state.favorites.length
    ? `<div class="nav-section-title">收藏</div>` +
      state.favorites.map((f) => `<a data-jump-domain="${f.id}">★ ${f.domain_name}</a>`).join("")
    : "";

  app.innerHTML = `
    <div class="sidebar">
      <h1>DNSMGR-CF</h1>
      <nav>${navHtml}${favHtml}<a id="logoutLink">退出登录 (${state.user.username})</a></nav>
    </div>
    <div class="main" id="main"></div>`;
  app.querySelectorAll("[data-page]").forEach((a) => (a.onclick = () => { state.page = a.dataset.page; render(); }));
  app.querySelectorAll("[data-jump-domain]").forEach(
    (a) => (a.onclick = () => {
      state.page = "domains";
      state.jumpToDomainId = Number(a.dataset.jumpDomain);
      render();
    })
  );
  document.getElementById("logoutLink").onclick = logout;
  renderPage();
}

function renderPage() {
  const main = document.getElementById("main");
  main.innerHTML = "";
  const renderers = {
    overview: renderOverview,
    domainList: renderDomainList,
    domains: renderDomains,
    providers: renderProviders,
    ssl: renderSsl,
    users: renderUsers,
    notify: renderNotify,
    applink: renderApplink,
    tools: renderTools,
  };
  (renderers[state.page] || renderOverview)(main);
}

// ---------------- 概览页 ----------------
async function renderOverview(main) {
  main.innerHTML = `<div id="overviewContent">加载中...</div>`;
  try {
    const data = await api("/overview");
    const el = document.getElementById("overviewContent");
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px">
        <div class="card" style="margin-bottom:0"><div style="color:var(--muted);font-size:13px">域名总数</div><div style="font-size:28px;font-weight:600">${data.domainCount}</div></div>
        ${data.providerCount !== null ? `<div class="card" style="margin-bottom:0"><div style="color:var(--muted);font-size:13px">解析平台账号</div><div style="font-size:28px;font-weight:600">${data.providerCount}</div></div>` : ""}
        <div class="card" style="margin-bottom:0"><div style="color:var(--muted);font-size:13px">已签发证书</div><div style="font-size:28px;font-weight:600;color:var(--success)">${data.certStats.issued || 0}</div></div>
        <div class="card" style="margin-bottom:0"><div style="color:var(--muted);font-size:13px">签发中</div><div style="font-size:28px;font-weight:600;color:#854d0e">${data.certStats.pending || 0}</div></div>
        <div class="card" style="margin-bottom:0"><div style="color:var(--muted);font-size:13px">签发失败</div><div style="font-size:28px;font-weight:600;color:var(--danger)">${data.certStats.failed || 0}</div></div>
        ${data.userCount !== null ? `<div class="card" style="margin-bottom:0"><div style="color:var(--muted);font-size:13px">用户数</div><div style="font-size:28px;font-weight:600">${data.userCount}</div></div>` : ""}
      </div>
      <div class="card">
        <h3>20天内到期的证书</h3>
        ${
          data.expiringSoon.length
            ? `<table><tr><th>域名</th><th>CN</th><th>到期时间</th></tr>${data.expiringSoon
                .map((c) => `<tr><td>${c.domain_name}</td><td>${c.common_name}</td><td>${new Date(c.expires_at * 1000).toLocaleDateString()}</td></tr>`)
                .join("")}</table>`
            : `<p style="color:var(--muted)">暂无即将到期的证书</p>`
        }
      </div>
      ${
        data.recentActivity.length
          ? `<div class="card"><h3>最近操作日志</h3><table><tr><th>时间</th><th>用户</th><th>操作</th><th>对象</th></tr>${data.recentActivity
              .map(
                (a) => `<tr><td>${new Date(a.created_at * 1000).toLocaleString()}</td><td>${a.username || "-"}</td><td>${a.action}</td><td>${a.target || ""}</td></tr>`
              )
              .join("")}</table></div>`
          : ""
      }
    `;
  } catch (e) {
    document.getElementById("overviewContent").innerHTML = `<p style="color:red">${e.message}</p>`;
  }
}


let dragSrcId = null;

async function renderDomainList(main) {
  main.innerHTML = `<div class="card">
    <h3>域名列表 <span style="font-weight:400;font-size:12px;color:var(--muted)">拖动左侧 ⠿ 图标调整顺序，会同步到「域名解析记录」页面上方下拉框的排列顺序</span></h3>
    <div style="margin-bottom:10px">
      <label><input type="checkbox" id="selectAllDomains" /> 全选</label>
      <button class="danger" id="batchDeleteDomainsBtn">批量删除</button>
    </div>
    <div id="domainListTable">加载中...</div>
  </div>`;

  const domains = await api("/domains");
  state.domains = domains;
  renderDomainListTable(domains);

  document.getElementById("selectAllDomains").onchange = (e) => {
    document.querySelectorAll(".domainRowCheck").forEach((cb) => (cb.checked = e.target.checked));
  };

  document.getElementById("batchDeleteDomainsBtn").onclick = async () => {
    const ids = [...document.querySelectorAll(".domainRowCheck:checked")].map((cb) => Number(cb.dataset.id));
    if (!ids.length) return toast("请先勾选要删除的域名", "error");
    if (!confirm(`确认批量删除这 ${ids.length} 个域名？会同时清除相关的权限、证书、备注记录，且不可恢复。`)) return;
    try {
      await api("/domains/batch-delete", { method: "POST", body: { domainIds: ids } });
      toast("删除成功", "success");
      renderDomainList(main);
    } catch (e) {
      toast(e.message, "error");
    }
  };
}

function renderDomainListTable(domains) {
  const container = document.getElementById("domainListTable");
  const favIds = new Set(state.favorites.map((f) => f.id));
  container.innerHTML = domains.length
    ? `<table id="domainSortTable">
        <tr><th></th><th></th><th></th><th>域名</th><th>平台</th><th>状态</th></tr>
        ${domains
          .map(
            (d) => `<tr draggable="true" data-id="${d.id}" class="domainDragRow">
              <td style="cursor:grab;width:24px">⠿</td>
              <td style="width:24px"><input type="checkbox" class="domainRowCheck" data-id="${d.id}" /></td>
              <td style="width:24px"><span class="favStar ${favIds.has(d.id) ? "active" : ""}" data-id="${d.id}" style="cursor:pointer">${favIds.has(d.id) ? "★" : "☆"}</span></td>
              <td>${d.domain_name}</td>
              <td>${d.provider_type}</td>
              <td>${d.status}</td>
            </tr>`
          )
          .join("")}
      </table>`
    : `<p>暂无域名，请先在「解析平台账号」中添加账号并导入域名。</p>`;

  container.querySelectorAll(".favStar").forEach(
    (star) => (star.onclick = async () => {
      const domainId = Number(star.dataset.id);
      const isFav = star.classList.contains("active");
      try {
        await api(`/domains/${domainId}/favorite`, { method: "PUT", body: { favorite: !isFav } });
        star.classList.toggle("active");
        star.textContent = isFav ? "☆" : "★";
        if (isFav) state.favorites = state.favorites.filter((f) => f.id !== domainId);
        else state.favorites.push({ id: domainId, domain_name: domains.find((d) => d.id === domainId)?.domain_name });
      } catch (e) {
        toast(e.message, "error");
      }
    })
  );

  // 原生 HTML5 拖拽排序，不依赖任何第三方库
  const rows = container.querySelectorAll(".domainDragRow");
  rows.forEach((row) => {
    row.addEventListener("dragstart", () => {
      dragSrcId = row.dataset.id;
      row.style.opacity = "0.4";
    });
    row.addEventListener("dragend", () => {
      row.style.opacity = "1";
    });
    row.addEventListener("dragover", (e) => e.preventDefault());
    row.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (!dragSrcId || dragSrcId === row.dataset.id) return;
      const table = document.getElementById("domainSortTable");
      const srcRow = table.querySelector(`[data-id="${dragSrcId}"]`);
      const rect = row.getBoundingClientRect();
      const insertAfter = e.clientY - rect.top > rect.height / 2;
      row.parentNode.insertBefore(srcRow, insertAfter ? row.nextSibling : row);

      const orderedIds = [...table.querySelectorAll(".domainDragRow")].map((r) => Number(r.dataset.id));
      try {
        await api("/domains/reorder", { method: "PUT", body: { orderedIds } });
        toast("排序已保存", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}
// ---------------- 域名解析记录（下拉框选择域名） ----------------
async function renderDomains(main) {
  main.innerHTML = `<div class="card">
      <h3>域名解析记录</h3>
      <select id="domainSelect"></select>
    </div>
    <div class="card" id="recordsCard" style="display:none">
      <h3>解析记录</h3>
      <div id="recordForm"></div>
      <div id="recordList"></div>
    </div>`;
  try {
    const domains = await api("/domains");
    state.domains = domains;
    const select = document.getElementById("domainSelect");
    if (!domains.length) {
      select.outerHTML = `<p>暂无域名，请先在「解析平台账号」中添加账号并同步域名。</p>`;
      return;
    }
    select.innerHTML = domains
      .map((d) => `<option value="${d.id}">${d.domain_name}（${d.provider_type} · ${d.status}）</option>`)
      .join("");
    if (state.jumpToDomainId && domains.some((d) => d.id === state.jumpToDomainId)) {
      select.value = state.jumpToDomainId;
      state.jumpToDomainId = null;
    }
    select.onchange = () => loadRecords(Number(select.value));
    loadRecords(Number(select.value));
  } catch (e) {
    document.getElementById("domainSelect").outerHTML = `<p style="color:red">${e.message}</p>`;
  }
}

async function loadRecords(domainId) {
  state.currentDomainId = domainId;
  document.getElementById("recordsCard").style.display = "block";

  const domain = state.domains.find((d) => d.id === domainId);
  const isCloudflare = domain && domain.provider_type === "cloudflare";

  document.getElementById("recordForm").innerHTML = `
    <input id="rr" placeholder="主机记录 如 www / @" />
    <select id="type">
      <option>A</option><option>AAAA</option><option>CNAME</option><option>TXT</option><option>MX</option><option>NS</option>
    </select>
    <input id="value" placeholder="记录值" />
    <input id="ttl" placeholder="TTL" value="600" style="width:80px" />
    <input id="remark" placeholder="备注（可选）" style="width:140px" />
    ${isCloudflare ? `<label style="font-size:13px"><input type="checkbox" id="proxied" /> 启用代理(橙云)</label>` : ""}
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
          remark: document.getElementById("remark").value || undefined,
          proxied: isCloudflare ? document.getElementById("proxied").checked : undefined,
        },
      });
      toast("添加成功", "success");
      loadRecords(domainId);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const listEl = document.getElementById("recordList");
  listEl.innerHTML = "加载中...";
  try {
    const records = await api(`/domains/${domainId}/records`);
    listEl.innerHTML = records.length
      ? `<div style="margin-bottom:8px">
          <label><input type="checkbox" id="selectAllRecords" /> 全选</label>
          <button class="danger" id="batchDeleteRecordsBtn">批量删除</button>
        </div>
        <table>
          <tr><th></th><th>主机记录</th><th>类型</th><th>值</th><th>TTL</th>${isCloudflare ? "<th>代理</th>" : ""}<th>备注</th><th>操作</th></tr>
          ${records
            .map(
              (r) => `<tr>
                <td><input type="checkbox" class="recordRowCheck" data-id="${r.id}" /></td>
                <td>${r.rr}</td><td>${r.type}</td><td>${r.value}</td><td>${r.ttl}</td>
                ${isCloudflare ? `<td>${r.proxied ? "已代理" : "仅DNS"}</td>` : ""}
                <td><input class="remarkInput" data-id="${r.id}" value="${r.remark || ""}" placeholder="点击填写备注" style="width:120px;font-size:12px" /></td>
                <td><button class="secondary editRecord" data-record='${JSON.stringify(r).replace(/'/g, "&apos;")}'>修改</button>
                    <button class="danger delRecord" data-id="${r.id}">删除</button></td>
              </tr>`
            )
            .join("")}
        </table>`
      : `<p>暂无解析记录</p>`;

    if (!records.length) return;

    document.getElementById("selectAllRecords").onchange = (e) => {
      listEl.querySelectorAll(".recordRowCheck").forEach((cb) => (cb.checked = e.target.checked));
    };
    document.getElementById("batchDeleteRecordsBtn").onclick = async () => {
      const ids = [...listEl.querySelectorAll(".recordRowCheck:checked")].map((cb) => cb.dataset.id);
      if (!ids.length) return toast("请先勾选要删除的记录", "error");
      if (!confirm(`确认批量删除这 ${ids.length} 条解析记录？`)) return;
      try {
        const r = await api(`/domains/${domainId}/records/batch-delete`, { method: "POST", body: { recordIds: ids } });
        toast(`已删除 ${r.deleted} 条`, "success");
        loadRecords(domainId);
      } catch (e) {
        toast(e.message, "error");
      }
    };

    listEl.querySelectorAll(".remarkInput").forEach(
      (input) =>
        (input.onblur = async () => {
          try {
            await api(`/domains/${domainId}/records/${input.dataset.id}/remark`, {
              method: "PUT",
              body: { remark: input.value },
            });
          } catch (e) {
            toast(e.message, "error");
          }
        })
    );

    listEl.querySelectorAll(".editRecord").forEach(
      (btn) =>
        (btn.onclick = () => {
          const record = JSON.parse(btn.dataset.record.replace(/&apos;/g, "'"));
          showEditRecordModal(domainId, record, isCloudflare);
        })
    );

    listEl.querySelectorAll(".delRecord").forEach(
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
    listEl.innerHTML = `<p style="color:red">${e.message}</p>`;
  }
}

/** 修改解析记录弹窗，预填当前值 */
function showEditRecordModal(domainId, record, isCloudflare) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box" style="width:420px">
      <h3>修改解析记录</h3>
      <label>主机记录</label>
      <input id="editRr" value="${record.rr}" style="width:100%" />
      <label>类型</label>
      <select id="editType" style="width:100%">
        ${["A", "AAAA", "CNAME", "TXT", "MX", "NS"]
          .map((t) => `<option ${t === record.type ? "selected" : ""}>${t}</option>`)
          .join("")}
      </select>
      <label>记录值</label>
      <input id="editValue" value="${record.value}" style="width:100%" />
      <label>TTL</label>
      <input id="editTtl" value="${record.ttl}" style="width:100%" />
      ${
        isCloudflare
          ? `<label><input type="checkbox" id="editProxied" ${record.proxied ? "checked" : ""} /> 启用代理(橙云)</label>`
          : ""
      }
      <div class="modal-actions">
        <button class="secondary" id="cancelEditBtn">取消</button>
        <button id="saveEditBtn">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("cancelEditBtn").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.getElementById("saveEditBtn").onclick = async () => {
    try {
      await api(`/domains/${domainId}/records/${record.id}`, {
        method: "PUT",
        body: {
          rr: document.getElementById("editRr").value,
          type: document.getElementById("editType").value,
          value: document.getElementById("editValue").value,
          ttl: Number(document.getElementById("editTtl").value) || 600,
          proxied: isCloudflare ? document.getElementById("editProxied").checked : undefined,
        },
      });
      toast("修改成功", "success");
      overlay.remove();
      loadRecords(domainId);
    } catch (e) {
      toast(e.message, "error");
    }
  };
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
              <button class="discoverP" data-id="${p.id}">发现域名</button>
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
  document.querySelectorAll(".discoverP").forEach(
    (btn) => (btn.onclick = () => showDiscoverDomainsModal(btn.dataset.id))
  );
  document.querySelectorAll(".delP").forEach(
    (btn) => (btn.onclick = async () => {
      if (!confirm("确认删除该账号？")) return;
      await api(`/providers/${btn.dataset.id}`, { method: "DELETE" });
      renderProviders(main);
    })
  );
}

/** 发现域名弹窗：从平台拉取域名列表供勾选，已导入过的默认勾选并标注 */
async function showDiscoverDomainsModal(providerId) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>发现域名</h3>
      <div id="discoverList">正在从平台拉取域名列表...</div>
      <div class="modal-actions">
        <button class="secondary" id="cancelDiscoverBtn">取消</button>
        <button id="importDomainsBtn">导入选中域名</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("cancelDiscoverBtn").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  try {
    const domains = await api(`/providers/${providerId}/discover-domains`, { method: "POST" });
    const listEl = document.getElementById("discoverList");
    listEl.innerHTML = domains.length
      ? `<div style="max-height:50vh;overflow:auto"><table><tr><th></th><th>域名</th><th>状态</th></tr>${domains
          .map(
            (d) => `<tr>
              <td><input type="checkbox" class="discoverCheck" value="${d.domainName}" ${d.imported ? "checked" : ""} /></td>
              <td>${d.domainName}</td>
              <td>${d.imported ? "已导入" : "未导入"}</td>
            </tr>`
          )
          .join("")}</table></div>`
      : `<p>该账号下没有找到任何域名。</p>`;
  } catch (e) {
    document.getElementById("discoverList").innerHTML = `<p style="color:red">${e.message}</p>`;
  }

  document.getElementById("importDomainsBtn").onclick = async () => {
    const domainNames = [...overlay.querySelectorAll(".discoverCheck:checked")].map((cb) => cb.value);
    if (!domainNames.length) return toast("请至少勾选一个域名", "error");
    try {
      const r = await api(`/providers/${providerId}/import-domains`, { method: "POST", body: { domainNames } });
      toast(`已导入 ${r.imported} 个域名`, "success");
      overlay.remove();
    } catch (e) {
      toast(e.message, "error");
    }
  };
}

// ---------------- SSL 证书 ----------------
async function renderSsl(main) {
  main.innerHTML = `<div class="card"><h3>申请证书</h3>
    <select id="sslDomain"></select>
    <input id="cn" placeholder="主域名，留空默认为域名本身" />
    <label style="display:block;font-size:13px;color:var(--muted);margin:8px 0 4px">附加域名（SAN，可选，一行一个，不用逗号分隔）</label>
    <textarea id="sans" placeholder="例如：&#10;www.example.com&#10;api.example.com" style="width:100%;min-height:70px;font-family:inherit;font-size:13px;padding:8px;border:1px solid var(--border);border-radius:6px;box-sizing:border-box"></textarea>
    <div style="margin-top:8px"><button id="issueBtn">申请</button></div>
    <p style="color:var(--muted);font-size:12px">申请过程会自动通过该域名绑定的解析平台写入/清理 _acme-challenge TXT 记录完成 DNS-01 验证，可能需要1~3分钟。</p>
    </div>
    <div class="card">
      <h3>证书列表</h3>
      <div style="margin-bottom:10px">
        筛选域名：<select id="certFilterDomain"><option value="">全部域名</option></select>
        <label style="margin-left:12px"><input type="checkbox" id="selectAllCerts" /> 全选</label>
        <button class="danger" id="batchDeleteCertsBtn">批量删除</button>
      </div>
      <div id="certList">加载中...</div>
    </div>`;

  const domains = await api("/domains");
  state.domains = domains;
  document.getElementById("sslDomain").innerHTML = domains.map((d) => `<option value="${d.id}">${d.domain_name}</option>`).join("");
  document.getElementById("certFilterDomain").innerHTML +=
    domains.map((d) => `<option value="${d.id}">${d.domain_name}</option>`).join("");

  const loadCertList = async () => {
    const filterDomainId = document.getElementById("certFilterDomain").value;
    const certs = filterDomainId ? await api(`/domains/${filterDomainId}/certs`) : await api(`/domains/certs`);
    const certListEl = document.getElementById("certList");
    certListEl.innerHTML = certs.length
      ? `<table><tr><th></th><th>域名</th><th>CN</th><th>状态</th><th>到期时间</th><th>操作</th></tr>${certs
          .map(
            (c) => `<tr>
              <td><input type="checkbox" class="certRowCheck" data-id="${c.id}" /></td>
              <td>${c.domain_name || ""}</td>
              <td>${c.common_name}</td><td><span class="tag ${c.status}">${c.status}</span></td>
              <td>${c.expires_at ? new Date(c.expires_at * 1000).toLocaleDateString() : "-"}</td>
              <td>${
                c.status === "issued"
                  ? `<button class="view secondary" data-id="${c.id}" data-domain="${c.domain_id}">查看</button> <button class="dl" data-id="${c.id}" data-domain="${c.domain_id}">下载</button> <button class="renew secondary" data-id="${c.id}" data-domain="${c.domain_id}">续签</button>`
                  : ""
              }</td></tr>`
          )
          .join("")}</table>`
      : `<p>暂无证书</p>`;

    document.getElementById("selectAllCerts").onchange = (e) => {
      certListEl.querySelectorAll(".certRowCheck").forEach((cb) => (cb.checked = e.target.checked));
    };

    certListEl.querySelectorAll(".view").forEach(
      (btn) => (btn.onclick = async () => {
        try {
          const data = await api(`/domains/${btn.dataset.domain}/certs/${btn.dataset.id}/download`);
          showCertModal(data.certPem, data.keyPem);
        } catch (e) {
          toast(e.message, "error");
        }
      })
    );
    certListEl.querySelectorAll(".dl").forEach(
      (btn) => (btn.onclick = async () => {
        const data = await api(`/domains/${btn.dataset.domain}/certs/${btn.dataset.id}/download`);
        const blob = new Blob([`${data.certPem}\n${data.keyPem}`], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `cert-${btn.dataset.id}.pem`;
        a.click();
      })
    );
    certListEl.querySelectorAll(".renew").forEach(
      (btn) => (btn.onclick = async () => {
        try {
          const r = await api(`/domains/${btn.dataset.domain}/certs/${btn.dataset.id}/renew`, { method: "POST" });
          toast("已提交续签，正在后台处理中，可能需要1~3分钟", "success");
          loadCertList();
          pollCertStatus(btn.dataset.domain, Number(btn.dataset.id), loadCertList);
        } catch (e) {
          toast(e.message, "error");
        }
      })
    );
  };

  document.getElementById("certFilterDomain").onchange = loadCertList;
  document.getElementById("batchDeleteCertsBtn").onclick = async () => {
    const ids = [...document.querySelectorAll(".certRowCheck:checked")].map((cb) => Number(cb.dataset.id));
    if (!ids.length) return toast("请先勾选要删除的证书", "error");
    if (!confirm(`确认批量删除这 ${ids.length} 条证书记录？（只删除本地记录，不会去CA吊销证书）`)) return;
    try {
      const r = await api(`/domains/certs/batch-delete`, { method: "POST", body: { certIds: ids } });
      toast(`已删除 ${r.deleted} 条`, "success");
      loadCertList();
    } catch (e) {
      toast(e.message, "error");
    }
  };

  loadCertList();

  document.getElementById("issueBtn").onclick = async () => {
    const domainId = document.getElementById("sslDomain").value;
    const domain = state.domains.find((d) => String(d.id) === String(domainId));
    const cnInput = document.getElementById("cn").value.trim();
    const cn = cnInput || (domain ? domain.domain_name : "");
    const sansRaw = document.getElementById("sans").value;
    const sans = sansRaw
      ? sansRaw.split("\n").map((s) => s.trim()).filter(Boolean)
      : [];
    if (!cn) return toast("请先选择域名", "error");
    try {
      const r = await api(`/domains/${domainId}/certs`, { method: "POST", body: { commonName: cn, sans } });
      toast("已提交申请，正在后台签发中，可能需要1~3分钟，请不要重复点击", "success");
      loadCertList();
      pollCertStatus(domainId, r.certId, loadCertList);
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
        toast(`证书 ${cert.common_name} 签发失败，请查看 GitHub Actions 的 Issue SSL Certificate 工作流日志`, "error");
        onUpdate();
      } else {
        onUpdate();
        pollCertStatus(domainId, certId, onUpdate, triesLeft - 1);
      }
    } catch (e) {
      pollCertStatus(domainId, certId, onUpdate, triesLeft - 1);
    }
  }, 5000);
}

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
              }</button>
              <button class="secondary resetPwd" data-id="${u.id}" data-username="${u.username}">修改密码</button>
              <button class="secondary grantP" data-id="${u.id}" data-username="${u.username}">授权域名</button>
              <button class="danger delUser" data-id="${u.id}" data-username="${u.username}">删除</button>`
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

  document.querySelectorAll(".resetPwd").forEach(
    (btn) => (btn.onclick = () => showResetPasswordModal(btn.dataset.id, btn.dataset.username))
  );

  document.querySelectorAll(".delUser").forEach(
    (btn) => (btn.onclick = async () => {
      if (!confirm(`确认删除用户「${btn.dataset.username}」？这会同时清除该用户的域名授权、API Key、通知渠道配置，且不可恢复。`)) return;
      try {
        await api(`/users/${btn.dataset.id}`, { method: "DELETE" });
        toast("已删除", "success");
        renderUsers(main);
      } catch (e) {
        toast(e.message, "error");
      }
    })
  );

  document.querySelectorAll(".grantP").forEach(
    (btn) => (btn.onclick = () => showDomainPermModal(btn.dataset.id, btn.dataset.username))
  );
}

/** 修改密码弹窗（管理员直接重置，不需要旧密码） */
function showResetPasswordModal(userId, username) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box" style="width:360px">
      <h3>修改密码 - ${username}</h3>
      <label>新密码（至少6位）</label>
      <input id="newPwdInput" type="password" style="width:100%" />
      <div class="modal-actions">
        <button class="secondary" id="cancelPwdBtn">取消</button>
        <button id="savePwdBtn">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("cancelPwdBtn").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.getElementById("savePwdBtn").onclick = async () => {
    const newPassword = document.getElementById("newPwdInput").value;
    if (!newPassword || newPassword.length < 6) {
      toast("新密码长度至少6位", "error");
      return;
    }
    try {
      await api(`/users/${userId}/password`, { method: "PUT", body: { newPassword } });
      toast("密码已修改", "success");
      overlay.remove();
    } catch (e) {
      toast(e.message, "error");
    }
  };
}

/** 授权域名弹窗：所有域名以勾选框形式列出，勾选=授权，每个勾选项旁可选只读/读写 */
async function showDomainPermModal(userId, username) {
  const [domains, currentPerms] = await Promise.all([
    api("/domains"),
    api(`/users/${userId}/domain-perms`),
  ]);
  const permMap = {};
  currentPerms.forEach((p) => (permMap[p.domain_id] = p.perm));

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>授权域名 - ${username}</h3>
      <div style="max-height:50vh;overflow:auto">
        <table>
          <tr><th></th><th>域名</th><th>权限</th></tr>
          ${domains
            .map((d) => {
              const granted = permMap[d.id];
              return `<tr>
                <td><input type="checkbox" class="domCheck" data-domain="${d.id}" ${granted ? "checked" : ""} /></td>
                <td>${d.domain_name}</td>
                <td>
                  <select class="domPerm" data-domain="${d.id}" ${granted ? "" : "disabled"}>
                    <option value="readwrite" ${granted === "readwrite" || !granted ? "selected" : ""}>读写</option>
                    <option value="readonly" ${granted === "readonly" ? "selected" : ""}>只读</option>
                  </select>
                </td>
              </tr>`;
            })
            .join("")}
        </table>
      </div>
      <div class="modal-actions">
        <button class="secondary" id="cancelPermBtn">取消</button>
        <button id="savePermBtn">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelectorAll(".domCheck").forEach((cb) => {
    cb.onchange = () => {
      const select = overlay.querySelector(`.domPerm[data-domain="${cb.dataset.domain}"]`);
      select.disabled = !cb.checked;
    };
  });

  document.getElementById("cancelPermBtn").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  document.getElementById("savePermBtn").onclick = async () => {
    const checks = [...overlay.querySelectorAll(".domCheck")];
    try {
      for (const cb of checks) {
        const domainId = Number(cb.dataset.domain);
        const wasGranted = !!permMap[domainId];
        if (cb.checked) {
          const perm = overlay.querySelector(`.domPerm[data-domain="${domainId}"]`).value;
          // 新勾选的，或者权限档位变了，才调用保存接口（避免没改动的也重复请求）
          if (!wasGranted || permMap[domainId] !== perm) {
            await api(`/users/${userId}/domain-perms`, { method: "POST", body: { domainId, perm } });
          }
        } else if (wasGranted) {
          await api(`/users/${userId}/domain-perms/${domainId}`, { method: "DELETE" });
        }
      }
      toast("授权已更新", "success");
      overlay.remove();
    } catch (e) {
      toast(e.message, "error");
    }
  };
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

// ---------------- 证书查看弹窗 ----------------
function showCertModal(certPem, keyPem) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <h3>证书内容</h3>
      <label>证书（Certificate）</label>
      <textarea id="certText" readonly>${certPem || ""}</textarea>
      <label>私钥（Private Key）</label>
      <textarea id="keyText" readonly>${keyPem || ""}</textarea>
      <div class="modal-actions">
        <button class="secondary" id="copyCertBtn">复制证书</button>
        <button class="secondary" id="copyKeyBtn">复制私钥</button>
        <button id="closeCertModalBtn">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}已复制到剪贴板`, "success");
    } catch {
      // 部分浏览器/非HTTPS环境剪贴板API不可用，退化为手动选中
      toast(`自动复制失败，请手动选中${label}文本框内容复制`, "error");
    }
  };
  document.getElementById("copyCertBtn").onclick = () => copy(certPem || "", "证书");
  document.getElementById("copyKeyBtn").onclick = () => copy(keyPem || "", "私钥");
  document.getElementById("closeCertModalBtn").onclick = () => overlay.remove();
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
}

// ---------------- 工具箱 ----------------
async function renderTools(main) {
  main.innerHTML = `
    <div class="card">
      <h3>DNS 查询</h3>
      <input id="dnsLookupDomain" placeholder="example.com" />
      <select id="dnsLookupType">
        <option>A</option><option>AAAA</option><option>CNAME</option><option>TXT</option><option>MX</option><option>NS</option><option>SOA</option>
      </select>
      <button id="dnsLookupBtn">查询</button>
      <div id="dnsLookupResult" style="margin-top:10px"></div>
    </div>
    <div class="card">
      <h3>Whois 查询</h3>
      <input id="whoisDomain" placeholder="example.com" />
      <button id="whoisBtn">查询</button>
      <div id="whoisResult" style="margin-top:10px"></div>
    </div>
    <div class="card">
      <h3>网站证书检查</h3>
      <p style="color:var(--muted);font-size:12px;margin-top:-6px">基于 Certificate Transparency 公开日志（crt.sh）查询该域名最近签发过的证书记录</p>
      <input id="certCheckDomain" placeholder="example.com" />
      <button id="certCheckBtn">查询</button>
      <div id="certCheckResult" style="margin-top:10px"></div>
    </div>`;

  document.getElementById("dnsLookupBtn").onclick = async () => {
    const domain = document.getElementById("dnsLookupDomain").value.trim();
    const type = document.getElementById("dnsLookupType").value;
    const resultEl = document.getElementById("dnsLookupResult");
    if (!domain) return toast("请输入域名", "error");
    resultEl.innerHTML = "查询中...";
    try {
      const data = await api(`/tools/dns-lookup?domain=${encodeURIComponent(domain)}&type=${type}`);
      resultEl.innerHTML = data.answers.length
        ? `<table><tr><th>名称</th><th>类型</th><th>TTL</th><th>值</th></tr>${data.answers
            .map((a) => `<tr><td>${a.name}</td><td>${a.type}</td><td>${a.ttl}</td><td>${a.data}</td></tr>`)
            .join("")}</table>`
        : `<p style="color:var(--muted)">未查询到记录</p>`;
    } catch (e) {
      resultEl.innerHTML = `<p style="color:red">${e.message}</p>`;
    }
  };

  document.getElementById("whoisBtn").onclick = async () => {
    const domain = document.getElementById("whoisDomain").value.trim();
    const resultEl = document.getElementById("whoisResult");
    if (!domain) return toast("请输入域名", "error");
    resultEl.innerHTML = "查询中...";
    try {
      const data = await api(`/tools/whois?domain=${encodeURIComponent(domain)}`);
      resultEl.innerHTML = `<table>
        <tr><th>注册商</th><td>${data.registrar || "-"}</td></tr>
        <tr><th>注册时间</th><td>${data.registeredAt || "-"}</td></tr>
        <tr><th>到期时间</th><td>${data.expiresAt || "-"}</td></tr>
        <tr><th>最近更新</th><td>${data.updatedAt || "-"}</td></tr>
        <tr><th>域名状态</th><td>${(data.status || []).join(", ") || "-"}</td></tr>
        <tr><th>DNS服务器</th><td>${(data.nameservers || []).join(", ") || "-"}</td></tr>
      </table>`;
    } catch (e) {
      resultEl.innerHTML = `<p style="color:red">${e.message}</p>`;
    }
  };

  document.getElementById("certCheckBtn").onclick = async () => {
    const domain = document.getElementById("certCheckDomain").value.trim();
    const resultEl = document.getElementById("certCheckResult");
    if (!domain) return toast("请输入域名", "error");
    resultEl.innerHTML = "查询中...";
    try {
      const data = await api(`/tools/cert-check?domain=${encodeURIComponent(domain)}`);
      resultEl.innerHTML = data.certificates.length
        ? `<table><tr><th>通用名称</th><th>颁发机构</th><th>生效时间</th><th>失效时间</th></tr>${data.certificates
            .map((c) => `<tr><td>${c.commonName}</td><td>${c.issuer}</td><td>${c.notBefore}</td><td>${c.notAfter}</td></tr>`)
            .join("")}</table>`
        : `<p style="color:var(--muted)">未查询到相关证书记录</p>`;
    } catch (e) {
      resultEl.innerHTML = `<p style="color:red">${e.message}</p>`;
    }
  };
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
