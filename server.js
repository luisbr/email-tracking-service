import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const defaultAssetPath = String(process.env.EMAIL_TRACKING_ASSET_PATH || "/image/060926-Mailing2_01.png").trim();
const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3010", 10);
const adminUsername = process.env.ADMIN_USERNAME || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "";
const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const adminTimeZone = process.env.ADMIN_TIME_ZONE || "America/Mexico_City";
const sessionCookieName = "ets_admin";
const maxAdminPageSize = 200;

const TRACKING_PIXEL_BUFFER = Buffer.from(
  "R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number.parseInt(process.env.MYSQL_PORT || "3306", 10),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10
});

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie || "";
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const separatorIndex = cookie.indexOf("=");
        if (separatorIndex === -1) {
          return [cookie, ""];
        }

        return [
          decodeURIComponent(cookie.slice(0, separatorIndex)),
          decodeURIComponent(cookie.slice(separatorIndex + 1))
        ];
      })
  );
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signSessionPayload(payload) {
  return crypto.createHmac("sha256", adminSessionSecret).update(payload).digest("base64url");
}

function createSessionCookie(username) {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 12;
  const payload = Buffer.from(JSON.stringify({ username, expiresAt })).toString("base64url");
  const signature = signSessionPayload(payload);

  return `${sessionCookieName}=${encodeURIComponent(`${payload}.${signature}`)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`;
}

function clearSessionCookie() {
  return `${sessionCookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function getAdminSession(request) {
  const sessionValue = parseCookies(request)[sessionCookieName];
  if (!sessionValue || !sessionValue.includes(".")) {
    return null;
  }

  const [payload, signature] = sessionValue.split(".");
  if (!payload || !signature || !timingSafeEqualString(signature, signSessionPayload(payload))) {
    return null;
  }

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.username || Number(session.expiresAt) < Date.now()) {
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

function requireAdmin(request, response) {
  const session = getAdminSession(request);
  if (session) {
    return session;
  }

  if (request.url?.startsWith("/api/")) {
    sendJson(response, 401, { ok: false, error: "unauthorized" });
  } else {
    redirect(response, "/admin/login");
  }

  return null;
}

async function readFormBody(request) {
  const body = await readRawBody(request);
  return Object.fromEntries(new URLSearchParams(body));
}

async function readRawBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: adminTimeZone
  }).format(new Date(value));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function normalizeAssetPath(assetPath) {
  const normalized = String(assetPath || defaultAssetPath).trim();
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function createTrackingToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getClientIpAddress(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim().slice(0, 80);
  }

  return String(request.socket.remoteAddress || "").slice(0, 80);
}

function buildAbsoluteUrl(request, routePath, searchParams = {}) {
  const origin = process.env.EMAIL_TRACKING_BASE_URL || `http://${request.headers.host || `${host}:${port}`}`;
  const url = new URL(routePath, origin);

  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function readJsonBody(request) {
  const rawBody = (await readRawBody(request)).trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

async function createEmailTrackingLink({ email, campaign, assetPath, metadata }) {
  const token = createTrackingToken();
  const normalizedAssetPath = normalizeAssetPath(assetPath);
  const metadataJson = metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;

  const [result] = await pool.execute(
    `INSERT INTO email_tracking_links (
      token,
      email,
      campaign,
      asset_path,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?)`,
    [
      token,
      String(email).slice(0, 255),
      String(campaign).slice(0, 120),
      normalizedAssetPath.slice(0, 255),
      metadataJson
    ]
  );

  return {
    id: result.insertId,
    token,
    email,
    campaign,
    assetPath: normalizedAssetPath,
    metadata
  };
}

async function findEmailTrackingLinkByToken(token) {
  const [rows] = await pool.execute(
    `SELECT id, token, email, campaign, asset_path AS assetPath, metadata_json AS metadataJson,
            open_count AS openCount, last_opened_at AS lastOpenedAt, created_at AS createdAt
     FROM email_tracking_links
     WHERE token = ?
     LIMIT 1`,
    [token]
  );

  if (!rows[0]) {
    return null;
  }

  return rows[0];
}

async function registerEmailTrackingEvent(request, trackingLink, eventType) {
  await pool.execute(
    `INSERT INTO email_tracking_events (
      tracking_link_id,
      event_type,
      user_agent,
      ip_address,
      referer,
      query_string
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      trackingLink.id,
      eventType,
      String(request.headers["user-agent"] || "").slice(0, 500) || null,
      getClientIpAddress(request) || null,
      String(request.headers.referer || request.headers.referrer || "").slice(0, 500) || null,
      String(new URL(request.url, "http://localhost").search || "").slice(0, 1000) || null
    ]
  );

  await pool.execute(
    `UPDATE email_tracking_links
     SET open_count = open_count + 1,
         last_opened_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [trackingLink.id]
  );
}

function buildAdminFilters(searchParams) {
  const where = [];
  const params = [];
  const query = String(searchParams.get("q") || "").trim();
  const campaign = String(searchParams.get("campaign") || "").trim();

  if (query) {
    where.push("(email LIKE ? OR token LIKE ?)");
    params.push(`%${query}%`, `%${query}%`);
  }

  if (campaign) {
    where.push("campaign = ?");
    params.push(campaign);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params,
    query,
    campaign
  };
}

async function listEmailTrackingLinksPage(searchParams) {
  const page = clampInteger(searchParams.get("page"), 1, 1, 100000);
  const limit = clampInteger(searchParams.get("limit"), 50, 1, maxAdminPageSize);
  const offset = (page - 1) * limit;
  const filters = buildAdminFilters(searchParams);

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM email_tracking_links ${filters.whereSql}`,
    filters.params
  );

  const [rows] = await pool.execute(
    `SELECT
       links.id,
       links.email,
       links.campaign,
       links.token,
       links.asset_path AS assetPath,
       links.open_count AS openCount,
       links.last_opened_at AS lastOpenedAt,
       links.created_at AS createdAt,
       latest.event_type AS latestEventType,
       latest.created_at AS latestEventAt
     FROM email_tracking_links links
     LEFT JOIN email_tracking_events latest
       ON latest.id = (
         SELECT events.id
         FROM email_tracking_events events
         WHERE events.tracking_link_id = links.id
         ORDER BY events.created_at DESC, events.id DESC
         LIMIT 1
       )
     ${filters.whereSql}
     ORDER BY links.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    filters.params
  );

  return {
    page,
    limit,
    total: Number(countRows[0]?.total || 0),
    rows: rows.map((row) => ({
      ...row,
      createdAtText: formatDateTime(row.createdAt),
      lastOpenedAtText: formatDateTime(row.lastOpenedAt),
      latestEventAtText: formatDateTime(row.latestEventAt)
    }))
  };
}

async function listEmailTrackingEventsForLink(linkId) {
  const [rows] = await pool.execute(
    `SELECT id, event_type AS eventType, user_agent AS userAgent,
            ip_address AS ipAddress, referer, query_string AS queryString,
            created_at AS createdAt
     FROM email_tracking_events
     WHERE tracking_link_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 500`,
    [linkId]
  );

  return rows.map((row) => ({
    ...row,
    createdAtText: formatDateTime(row.createdAt)
  }));
}

async function listEmailTrackingLinksForExport(searchParams) {
  const filters = buildAdminFilters(searchParams);
  const [rows] = await pool.execute(
    `SELECT id, email, campaign, open_count AS openCount, created_at AS createdAt,
            (
              SELECT MIN(events.created_at)
              FROM email_tracking_events events
              WHERE events.tracking_link_id = email_tracking_links.id
            ) AS firstOpenedAt
     FROM email_tracking_links
     ${filters.whereSql}
     ORDER BY firstOpenedAt IS NULL ASC, firstOpenedAt DESC, created_at DESC`,
    filters.params
  );

  return rows;
}

async function handleCreateTrackingLink(request, response) {
  try {
    const body = await readJsonBody(request);
    const email = String(body.email || "").trim();
    const campaign = String(body.campaign || "").trim();

    if (!email || !campaign) {
      return sendJson(response, 400, {
        ok: false,
        error: "email and campaign are required"
      });
    }

    const trackingLink = await createEmailTrackingLink({
      email,
      campaign,
      assetPath: body.assetPath,
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : null
    });

    return sendJson(response, 201, {
      ok: true,
      token: trackingLink.token,
      imageUrl: buildAbsoluteUrl(request, "/api/email-tracking/image", { token: trackingLink.token }),
      pixelUrl: buildAbsoluteUrl(request, "/api/email-tracking/open.gif", { token: trackingLink.token }),
      assetPath: trackingLink.assetPath
    });
  } catch (error) {
    console.error("tracking link error", error);
    return sendJson(response, 500, { ok: false, error: "internal server error" });
  }
}

async function handleTrackingPixel(request, response) {
  try {
    const requestUrl = new URL(request.url, "http://localhost");
    const token = String(requestUrl.searchParams.get("token") || "").trim();
    const trackingLink = token ? await findEmailTrackingLinkByToken(token) : null;

    if (trackingLink) {
      await registerEmailTrackingEvent(request, trackingLink, "pixel_open");
    }
  } catch (error) {
    console.error("tracking pixel error", error);
  }

  response.writeHead(200, {
    "Content-Type": "image/gif",
    "Content-Length": TRACKING_PIXEL_BUFFER.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0"
  });
  response.end(TRACKING_PIXEL_BUFFER);
}

async function handleTrackingImage(request, response) {
  try {
    const requestUrl = new URL(request.url, "http://localhost");
    const token = String(requestUrl.searchParams.get("token") || "").trim();
    const trackingLink = token ? await findEmailTrackingLinkByToken(token) : null;

    if (!trackingLink) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    await registerEmailTrackingEvent(request, trackingLink, "image_open");

    const filePath = path.join(publicDir, trackingLink.assetPath.replace(/^\/+/, ""));
    const fileBuffer = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const contentType = extension === ".png" ? "image/png" : "application/octet-stream";

    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": fileBuffer.length,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0"
    });
    response.end(fileBuffer);
  } catch (error) {
    console.error("tracking image error", error);
    response.writeHead(500);
    response.end("Internal server error");
  }
}

function renderLoginPage(errorMessage = "") {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Email Tracking Admin</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7fb; color: #18212f; }
    main { width: min(420px, calc(100vw - 32px)); background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 28px; box-shadow: 0 18px 45px rgba(30, 41, 59, 0.08); }
    h1 { margin: 0 0 20px; font-size: 22px; line-height: 1.2; }
    label { display: grid; gap: 8px; margin: 14px 0; font-size: 13px; font-weight: 650; color: #334155; }
    input { height: 42px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 0 12px; font: inherit; }
    button { width: 100%; height: 42px; margin-top: 10px; border: 0; border-radius: 6px; background: #1463ff; color: white; font: inherit; font-weight: 700; cursor: pointer; }
    .error { margin: 0 0 12px; color: #b42318; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>Email Tracking Admin</h1>
    ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
    <form method="post" action="/admin/login">
      <label>Usuario <input name="username" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`;
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Email Tracking Admin</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f8fb; color: #172033; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 24px; background: #fff; border-bottom: 1px solid #dce3ed; position: sticky; top: 0; z-index: 2; }
    h1 { margin: 0; font-size: 19px; line-height: 1.2; }
    main { padding: 20px 24px 32px; }
    .toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(160px, 240px) auto auto; gap: 10px; align-items: end; margin-bottom: 14px; }
    label { display: grid; gap: 6px; font-size: 12px; font-weight: 700; color: #42526b; }
    input, select { height: 38px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 0 10px; font: inherit; background: #fff; }
    button, a.button { height: 38px; border: 0; border-radius: 6px; background: #1463ff; color: #fff; font: inherit; font-weight: 700; padding: 0 14px; display: inline-flex; align-items: center; justify-content: center; text-decoration: none; cursor: pointer; white-space: nowrap; }
    button.secondary, a.secondary { background: #eef2f7; color: #172033; border: 1px solid #cbd5e1; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dce3ed; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 11px; text-align: left; border-bottom: 1px solid #e8edf4; font-size: 13px; vertical-align: top; }
    th { background: #f9fbfd; color: #42526b; font-size: 12px; }
    tr:last-child td { border-bottom: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    .muted { color: #667085; }
    .pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
    .events { margin-top: 18px; }
    .events h2 { font-size: 16px; margin: 0 0 10px; }
    .empty { padding: 22px; text-align: center; color: #667085; background: #fff; border: 1px solid #dce3ed; border-radius: 8px; }
    .danger { background: #fff; color: #b42318; border: 1px solid #f0b8b0; }
    @media (max-width: 820px) {
      header { align-items: flex-start; }
      main { padding: 16px; }
      .toolbar { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Email Tracking Admin</h1>
    <form method="post" action="/admin/logout"><button class="danger" type="submit">Salir</button></form>
  </header>
  <main>
    <form class="toolbar" id="filters">
      <label>Buscar <input id="q" name="q" placeholder="email o token"></label>
      <label>Campaña <input id="campaign" name="campaign" placeholder="campaña"></label>
      <button type="submit">Filtrar</button>
      <a class="button secondary" id="exportLink" href="/api/email-tracking/export">Exportar Excel</a>
    </form>
    <div id="summary" class="muted"></div>
    <div id="table"></div>
    <div class="pager">
      <button class="secondary" id="prev" type="button">Anterior</button>
      <span id="pageInfo" class="muted"></span>
      <button class="secondary" id="next" type="button">Siguiente</button>
    </div>
    <section class="events" id="events"></section>
  </main>
  <script>
    let page = 1;
    const limit = 50;
    const state = { q: "", campaign: "" };
    const table = document.querySelector("#table");
    const events = document.querySelector("#events");
    const summary = document.querySelector("#summary");
    const pageInfo = document.querySelector("#pageInfo");
    const exportLink = document.querySelector("#exportLink");

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      }[char]));
    }

    function params(extra = {}) {
      const searchParams = new URLSearchParams({ page, limit, ...extra });
      if (state.q) searchParams.set("q", state.q);
      if (state.campaign) searchParams.set("campaign", state.campaign);
      return searchParams;
    }

    async function loadLinks() {
      table.innerHTML = '<div class="empty">Cargando...</div>';
      const response = await fetch("/api/admin/links?" + params());
      if (!response.ok) {
        location.href = "/admin/login";
        return;
      }
      const data = await response.json();
      const totalPages = Math.max(1, Math.ceil(data.total / data.limit));
      summary.textContent = data.total + " envíos encontrados";
      pageInfo.textContent = "Página " + data.page + " de " + totalPages;
      document.querySelector("#prev").disabled = data.page <= 1;
      document.querySelector("#next").disabled = data.page >= totalPages;
      const exportParams = params({ page: undefined, limit: undefined });
      exportParams.delete("page");
      exportParams.delete("limit");
      exportLink.href = "/api/email-tracking/export" + (exportParams.toString() ? "?" + exportParams : "");

      if (!data.rows.length) {
        table.innerHTML = '<div class="empty">Sin envíos</div>';
        events.innerHTML = "";
        return;
      }

      table.innerHTML = '<table><thead><tr><th>Email</th><th>Campaña</th><th>Aperturas</th><th>Última apertura</th><th>Último evento</th><th>Creado</th><th>Token</th><th></th></tr></thead><tbody>' +
        data.rows.map((row) => '<tr>' +
          '<td>' + escapeHtml(row.email) + '</td>' +
          '<td>' + escapeHtml(row.campaign) + '</td>' +
          '<td>' + Number(row.openCount || 0) + '</td>' +
          '<td>' + escapeHtml(row.lastOpenedAtText || "") + '</td>' +
          '<td>' + escapeHtml(row.latestEventType || "") + '<br><span class="muted">' + escapeHtml(row.latestEventAtText || "") + '</span></td>' +
          '<td>' + escapeHtml(row.createdAtText || "") + '</td>' +
          '<td><code>' + escapeHtml(row.token) + '</code></td>' +
          '<td><button class="secondary" type="button" data-link-id="' + row.id + '">Eventos</button></td>' +
        '</tr>').join("") +
        '</tbody></table>';

      table.querySelectorAll("[data-link-id]").forEach((button) => {
        button.addEventListener("click", () => loadEvents(button.dataset.linkId));
      });
    }

    async function loadEvents(linkId) {
      events.innerHTML = '<div class="empty">Cargando eventos...</div>';
      const response = await fetch("/api/admin/links/" + encodeURIComponent(linkId) + "/events");
      const data = await response.json();
      if (!data.rows.length) {
        events.innerHTML = '<div class="empty">Este envío todavía no tiene eventos</div>';
        return;
      }
      events.innerHTML = '<h2>Eventos del envío</h2><table><thead><tr><th>Tipo</th><th>IP</th><th>Referer</th><th>User Agent</th><th>Fecha y hora</th></tr></thead><tbody>' +
        data.rows.map((row) => '<tr>' +
          '<td>' + escapeHtml(row.eventType) + '</td>' +
          '<td>' + escapeHtml(row.ipAddress || "") + '</td>' +
          '<td>' + escapeHtml(row.referer || "") + '</td>' +
          '<td>' + escapeHtml(row.userAgent || "") + '</td>' +
          '<td>' + escapeHtml(row.createdAtText || "") + '</td>' +
        '</tr>').join("") +
        '</tbody></table>';
    }

    document.querySelector("#filters").addEventListener("submit", (event) => {
      event.preventDefault();
      state.q = document.querySelector("#q").value.trim();
      state.campaign = document.querySelector("#campaign").value.trim();
      page = 1;
      loadLinks();
    });
    document.querySelector("#prev").addEventListener("click", () => { page = Math.max(1, page - 1); loadLinks(); });
    document.querySelector("#next").addEventListener("click", () => { page += 1; loadLinks(); });
    loadLinks();
  </script>
</body>
</html>`;
}

async function handleAdminLogin(request, response) {
  const form = await readFormBody(request);
  const username = String(form.username || "");
  const password = String(form.password || "");

  if (
    adminPassword &&
    timingSafeEqualString(username, adminUsername) &&
    timingSafeEqualString(password, adminPassword)
  ) {
    response.writeHead(302, {
      Location: "/admin",
      "Set-Cookie": createSessionCookie(username)
    });
    response.end();
    return;
  }

  sendHtml(response, 401, renderLoginPage("Usuario o password inválidos"));
}

async function handleAdminLinks(request, response) {
  const requestUrl = new URL(request.url, "http://localhost");
  const pageData = await listEmailTrackingLinksPage(requestUrl.searchParams);
  sendJson(response, 200, { ok: true, ...pageData });
}

async function handleAdminEvents(request, response, linkId) {
  const rows = await listEmailTrackingEventsForLink(linkId);
  sendJson(response, 200, { ok: true, rows });
}

async function handleExport(request, response) {
  try {
    const requestUrl = new URL(request.url, "http://localhost");
    const links = await listEmailTrackingLinksForExport(requestUrl.searchParams);

    response.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="email-tracking-${Date.now()}.xlsx"`,
      "Cache-Control": "no-store"
    });

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: response,
      useStyles: true,
      useSharedStrings: true
    });

    const summaryByCampaign = new Map();
    links.forEach((row) => {
      const campaignSummary = summaryByCampaign.get(row.campaign) || {
        campaign: row.campaign,
        totalEmails: 0,
        openedEmails: 0,
        totalOpens: 0
      };

      campaignSummary.totalEmails += 1;
      campaignSummary.totalOpens += Number(row.openCount || 0);
      if (Number(row.openCount || 0) > 0) {
        campaignSummary.openedEmails += 1;
      }

      summaryByCampaign.set(row.campaign, campaignSummary);
    });

    const summarySheet = workbook.addWorksheet("Resumen");
    summarySheet.columns = [
      { header: "Campaña", key: "campaign", width: 28 },
      { header: "Total emails", key: "totalEmails", width: 16 },
      { header: "Emails abiertos", key: "openedEmails", width: 18 },
      { header: "Numero total de aperturas", key: "totalOpens", width: 24 },
      { header: "Tasa de apertura", key: "openRate", width: 18 }
    ];

    [...summaryByCampaign.values()]
      .sort((left, right) => right.openedEmails - left.openedEmails || right.totalOpens - left.totalOpens)
      .forEach((row) => {
        summarySheet.addRow({
          ...row,
          openRate: row.totalEmails > 0 ? `${((row.openedEmails / row.totalEmails) * 100).toFixed(2)}%` : "0.00%"
        }).commit();
      });
    summarySheet.commit();

    const detailSheet = workbook.addWorksheet("Detalle");
    detailSheet.columns = [
      { header: "Email", key: "email", width: 32 },
      { header: "Campaña", key: "campaign", width: 28 },
      { header: "Numero de aperturas", key: "openCount", width: 20 },
      { header: "Fecha primer apertura", key: "firstOpenedAtText", width: 28 }
    ];

    links.forEach((row) => {
      detailSheet.addRow({
        ...row,
        firstOpenedAtText: formatDateTime(row.firstOpenedAt)
      }).commit();
    });
    detailSheet.commit();

    await workbook.commit();
  } catch (error) {
    console.error("tracking export error", error);
    if (!response.headersSent) {
      response.writeHead(500);
      response.end("Internal server error");
    } else {
      response.end();
    }
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  const requestUrl = new URL(request.url, "http://localhost");

  if (request.method === "GET" && request.url === "/health") {
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && requestUrl.pathname === "/") {
    return redirect(response, "/admin");
  }

  if (request.method === "GET" && requestUrl.pathname === "/admin/login") {
    if (getAdminSession(request)) {
      return redirect(response, "/admin");
    }

    return sendHtml(response, 200, renderLoginPage());
  }

  if (request.method === "POST" && requestUrl.pathname === "/admin/login") {
    return handleAdminLogin(request, response);
  }

  if (request.method === "POST" && requestUrl.pathname === "/admin/logout") {
    response.writeHead(302, {
      Location: "/admin/login",
      "Set-Cookie": clearSessionCookie()
    });
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/admin") {
    if (!requireAdmin(request, response)) {
      return;
    }

    return sendHtml(response, 200, renderAdminPage());
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/admin/links") {
    if (!requireAdmin(request, response)) {
      return;
    }

    return handleAdminLinks(request, response);
  }

  const eventsMatch = requestUrl.pathname.match(/^\/api\/admin\/links\/(\d+)\/events$/);
  if (request.method === "GET" && eventsMatch) {
    if (!requireAdmin(request, response)) {
      return;
    }

    return handleAdminEvents(request, response, Number(eventsMatch[1]));
  }

  if (request.method === "POST" && request.url === "/api/email-tracking/link") {
    return handleCreateTrackingLink(request, response);
  }

  if (request.method === "GET" && request.url.startsWith("/api/email-tracking/open.gif")) {
    return handleTrackingPixel(request, response);
  }

  if (request.method === "GET" && request.url.startsWith("/api/email-tracking/image")) {
    return handleTrackingImage(request, response);
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/email-tracking/export") {
    if (!requireAdmin(request, response)) {
      return;
    }

    return handleExport(request, response);
  }

  response.writeHead(404);
  response.end("Not found");
});

server.listen(port, host, () => {
  console.log(`Tracking service listening on http://${host}:${port}`);
});
