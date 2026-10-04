/**
 * HTTP 接口（node:http，零第三方依赖）。
 * 角色由请求头 x-client-role 声明，配合演示用角色密钥；生产应替换为网关鉴权。
 * 角色：ticketing（票务/平台）、spot（景区终端）、visitor（游客 App）、
 *       clearing（财政清算）、office（文旅联动办/主管部门）、device-gateway（离线同步网关）。
 */
import http from "node:http";
import { createApp } from "./app.js";

export function createServer(app = createApp()) {
  const routes = [];
  const route = (method, pattern, roles, handler) =>
    routes.push({ method, pattern, roles, handler });

  // ---- 目录与票务 ----
  route("POST", /^\/admin\/matches$/, ["ticketing"], async (b) => app.catalog.scheduleMatch(b));
  route("POST", /^\/admin\/policies$/, ["ticketing", "office"], async (b) => app.catalog.publishPolicy(b));
  route("POST", /^\/admin\/spots$/, ["office"], async (b) =>
    app.catalog.registerSpot({
      spot_id: b.spot_id,
      name: b.name,
      windows: b.windows,
      remote_offline_allowed: b.remote_offline_allowed ?? false,
    }));
  route("POST", /^\/admin\/spots\/([^/]+)\/windows$/, ["office"], async (b, m) =>
    app.catalog.updateWindows(m[1], b.windows));
  route("POST", /^\/admin\/spots\/([^/]+)\/close$/, ["office"], async (b, m) =>
    app.catalog.closeSpot(m[1], b));
  route("POST", /^\/admin\/devices$/, ["office"], async (b) =>
    app.devices.registerDevice({ spot_id: b.spot_id, offline_quota: b.offline_quota ?? 0 }));
  route("POST", /^\/admin\/matches\/([^/]+)\/postpone$/, ["ticketing"], async (b, m) =>
    app.tickets.postponeMatch(m[1], b));

  route("POST", /^\/tickets$/, ["ticketing"], async (b) => app.tickets.confirmTicket(b));
  route("POST", /^\/tickets\/([^/]+)\/nominate$/, ["visitor", "ticketing"], async (b, m) =>
    app.tickets.nominateTicket(m[1], b));
  route("POST", /^\/tickets\/([^/]+)\/transfer$/, ["visitor", "ticketing"], async (b, m) =>
    app.tickets.transferTicket(m[1], b));
  route("POST", /^\/tickets\/([^/]+)\/refund$/, ["ticketing"], async (b, m) =>
    app.tickets.refundTicket(m[1], b));
  route("POST", /^\/tickets\/([^/]+)\/invalidate$/, ["ticketing"], async (b, m) =>
    app.tickets.invalidateTicket(m[1], b));

  // ---- 权益与钱包 ----
  route("POST", /^\/accounts\/([^/]+)\/companions$/, ["visitor"], async (b, m) =>
    app.benefits.linkCompanion(m[1], b));
  route("POST", /^\/accounts\/([^/]+)\/voucher$/, ["visitor"], async (b, m) => ({
    voucher: app.wallet.issueVoucher(m[1], { person_token: b.person_token }),
  }));

  // ---- 核销与离线同步 ----
  route("POST", /^\/devices\/([^/]+)\/redeem$/, ["spot"], async (b, m) =>
    app.redemption.redeemVoucher({ device_id: m[1], spot_id: b.spot_id, voucher: b.voucher, idempotency_key: b.idempotency_key }));
  route("POST", /^\/sync\/bundles$/, ["device-gateway"], async (b) => app.sync.syncBundle(b));

  // ---- 申诉 ----
  route("POST", /^\/appeals$/, ["visitor"], async (b) => app.appeals.fileAppeal(b));
  route("POST", /^\/appeals\/([^/]+)\/resolve$/, ["office"], async (b, m) =>
    app.appeals.resolveAppeal(m[1], b));

  // ---- 清算 ----
  route("POST", /^\/batches$/, ["clearing"], async (b) => ({ batch_id: app.clearing.openBatch(b) }));
  route("POST", /^\/batches\/([^/]+)\/settle$/, ["clearing"], async (b, m) =>
    app.clearing.settleBatch(m[1]));
  route("POST", /^\/batches\/([^/]+)\/close$/, ["clearing"], async (b, m) =>
    app.clearing.closeBatch(m[1], b));
  route("POST", /^\/entries\/([^/]+)\/reverse$/, ["clearing", "office"], async (b, m) =>
    app.clearing.reverseEntry(m[1], b));

  // ---- 视图与追溯 ----
  route("GET", /^\/views\/visitor$/, ["visitor", "office"], async (_b, _m, req) =>
    app.views.visitorView(new URL(req.url, "http://x").searchParams.get("token")));
  route("GET", /^\/views\/spot\/([^/]+)$/, ["spot", "office", "clearing"], async (_b, m) =>
    app.views.spotView(m[1]));
  route("GET", /^\/views\/clearing\/([^/]+)$/, ["clearing", "office"], async (_b, m) =>
    app.views.clearingView(m[1]));
  route("GET", /^\/audit\/entries\/([^/]+)$/, ["office"], async (_b, m) =>
    app.audit.traceEntry(m[1]));
  route("GET", /^\/audit\/batches\/([^/]+)$/, ["office"], async (_b, m) =>
    app.audit.traceBatch(m[1]));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : {};
      const role = req.headers["x-client-role"];
      const found = routes.find(
        (r) => r.method === req.method && r.pattern.test(url.pathname) && r.roles.includes(role),
      );
      if (!found) {
        const anyMatch = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        return send(res, anyMatch ? 403 : 404, { error: anyMatch ? "角色无权访问" : "未找到路由" });
      }
      const match = url.pathname.match(found.pattern);
      const data = await found.handler(body, match, req);
      send(res, 200, { ok: true, data });
    } catch (err) {
      send(res, 400, { ok: false, error: err.message });
    }
  });

  return { server, app };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const { server } = createServer();
  server.listen(port, () => console.log(`票根权益清算后端监听 :${port}`));
}
