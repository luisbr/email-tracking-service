import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import mysql from "mysql2/promise";
import { createPlatformRepository } from "./src/platform-repository.js";
import { encryptSecret, renderTemplate, sendWithSes, uploadAssetToS3 } from "./src/platform-services.js";
import { reviseTemplateWithAi } from "./src/template-agent.js";

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
const platformDefaultAccountId = process.env.PLATFORM_DEFAULT_ACCOUNT_ID || "";
const platformDefaultAccountName = process.env.PLATFORM_DEFAULT_ACCOUNT_NAME || "LBR";
const platformEncryptionKey = process.env.PLATFORM_ENCRYPTION_KEY || "";

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
const platformRepository = createPlatformRepository(pool);
let platformAccountPromise;

function getPlatformAccount() {
  platformAccountPromise ||= platformRepository.resolveDefaultAccount(platformDefaultAccountId, platformDefaultAccountName);
  return platformAccountPromise;
}

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

function createSessionCookie(session) {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 12;
  const payload = Buffer.from(JSON.stringify({ ...session, expiresAt })).toString("base64url");
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

function hashPlatformPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const digest = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${digest}`;
}

function verifyPlatformPassword(password, passwordHash) {
  const [scheme, salt, expected] = String(passwordHash || "").split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("base64url");
  return timingSafeEqualString(actual, expected);
}

function isPlatformAdmin(session) {
  return session?.role === "admin";
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

function renderLegacyLoginPage(errorMessage = "") {
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

function renderLegacyAdminPage() {
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

function renderLegacyPlatformPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email Campaign Platform</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#15211b;background:#f7f7f4}*{box-sizing:border-box}body{margin:0}.shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh}.sidebar{background:#15211b;color:#edf3eb;padding:24px 16px}.brand{font-weight:800;font-size:18px;margin:0 8px 30px}.nav a{display:block;color:#cbd8cf;text-decoration:none;padding:9px 10px;border-radius:5px}.nav a:hover,.nav a.active{background:#244331;color:#fff}.content{max-width:1250px;width:100%;margin:0 auto;padding:28px}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #d9ded8;padding-bottom:18px}.top h1{font-size:24px;margin:0}.top a{color:#2463a5}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:20px}.panel{background:#fff;border:1px solid #d9ded8;border-radius:7px;padding:16px}.panel h2{font-size:16px;margin:0 0 12px}.panel p{color:#5c695f;font-size:13px}.panel form{display:grid;gap:8px}.panel input,.panel select,.panel textarea{width:100%;border:1px solid #bfc8c1;border-radius:5px;padding:9px;font:inherit;background:#fff}.panel textarea{min-height:80px}button{border:0;border-radius:5px;background:#167a54;color:#fff;padding:9px 12px;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#116443}.list{margin:0;padding:0;list-style:none;max-height:220px;overflow:auto}.list li{border-top:1px solid #edf0eb;padding:9px 0;font-size:13px}.muted{color:#69756d}.notice{margin-top:16px;padding:10px 12px;background:#e8f3ed;border-left:3px solid #167a54;font-size:13px}.wide{grid-column:span 3}@media(max-width:850px){.shell{grid-template-columns:1fr}.sidebar{display:flex;align-items:center;gap:16px;padding:14px}.brand{margin:0}.nav{display:flex;gap:4px}.content{padding:18px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}}</style></head><body><div class="shell"><aside class="sidebar"><p class="brand">Email Campaign Platform</p><nav class="nav"><a class="active" href="/platform">Operación</a><a href="/admin">Tracking</a></nav></aside><main class="content"><div class="top"><div><h1>Operación de campañas</h1><span class="muted">Clientes, audiencias, contenido y envíos</span></div><a href="/admin">Ver tracking histórico</a></div><div id="notice" class="notice">Cargando datos de plataforma...</div><section class="grid"><article class="panel"><h2>Clientes</h2><form id="clientForm"><input name="name" placeholder="Nombre del cliente" required><button>Crear cliente</button></form><ul id="clients" class="list"></ul></article><article class="panel"><h2>Audiencias</h2><form id="audienceForm"><select name="clientId" class="clientSelect" required></select><input name="name" placeholder="Nombre de audiencia" required><button>Crear audiencia</button></form><ul id="audiences" class="list"></ul></article><article class="panel"><h2>Templates</h2><form id="templateForm"><select name="clientId" class="clientSelect" required></select><input name="name" placeholder="Nombre del template" required><input name="subject" placeholder="Subject"><textarea name="html" placeholder="HTML compatible con email" required></textarea><button>Crear template</button></form><ul id="templates" class="list"></ul></article><article class="panel wide"><h2>Nueva campaña</h2><form id="campaignForm"><select name="clientId" class="clientSelect" required></select><input name="name" placeholder="Nombre de campaña" required><input name="subject" placeholder="Subject"><input name="audienceId" type="number" placeholder="ID de audiencia"><input name="templateVersionId" type="number" placeholder="ID de versión de template"><input name="sesAccountId" type="number" placeholder="ID de perfil SES"><button>Crear campaña</button></form><ul id="campaigns" class="list"></ul></article></section></main></div><script>
  const notice=document.querySelector('#notice');document.querySelectorAll('a[href="/admin"]').forEach((link)=>link.href='/admin/tracking');let clients=[];
  async function api(path,options={}){const r=await fetch(path,{headers:{'Content-Type':'application/json'},...options});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'No se pudo completar la operación');return d}
  function optionClients(){document.querySelectorAll('.clientSelect').forEach(s=>{const current=s.value;s.innerHTML='<option value="">Seleccionar cliente</option>'+clients.map(c=>'<option value="'+c.id+'">'+c.name+'</option>').join('');s.value=current})}
  function list(id,rows,format){document.querySelector(id).innerHTML=rows.length?rows.map(format).join(''):'<li class="muted">Sin registros</li>'}
  async function load(){try{const [c,a,t,ca]=await Promise.all(['/api/platform/clients','/api/platform/audiences','/api/platform/templates','/api/platform/campaigns'].map(api));clients=c.rows;optionClients();list('#clients',c.rows,x=>'<li><strong>'+x.name+'</strong><br><span class="muted">'+x.slug+'</span></li>');list('#audiences',a.rows,x=>'<li><strong>'+x.name+'</strong><br><span class="muted">'+x.totalContacts+' contactos · ID '+x.id+'</span></li>');list('#templates',t.rows,x=>'<li><strong>'+x.name+'</strong><br><span class="muted">v'+(x.latestVersion||0)+' · ID '+x.id+'</span></li>');list('#campaigns',ca.rows,x=>'<li><strong>'+x.name+'</strong><br><span class="muted">'+x.status+' · audiencia '+(x.audienceId||'—')+' · versión '+(x.templateVersionId||'—')+'</span></li>');notice.textContent='Datos actualizados.'}catch(e){notice.textContent=e.message}}
  function form(id,path){document.querySelector(id).addEventListener('submit',async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));for(const k of ['clientId','audienceId','templateVersionId','sesAccountId'])if(values[k])values[k]=Number(values[k]);try{await api(path,{method:'POST',body:JSON.stringify(values)});e.target.reset();notice.textContent='Guardado.';load()}catch(err){notice.textContent=err.message}})}form('#clientForm','/api/platform/clients');form('#audienceForm','/api/platform/audiences');form('#templateForm','/api/platform/templates');form('#campaignForm','/api/platform/campaigns');load();
  </script></body></html>`;
}

function renderHululLogo(className = "brand-logo") {
  return `<img class="${className}" src="/brand/hulul-logo.png" alt="HULUL">`;
}

function renderLoginPage(errorMessage = "") {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acceso | HULUL Campaigns</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#f4f6fb;background:#0b0b12}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 86% 13%,rgba(123,77,255,.28),transparent 26%),radial-gradient(circle at 5% 92%,rgba(211,93,255,.18),transparent 24%),linear-gradient(135deg,#0b0b12,#12131c 55%,#17122b);display:grid;place-items:center;padding:28px}.login{width:min(440px,100%);position:relative}.brand{display:flex;justify-content:center;margin-bottom:35px}.brand img{width:156px;height:auto;filter:grayscale(1) brightness(6)}.tag{margin:12px 0 0;color:#b7b9cf;text-align:center;font-size:11px;letter-spacing:2px}.card{padding:34px;border-radius:20px;border:1px solid rgba(183,140,255,.42);background:linear-gradient(160deg,rgba(36,41,56,.84),rgba(18,19,28,.93));box-shadow:0 24px 70px rgba(0,0,0,.42),0 0 45px rgba(123,77,255,.14)}h1{font-size:28px;margin:0 0 8px;letter-spacing:0}p{margin:0;color:#aeb3c7;line-height:1.5}.error{margin:20px 0 0;padding:11px 13px;color:#ffd7dd;background:rgba(255,91,115,.12);border:1px solid rgba(255,91,115,.34);border-radius:9px;font-size:14px}form{display:grid;gap:18px;margin-top:28px}label{display:grid;gap:8px;color:#dfe2ef;font-size:13px;font-weight:600}input{width:100%;height:48px;border-radius:9px;border:1px solid #3c4057;background:#171925;color:#fff;padding:0 14px;font:inherit;outline:none}input:focus{border-color:#925cff;box-shadow:0 0 0 3px rgba(123,77,255,.18)}button{height:50px;border:0;border-radius:9px;background:linear-gradient(135deg,#7b4dff,#925cff);color:#fff;font:inherit;font-weight:700;font-size:15px;cursor:pointer;box-shadow:0 10px 24px rgba(123,77,255,.25)}button:hover{filter:brightness(1.1)}.footer{margin-top:22px;text-align:center;color:#777e97;font-size:12px}@media(max-width:480px){body{padding:18px}.card{padding:26px 22px}}
  </style></head><body><main class="login"><div class="brand">${renderHululLogo()}</div><p class="tag">CAMPAIGNS · DATOS · ESTRATEGIA</p><section class="card"><h1>Accede a tu cuenta</h1><p>Gestiona campañas, audiencias y resultados desde un solo lugar.</p>${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ""}<form method="post" action="/admin/login"><label>Usuario<input name="username" autocomplete="username" required></label><label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Iniciar sesión</button></form></section><p class="footer">HULUL · Capital inteligente para un mayor mañana</p></main></body></html>`;
}

function renderPlatformPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Campañas | HULUL</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#f4f6fb;background:#0b0b12}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 70% -10%,rgba(123,77,255,.15),transparent 36%),#0b0b12;min-height:100vh}.app{display:grid;grid-template-columns:244px 1fr;min-height:100vh}.side{position:sticky;top:0;height:100vh;padding:26px 14px;border-right:1px solid rgba(255,255,255,.07);background:rgba(13,14,23,.9)}.side .brand{display:block;width:112px;height:auto;margin:0 12px 34px;filter:grayscale(1) brightness(6)}.nav{display:grid;gap:4px}.nav-label{display:block;margin:17px 12px 6px;color:#777e97;font-size:10px;font-weight:700;letter-spacing:1.3px}.nav-label:first-child{margin-top:0}.nav button{display:flex;align-items:center;width:100%;height:42px;padding:0 13px;border:0;border-radius:8px;background:transparent;color:#9da4b9;text-align:left;font:inherit;cursor:pointer}.nav button:hover,.nav button.active{color:#fff;background:rgba(123,77,255,.17);box-shadow:inset 2px 0 #925cff}.nav .tracking{margin-top:18px;border-top:1px solid rgba(255,255,255,.08);padding-top:18px}.account{position:absolute;bottom:22px;left:26px;color:#777e97;font-size:12px}.main{padding:32px min(5vw,70px);max-width:1550px;width:100%;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:30px}.top h1{margin:0;font-size:28px;letter-spacing:0}.top p{margin:7px 0 0;color:#9da4b9}.primary{height:42px;border:0;border-radius:8px;padding:0 16px;background:linear-gradient(135deg,#7b4dff,#925cff);color:white;font:inherit;font-weight:700;cursor:pointer;box-shadow:0 10px 26px rgba(123,77,255,.22)}.primary:hover{filter:brightness(1.1)}.overview{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.metric,.panel{border:1px solid rgba(255,255,255,.08);background:linear-gradient(145deg,rgba(36,41,56,.8),rgba(18,19,28,.88));border-radius:14px}.metric{padding:18px}.metric span{display:block;color:#a3a9be;font-size:13px}.metric strong{display:block;font-size:27px;margin-top:10px}.metric small{display:block;margin-top:8px;color:#29c77a}.workspace{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,.75fr);gap:16px;margin-top:18px}.panel{padding:20px}.panel h2{margin:0;font-size:17px}.panel>p{margin:7px 0 18px;color:#9da4b9;font-size:14px}.empty{padding:44px 8px;text-align:center;color:#a3a9be}.empty strong{display:block;color:#f4f6fb;font-size:16px;margin-bottom:6px}.activity{display:grid;gap:14px}.activity div{padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,.07)}.activity div:last-child{border:0;padding:0}.activity b{display:block;font-size:14px}.activity span{display:block;color:#9da4b9;font-size:12px;margin-top:5px}.view{display:none}.view.active{display:block}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.form-grid .full{grid-column:1/-1}label{display:grid;gap:7px;color:#d7daea;font-size:13px;font-weight:600}input,select,textarea{min-height:43px;border:1px solid #34394f;border-radius:8px;background:#151824;color:#f4f6fb;padding:10px 12px;font:inherit;outline:0}textarea{min-height:135px;resize:vertical}input:focus,select:focus,textarea:focus{border-color:#925cff;box-shadow:0 0 0 3px rgba(123,77,255,.16)}.table{width:100%;border-collapse:collapse;margin-top:18px}.table th,.table td{padding:12px 8px;border-bottom:1px solid rgba(255,255,255,.07);text-align:left;font-size:13px}.table th{color:#8c92a8;font-weight:600}.badge{display:inline-block;padding:4px 8px;border-radius:99px;background:rgba(123,77,255,.16);color:#c8b5ff;font-size:12px}.notice{min-height:20px;color:#29c77a;font-size:13px}.secondary{background:#222634;border:1px solid #3a4054;color:#e9ecf7;box-shadow:none}.secondary:hover{background:#2c3141}.form-actions{display:flex;gap:10px;align-items:center;margin-top:6px}@media(max-width:920px){.app{grid-template-columns:1fr}.side{position:static;height:auto;display:flex;align-items:center;gap:16px;padding:16px}.side .brand{margin:0;width:88px}.nav{display:flex;overflow:auto;flex:1}.nav-label{display:none}.nav button{width:auto;white-space:nowrap}.nav .tracking{margin:0;padding:0;border:0}.account{display:none}.main{padding:24px 18px}.overview,.workspace{grid-template-columns:1fr 1fr}.workspace .panel:first-child{grid-column:span 2}}@media(max-width:600px){.top{align-items:flex-start;flex-direction:column}.overview,.workspace{grid-template-columns:1fr}.workspace .panel:first-child{grid-column:auto}.form-grid{grid-template-columns:1fr}}
  </style></head><body><div class="app"><aside class="side">${renderHululLogo("brand")}<nav class="nav"><button class="active" data-view="overview">Resumen</button><button data-view="campaigns">Campañas</button><button data-view="audiences">Audiencias</button><button data-view="templates">Templates</button><button data-view="assets">Assets</button><button data-view="settings">Configuración SES</button><button class="tracking" data-view="tracking">Tracking</button></nav><span class="account">HULUL Campaigns</span></aside><main class="main"><header class="top"><div><h1 id="pageTitle">Resumen</h1><p id="pageCopy">Estado operativo de tus campañas.</p></div><button class="primary" id="newAction">Crear campaña</button></header><div id="notice" class="notice"></div>
  <section class="view active" id="overview"><div class="overview"><article class="metric"><span>Campañas</span><strong id="campaignCount">—</strong><small>En tu cuenta</small></article><article class="metric"><span>Audiencias</span><strong id="audienceCount">—</strong><small>Listas para usar</small></article><article class="metric"><span>Templates</span><strong id="templateCount">—</strong><small>Contenido versionado</small></article><article class="metric"><span>Destinatarios</span><strong id="contactCount">—</strong><small>Contactos activos</small></article></div><div class="workspace"><article class="panel"><h2>Campañas recientes</h2><p>Lo que está listo para revisar o enviar.</p><div id="recentCampaigns" class="empty"><strong>Aún no hay campañas</strong>Crea una campaña cuando ya tengas audiencia y template.</div></article><aside class="panel"><h2>Siguiente paso</h2><p>Prepara el flujo en este orden.</p><div class="activity"><div><b>1. Crea un cliente</b><span>Define la marca que envía.</span></div><div><b>2. Importa una audiencia</b><span>La base queda guardada y reutilizable.</span></div><div><b>3. Versiona el contenido</b><span>Conecta un template a tu campaña.</span></div></div></aside></div></section>
  <section class="view" id="campaigns"><article class="panel"><h2>Nueva campaña</h2><p>Una campaña reúne audiencia, contenido y perfil de envío.</p><form id="campaignForm" class="form-grid"><label>Cliente<select name="clientId" class="clientSelect" required></select></label><label>Nombre<input name="name" required placeholder="Ej. Lanzamiento octubre"></label><label>Asunto<input name="subject" placeholder="Asunto del correo"></label><label>Audiencia<select name="audienceId" id="audienceSelect"><option value="">Seleccionar después</option></select></label><label>Versión de template<select name="templateVersionId" id="templateVersionSelect"><option value="">Seleccionar después</option></select></label><label>Perfil SES<select name="sesAccountId" id="sesSelect"><option value="">Seleccionar después</option></select></label><div class="full form-actions"><button class="primary">Crear campaña</button></div></form><table class="table"><thead><tr><th>Campaña</th><th>Cliente</th><th>Estado</th><th>Audiencia</th></tr></thead><tbody id="campaignRows"></tbody></table></article><article class="panel" style="margin-top:20px"><h2>Enviar campaña</h2><p>Envía una prueba primero. Una vez aprobada, podrás iniciar el envío a su audiencia.</p><div class="form-grid"><label>Campaña<select id="deliveryCampaign"><option value="">Selecciona una campaña</option></select></label><label>Correo de prueba<input id="deliveryTestEmail" type="email" placeholder="nombre@dominio.com"></label><div class="full form-actions"><button type="button" id="sendTestButton">Enviar prueba</button><button type="button" id="approveCampaignButton">Aprobar campaña</button><button type="button" class="primary" id="sendCampaignButton">Enviar a audiencia</button><span class="notice" id="deliveryResult"></span></div></div></article></section>
  <script>fetch('/api/platform/ses-accounts').then(response=>response.ok?response.json():Promise.reject()).then(data=>{const select=document.querySelector('#sesSelect');select.innerHTML='<option value="">Seleccionar después</option>'+data.rows.map(profile=>'<option value="'+profile.id+'">'+profile.name+' · '+profile.defaultFromEmail+'</option>').join('')}).catch(()=>{});fetch('/api/platform/templates').then(response=>response.ok?response.json():Promise.reject()).then(data=>Promise.all(data.rows.map(template=>fetch('/api/platform/templates/'+template.id+'/versions').then(response=>response.ok?response.json():Promise.reject()).then(versions=>versions.rows.map(version=>({template,version})))))).then(groups=>{const select=document.querySelector('#templateVersionSelect');select.innerHTML='<option value="">Seleccionar después</option>'+groups.flat().map(item=>'<option value="'+item.version.id+'">'+item.template.name+' · v'+item.version.version+(item.version.subject?' · '+item.version.subject:'')+'</option>').join('')}).catch(()=>{});const deliveryResult=document.querySelector('#deliveryResult');const deliverySelect=document.querySelector('#deliveryCampaign');const deliveryApi=(path,body={})=>fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'No se pudo completar la operación');return data});const selectedCampaign=()=>Number(deliverySelect.value);const refreshDelivery=()=>fetch('/api/platform/campaigns').then(response=>response.json()).then(data=>{deliverySelect.innerHTML='<option value="">Selecciona una campaña</option>'+data.rows.map(campaign=>'<option value="'+campaign.id+'">'+campaign.name+' · '+campaign.status+'</option>').join('')});refreshDelivery();document.querySelector('#sendTestButton').addEventListener('click',async()=>{const campaignId=selectedCampaign(),email=document.querySelector('#deliveryTestEmail').value.trim();if(!campaignId||!email){deliveryResult.textContent='Selecciona campaña y correo de prueba.';return}try{deliveryResult.textContent='Enviando prueba...';const data=await deliveryApi('/api/platform/campaigns/'+campaignId+'/tests',{emails:[email]});deliveryResult.textContent=data.rows.map(row=>row.email+': '+row.status).join(' · ');refreshDelivery()}catch(error){deliveryResult.textContent=error.message}});document.querySelector('#approveCampaignButton').addEventListener('click',async()=>{const campaignId=selectedCampaign();if(!campaignId){deliveryResult.textContent='Selecciona una campaña.';return}try{await deliveryApi('/api/platform/campaigns/'+campaignId+'/approve');deliveryResult.textContent='Campaña aprobada.';refreshDelivery()}catch(error){deliveryResult.textContent=error.message}});document.querySelector('#sendCampaignButton').addEventListener('click',async()=>{const campaignId=selectedCampaign();if(!campaignId){deliveryResult.textContent='Selecciona una campaña.';return}try{deliveryResult.textContent='Creando envío...';const data=await deliveryApi('/api/platform/campaigns/'+campaignId+'/send',{ratePerSecond:1,batchSize:10});deliveryResult.textContent='Envío iniciado: '+data.job.total+' destinatarios.';refreshDelivery()}catch(error){deliveryResult.textContent=error.message}});</script>
  <section class="view" id="audiences"><article class="panel"><h2>Crear audiencia</h2><p>Importa posteriormente sus contactos mediante CSV desde la API.</p><form id="audienceForm" class="form-grid"><label>Cliente<select name="clientId" class="clientSelect" required></select></label><label>Nombre<input name="name" required placeholder="Ej. Leads activos"></label><label class="full">Descripción<input name="description" placeholder="Uso y procedencia de la audiencia"></label><div class="full form-actions"><button class="primary">Crear audiencia</button></div></form><table class="table"><thead><tr><th>Audiencia</th><th>Cliente</th><th>Contactos</th></tr></thead><tbody id="audienceRows"></tbody></table></article></section>
  <section class="view" id="templates"><article class="panel"><h2>Crear template</h2><p>Cada contenido inicia como versión 1 y se conserva como historial.</p><form id="templateForm" class="form-grid"><label>Cliente<select name="clientId" class="clientSelect" required></select></label><label>Nombre<input name="name" required placeholder="Ej. Newsletter mensual"></label><label class="full">Asunto<input name="subject" placeholder="Asunto predeterminado"></label><label class="full">HTML<textarea name="html" required placeholder="Pega HTML compatible con correo"></textarea></label><div class="full form-actions"><button class="primary">Crear template</button></div></form><table class="table"><thead><tr><th>Template</th><th>Cliente</th><th>Última versión</th></tr></thead><tbody id="templateRows"></tbody></table></article></section>
  <section class="view" id="assets"><article class="panel"><h2>Assets</h2><p>Los assets se guardan por cliente y pueden asociarse a una campaña.</p><div id="assetList" class="empty"><strong>Sin assets</strong>Configura S3 para subir imágenes.</div></article></section>
  <section class="view" id="settings"><article class="panel"><h2>Perfil Amazon SES</h2><p>Las credenciales se cifran antes de guardarse y nunca vuelven a mostrarse.</p><form id="sesForm" class="form-grid"><label>Cliente<select name="clientId" class="clientSelect" required></select></label><label>Nombre<input name="name" required placeholder="SES producción"></label><label>Región AWS<input name="awsRegion" required placeholder="us-east-1"></label><label>From email<input name="fromEmail" type="email" required></label><label>Access key<input name="accessKey" required></label><label>Secret key<input name="secretKey" type="password" required></label><label>From name<input name="fromName"></label><label>Reply-to<input name="replyTo" type="email"></label><div class="full form-actions"><button class="primary">Guardar perfil SES</button></div></form></article></section>
  <section class="view" id="tracking"><article class="panel"><h2>Tracking histórico</h2><p>Consulta el historial completo de aperturas y exporta el detalle desde la vista dedicada.</p><div class="form-actions"><a class="primary" href="/admin/tracking" style="text-decoration:none;display:inline-flex;align-items:center">Abrir tracking</a></div></article></section>
  </main></div><script>
  const responsiveStyle=document.createElement('style');responsiveStyle.textContent='@media(max-width:920px){.app{grid-template-columns:185px minmax(0,1fr)}.side{position:sticky;height:100vh;display:block;padding:20px 10px}.side .brand{width:92px;margin:0 10px 24px}.nav{display:grid;overflow:visible}.nav button{width:100%;white-space:normal;font-size:13px}.nav .tracking{margin-top:18px;padding-top:18px;border-top:1px solid rgba(255,255,255,.08)}.nav-label{display:block}.main{padding:24px 22px}.overview,.workspace{grid-template-columns:1fr 1fr}.workspace .panel:first-child{grid-column:span 2}}@media(max-width:600px){.app{grid-template-columns:156px minmax(0,1fr)}.side{padding:18px 8px}.side .brand{width:78px;margin-left:8px}.nav button{height:auto;min-height:40px;padding:8px 10px;font-size:12px}.nav-label{margin:14px 10px 5px;font-size:9px}.main{padding:22px 14px}.top h1{font-size:24px}.overview,.workspace{grid-template-columns:1fr}.workspace .panel:first-child{grid-column:auto}.metric strong{font-size:23px}.panel{padding:16px}}';document.head.append(responsiveStyle);const nav=document.querySelector('.nav');const operationLabel=document.createElement('span');operationLabel.className='nav-label';operationLabel.textContent='OPERACIÓN';nav.prepend(operationLabel);const catalogsLabel=document.createElement('span');catalogsLabel.className='nav-label';catalogsLabel.textContent='CATÁLOGOS';nav.querySelector('[data-view="audiences"]').before(catalogsLabel);const reportsLabel=document.createElement('span');reportsLabel.className='nav-label';reportsLabel.textContent='REPORTES';nav.querySelector('[data-view="tracking"]').before(reportsLabel);const state={clients:[],audiences:[],templates:[],campaigns:[]};const titles={overview:['Resumen','Estado operativo de tus campañas.'],campaigns:['Campañas','Planea, aprueba y da seguimiento a cada envío.'],audiences:['Audiencias','Bases reutilizables, limpias y listas para enviar.'],templates:['Templates','Contenido versionado que protege tu historial.'],assets:['Assets','Materiales visuales disponibles para tus campañas.'],settings:['Configuración SES','Perfiles de envío seguros por cliente.'],tracking:['Tracking','Métricas históricas de apertura por destinatario.']};
  const importPanel=document.createElement('section');importPanel.style.cssText='margin-top:28px;padding-top:22px;border-top:1px solid rgba(255,255,255,.08)';importPanel.innerHTML='<h2>Importar contactos</h2><p>Selecciona una audiencia y carga un CSV con una columna <strong>email</strong> o <strong>correo</strong>.</p><form id="importContactsForm" class="form-grid"><label>Audiencia<select id="importAudienceId" required><option value="">Selecciona una audiencia</option></select></label><label>Archivo CSV<input id="contactsCsvFile" type="file" accept=".csv,text/csv" required></label><div class="full form-actions"><button class="primary">Importar contactos</button><span id="importResult" class="notice"></span></div></form>';document.querySelector('#audiences .panel').append(importPanel);
  titles.clients=['Clientes','Organiza las cuentas que operas desde HULUL.'];const clientsButton=document.createElement('button');clientsButton.dataset.view='clients';clientsButton.textContent='Clientes';catalogsLabel.after(clientsButton);const clientsView=document.createElement('section');clientsView.className='view';clientsView.id='clients';clientsView.innerHTML='<article class="panel"><h2>Crear cliente</h2><p>Da de alta la cuenta propietaria de sus audiencias, contenido y campañas.</p><form id="clientForm" class="form-grid"><label class="full">Nombre<input name="name" required placeholder="Ej. Acme México"></label><div class="full form-actions"><button class="primary">Crear cliente</button></div></form><table class="table"><thead><tr><th>Cliente</th><th>Creado</th></tr></thead><tbody id="clientRows"></tbody></table></article>';document.querySelector('.main').append(clientsView);clientsView.querySelector('#clientForm').addEventListener('submit',async event=>{event.preventDefault();const name=new FormData(event.target).get('name');try{await api('/api/platform/clients',{method:'POST',body:JSON.stringify({name})});window.location.reload()}catch(error){document.querySelector('#notice').textContent=error.message}});
  async function api(path,options={}){const response=await fetch(path,{headers:{'Content-Type':'application/json'},...options});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'No se pudo completar la operación');return data}function esc(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]))}function options(){document.querySelectorAll('.clientSelect').forEach(select=>{const v=select.value;select.innerHTML='<option value="">Selecciona un cliente</option>'+state.clients.map(c=>'<option value="'+c.id+'">'+esc(c.name)+'</option>').join('');select.value=v});const audience=document.querySelector('#audienceSelect');audience.innerHTML='<option value="">Seleccionar después</option>'+state.audiences.map(a=>'<option value="'+a.id+'">'+esc(a.name)+' ('+a.totalContacts+')</option>').join('');const importAudience=document.querySelector('#importAudienceId');const current=importAudience.value;importAudience.innerHTML='<option value="">Selecciona una audiencia</option>'+state.audiences.map(a=>'<option value="'+a.id+'">'+esc(a.name)+' ('+a.totalContacts+' contactos)</option>').join('');importAudience.value=current}function rows(){document.querySelector('#campaignRows').innerHTML=state.campaigns.map(c=>'<tr><td>'+esc(c.name)+'</td><td>'+esc(c.clientName)+'</td><td><span class="badge">'+esc(c.status)+'</span></td><td>'+esc(c.audienceId||'—')+'</td></tr>').join('')||'<tr><td colspan="4" class="empty">Sin campañas</td></tr>';document.querySelector('#audienceRows').innerHTML=state.audiences.map(a=>'<tr><td>'+esc(a.name)+'</td><td>'+esc(a.clientName)+'</td><td>'+a.totalContacts+'</td></tr>').join('')||'<tr><td colspan="3" class="empty">Sin audiencias</td></tr>';document.querySelector('#templateRows').innerHTML=state.templates.map(t=>'<tr><td>'+esc(t.name)+'</td><td>'+esc(t.clientName)+'</td><td>v'+(t.latestVersion||0)+'</td></tr>').join('')||'<tr><td colspan="3" class="empty">Sin templates</td></tr>';document.querySelector('#campaignCount').textContent=state.campaigns.length;document.querySelector('#audienceCount').textContent=state.audiences.length;document.querySelector('#templateCount').textContent=state.templates.length;document.querySelector('#contactCount').textContent=state.audiences.reduce((sum,a)=>sum+Number(a.totalContacts||0),0);document.querySelector('#recentCampaigns').innerHTML=state.campaigns.length?'<table class="table"><thead><tr><th>Campaña</th><th>Estado</th></tr></thead><tbody>'+state.campaigns.slice(0,5).map(c=>'<tr><td>'+esc(c.name)+'</td><td><span class="badge">'+esc(c.status)+'</span></td></tr>').join('')+'</tbody></table>':'<strong>Aún no hay campañas</strong><br>Crea una campaña cuando ya tengas audiencia y template.'}async function load(){try{const [clients,audiences,templates,campaigns]=await Promise.all(['/api/platform/clients','/api/platform/audiences','/api/platform/templates','/api/platform/campaigns'].map(api));Object.assign(state,{clients:clients.rows,audiences:audiences.rows,templates:templates.rows,campaigns:campaigns.rows});options();rows();document.querySelector('#notice').textContent='Datos actualizados.'}catch(error){document.querySelector('#notice').textContent=error.message}}function form(id,path){document.querySelector(id).addEventListener('submit',async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target));['clientId','audienceId','templateVersionId','sesAccountId'].forEach(key=>{if(values[key])values[key]=Number(values[key]);else delete values[key]});try{await api(path,{method:'POST',body:JSON.stringify(values)});event.target.reset();document.querySelector('#notice').textContent='Guardado correctamente.';await load()}catch(error){document.querySelector('#notice').textContent=error.message}})}document.querySelector('#importContactsForm').addEventListener('submit',async event=>{event.preventDefault();const audienceId=Number(document.querySelector('#importAudienceId').value);const file=document.querySelector('#contactsCsvFile').files[0];const result=document.querySelector('#importResult');if(!audienceId||!file){result.textContent='Selecciona audiencia y archivo CSV.';return}try{result.textContent='Importando contactos...';const data=await api('/api/platform/audiences/'+audienceId+'/contacts/import',{method:'POST',body:JSON.stringify({csv:await file.text()})});result.textContent=data.imported+' importados · '+data.duplicates+' duplicados omitidos';event.target.reset();await load()}catch(error){result.textContent=error.message}});document.querySelectorAll('.nav button').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.nav button,.view').forEach(element=>element.classList.remove('active'));button.classList.add('active');document.querySelector('#'+button.dataset.view).classList.add('active');const [title,copy]=titles[button.dataset.view];document.querySelector('#pageTitle').textContent=title;document.querySelector('#pageCopy').textContent=copy;document.querySelector('#newAction').textContent=button.dataset.view==='campaigns'?'Crear campaña':'Crear campaña';if(button.dataset.view==='campaigns')document.querySelector('#newAction').onclick=()=>document.querySelector('[name="name"]').focus()}));document.querySelector('#newAction').onclick=()=>{document.querySelector('[data-view="campaigns"]').click();document.querySelector('#campaignForm [name="name"]').focus()};form('#campaignForm','/api/platform/campaigns');form('#audienceForm','/api/platform/audiences');form('#templateForm','/api/platform/templates');form('#sesForm','/api/platform/ses-accounts');load();
  </script></body></html>`;
}

function renderAdminPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tracking | HULUL</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#f4f6fb;background:#0b0b12}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,rgba(123,77,255,.16),transparent 35%),#0b0b12}.top{height:72px;display:flex;align-items:center;justify-content:space-between;padding:0 5vw;border-bottom:1px solid rgba(255,255,255,.08);background:rgba(11,11,18,.84)}.logo{width:96px;filter:grayscale(1) brightness(6)}a{color:#d9c7ff;text-decoration:none}.shell{max-width:1400px;margin:auto;padding:30px 5vw}.heading{display:flex;justify-content:space-between;align-items:end;margin-bottom:24px}.heading h1{margin:0;font-size:28px}.heading p{color:#9da4b9;margin:8px 0 0}.filters{display:grid;grid-template-columns:1fr 260px auto auto;gap:10px;margin-bottom:15px}input,button,a.button{height:42px;border-radius:8px;padding:0 12px;font:inherit}input{background:#151824;border:1px solid #34394f;color:#fff}button,a.button{display:inline-flex;align-items:center;justify-content:center;border:1px solid #3d4260;background:#25293a;color:#fff;font-weight:700;cursor:pointer}.primary{background:linear-gradient(135deg,#7b4dff,#925cff);border:0}.table-wrap{overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(22,24,36,.78)}table{width:100%;border-collapse:collapse}th,td{padding:13px;text-align:left;border-bottom:1px solid rgba(255,255,255,.07);font-size:13px}th{color:#9da4b9;font-weight:600}code{font-size:11px;color:#c9b5ff}.muted{color:#9da4b9}.empty{padding:42px;text-align:center;color:#9da4b9}.pager{display:flex;justify-content:space-between;align-items:center;margin-top:14px}@media(max-width:800px){.filters{grid-template-columns:1fr}.shell{padding:22px 16px}}</style></head><body><header class="top">${renderHululLogo("logo")}<a href="/admin">Volver a campañas</a></header><main class="shell"><div class="heading"><div><h1>Tracking</h1><p>Historial de aperturas por destinatario y campaña.</p></div><form method="post" action="/admin/logout"><button>Salir</button></form></div><form class="filters" id="filters"><input id="q" placeholder="Buscar email o token"><input id="campaign" placeholder="Filtrar campaña"><button class="primary">Aplicar filtros</button><a class="button" id="exportLink" href="/api/email-tracking/export">Exportar</a></form><p id="summary" class="muted"></p><div id="table" class="table-wrap"></div><div class="pager"><button id="prev">Anterior</button><span id="pageInfo" class="muted"></span><button id="next">Siguiente</button></div></main><script>let page=1;const limit=50,state={q:'',campaign:''};const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));function params(){const p=new URLSearchParams({page,limit});if(state.q)p.set('q',state.q);if(state.campaign)p.set('campaign',state.campaign);return p}async function load(){const r=await fetch('/api/admin/links?'+params());if(!r.ok){location='/admin/login';return}const d=await r.json(),pages=Math.max(1,Math.ceil(d.total/d.limit));summary.textContent=d.total+' envíos encontrados';pageInfo.textContent='Página '+d.page+' de '+pages;prev.disabled=d.page<=1;next.disabled=d.page>=pages;exportLink.href='/api/email-tracking/export?'+params();table.innerHTML=d.rows.length?'<table><thead><tr><th>Email</th><th>Campaña</th><th>Aperturas</th><th>Última apertura</th><th>Token</th></tr></thead><tbody>'+d.rows.map(row=>'<tr><td>'+e(row.email)+'</td><td>'+e(row.campaign)+'</td><td>'+Number(row.openCount||0)+'</td><td>'+e(row.lastOpenedAtText||'—')+'</td><td><code>'+e(row.token)+'</code></td></tr>').join('')+'</tbody></table>':'<div class="empty">Sin resultados</div>'}filters.addEventListener('submit',event=>{event.preventDefault();state.q=q.value.trim();state.campaign=campaign.value.trim();page=1;load()});prev.onclick=()=>{page=Math.max(1,page-1);load()};next.onclick=()=>{page+=1;load()};load();</script></body></html>`;
}

async function handleAdminLogin(request, response) {
  const form = await readFormBody(request);
  const username = String(form.username || "");
  const password = String(form.password || "");

  if (adminPassword && timingSafeEqualString(username, adminUsername) && timingSafeEqualString(password, adminPassword)) {
    response.writeHead(302, {
      Location: "/admin",
      "Set-Cookie": createSessionCookie({ username, role: "admin" })
    });
    response.end();
    return;
  }

  try {
    const [rows] = await pool.execute("SELECT id, email, password_hash AS passwordHash, role, client_id AS clientId FROM users WHERE email = ? AND status = 'active' LIMIT 1", [username]);
    const user = rows[0];
    if (user && verifyPlatformPassword(password, user.passwordHash)) {
      response.writeHead(302, {
        Location: "/admin",
        "Set-Cookie": createSessionCookie({ username: user.email, userId: user.id, role: user.role, clientId: user.clientId || null })
      });
      response.end();
      return;
    }
  } catch (error) {
    console.error("platform login error", error);
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

function platformBaseUrl() {
  return String(process.env.EMAIL_TRACKING_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "");
}

function createRecipientToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function getCampaignForDelivery(accountId, campaignId) {
  const [rows] = await pool.execute(`SELECT c.*, v.html, v.subject AS templateSubject, v.preheader AS templatePreheader,
    s.aws_region AS awsRegion, s.access_key_encrypted AS accessKeyEncrypted, s.secret_key_encrypted AS secretKeyEncrypted,
    s.default_from_name AS defaultFromName, s.default_from_email AS defaultFromEmail, s.default_reply_to AS defaultReplyTo
    FROM campaigns c
    LEFT JOIN template_versions v ON v.id = c.template_version_id
    LEFT JOIN ses_accounts s ON s.id = c.ses_account_id
    WHERE c.id = ? AND c.account_id = ? LIMIT 1`, [campaignId, accountId]);
  if (!rows[0]) throw new Error("campaign not found for account");
  return rows[0];
}

function assertDeliveryReady(campaign) {
  if (!campaign.ses_account_id || !campaign.awsRegion || !campaign.accessKeyEncrypted) throw new Error("campaign requires an active SES account");
  if (!campaign.template_version_id || !campaign.html) throw new Error("campaign requires a template version");
  if (!campaign.audience_id) throw new Error("campaign requires an audience");
}

async function snapshotCampaignRecipients(accountId, campaignId) {
  const campaign = await getCampaignForDelivery(accountId, campaignId);
  assertDeliveryReady(campaign);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [contacts] = await connection.execute("SELECT id, email FROM audience_contacts WHERE audience_id = ? AND status = 'active' ORDER BY id", [campaign.audience_id]);
    for (const contact of contacts) {
      const [existing] = await connection.execute("SELECT id FROM campaign_recipients WHERE campaign_id = ? AND email = ? LIMIT 1", [campaignId, contact.email]);
      if (existing[0]) continue;
      const token = createRecipientToken();
      const [link] = await connection.execute("INSERT INTO email_tracking_links (token, email, campaign, campaign_id, asset_path) VALUES (?, ?, ?, ?, ?)", [token, contact.email, campaign.name, campaignId, defaultAssetPath]);
      await connection.execute("INSERT IGNORE INTO campaign_recipients (campaign_id, audience_contact_id, tracking_link_id, email, tracking_token, status) VALUES (?, ?, ?, ?, ?, 'pending')", [campaignId, contact.id, link.insertId, contact.email, token]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  const [[summary]] = await pool.execute("SELECT COUNT(*) AS total FROM campaign_recipients WHERE campaign_id = ?", [campaignId]);
  return { campaign, total: Number(summary.total) };
}

async function sendCampaignTests(accountId, campaignId, body) {
  const campaign = await getCampaignForDelivery(accountId, campaignId);
  assertDeliveryReady(campaign);
  const emails = [...new Set((Array.isArray(body.emails) ? body.emails : []).map((email) => String(email || "").trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw new Error("at least one test email is required");
  const results = [];
  for (const email of emails) {
    const token = createRecipientToken();
    let linkId = null;
    try {
      const [link] = await pool.execute("INSERT INTO email_tracking_links (token, email, campaign, campaign_id, asset_path) VALUES (?, ?, ?, ?, ?)", [token, email, campaign.name, campaignId, defaultAssetPath]);
      linkId = link.insertId;
      const html = renderTemplate(campaign.html, { email, campaign_name: campaign.name, preheader: campaign.preheader || campaign.templatePreheader || "", tracking_image_url: `${platformBaseUrl()}/api/email-tracking/image?token=${token}`, tracking_pixel_url: `${platformBaseUrl()}/api/email-tracking/open.gif?token=${token}` });
      const providerMessageId = await sendWithSes({ profile: campaign, encryptionKey: platformEncryptionKey, to: email, subject: campaign.subject || campaign.templateSubject, html, replyTo: campaign.reply_to || campaign.defaultReplyTo });
      await pool.execute("INSERT INTO campaign_tests (campaign_id, email, tracking_link_id, status, provider_message_id, sent_at) VALUES (?, ?, ?, 'sent', ?, CURRENT_TIMESTAMP)", [campaignId, email, linkId, providerMessageId]);
      results.push({ email, status: "sent", providerMessageId });
    } catch (error) {
      await pool.execute("INSERT INTO campaign_tests (campaign_id, email, tracking_link_id, status, last_error) VALUES (?, ?, ?, 'failed', ?)", [campaignId, email, linkId, String(error.message || error).slice(0, 4000)]);
      results.push({ email, status: "failed", error: String(error.message || error) });
    }
  }
  if (results.some((result) => result.status === "sent")) await pool.execute("UPDATE campaigns SET status = 'test_sent', test_sent_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('draft', 'test_ready', 'test_sent')", [campaignId]);
  return results;
}

async function approveCampaign(accountId, campaignId, approvedBy) {
  const campaign = await getCampaignForDelivery(accountId, campaignId);
  const [[test]] = await pool.execute("SELECT id FROM campaign_tests WHERE campaign_id = ? AND status = 'sent' LIMIT 1", [campaignId]);
  if (!test) throw new Error("a successful test send is required before approval");
  if (campaign.status !== "test_sent") throw new Error("campaign is not ready for approval");
  await pool.execute("INSERT INTO campaign_approvals (campaign_id, approved_by) VALUES (?, ?) ON DUPLICATE KEY UPDATE approved_by = VALUES(approved_by), approved_at = CURRENT_TIMESTAMP", [campaignId, approvedBy || null]);
  await pool.execute("UPDATE campaigns SET status = 'approved', approved_at = CURRENT_TIMESTAMP, approved_by = ? WHERE id = ?", [approvedBy || null, campaignId]);
}

async function createCampaignJob(accountId, campaignId, body) {
  const campaign = await getCampaignForDelivery(accountId, campaignId);
  if (campaign.status !== "approved") throw new Error("campaign must be approved before mass sending");
  const snapshot = await snapshotCampaignRecipients(accountId, campaignId);
  if (!snapshot.total) throw new Error("campaign audience has no active contacts");
  const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw new Error("scheduledAt must be a valid ISO date");
  const rate = Math.min(Math.max(Number(body.ratePerSecond) || 1, 1), 100);
  const batch = Math.min(Math.max(Number(body.batchSize) || 10, 1), 100);
  const status = scheduledAt && scheduledAt.getTime() > Date.now() ? "scheduled" : "sending";
  const [result] = await pool.execute("INSERT INTO send_jobs (campaign_id, status, total, pending, rate_per_second, batch_size) VALUES (?, 'queued', ?, ?, ?, ?)", [campaignId, snapshot.total, snapshot.total, rate, batch]);
  await pool.execute("UPDATE campaigns SET status = ?, scheduled_at = ? WHERE id = ?", [status, scheduledAt ? scheduledAt.toISOString().slice(0, 19).replace("T", " ") : null, campaignId]);
  return { id: result.insertId, status: "queued", total: snapshot.total };
}

async function getCampaignResults(accountId, campaignId) {
  await getCampaignForDelivery(accountId, campaignId);
  const [[row]] = await pool.execute(`SELECT
    COUNT(r.id) AS recipients, SUM(r.status = 'sent') AS sent, SUM(r.status = 'failed') AS failed,
    SUM(r.status IN ('pending', 'queued', 'sending')) AS pending, COUNT(l.id) AS trackingLinks,
    SUM(l.open_count) AS opens, SUM(l.open_count > 0) AS openedContacts,
    MIN(l.last_opened_at) AS firstOpenedAt, MAX(l.last_opened_at) AS lastOpenedAt
    FROM campaign_recipients r LEFT JOIN email_tracking_links l ON l.id = r.tracking_link_id WHERE r.campaign_id = ?`, [campaignId]);
  const recipients = Number(row.recipients || 0);
  return { ...row, recipients, sent: Number(row.sent || 0), failed: Number(row.failed || 0), pending: Number(row.pending || 0), opens: Number(row.opens || 0), openedContacts: Number(row.openedContacts || 0), openRate: recipients ? Number(((Number(row.openedContacts || 0) / recipients) * 100).toFixed(2)) : 0 };
}

async function handlePlatformRequest(request, response, requestUrl, session) {
  try {
    const account = await getPlatformAccount();
    const scopedClientId = session.role === "client" ? Number(session.clientId) : null;
    if (session.role === "client" && (!Number.isSafeInteger(scopedClientId) || scopedClientId < 1)) throw new Error("client user is not assigned to a client");
    const scopeClientId = (value) => {
      const requested = value === undefined || value === null || value === "" ? null : Number(value);
      if (scopedClientId && requested && requested !== scopedClientId) throw new Error("client access is limited to its own account");
      return scopedClientId || requested || undefined;
    };
    const requirePlatformAdmin = () => {
      if (!isPlatformAdmin(session)) throw new Error("administrator access is required");
    };
    const assertScopedCampaign = async (campaignId) => {
      if (!scopedClientId) return;
      const [rows] = await pool.execute("SELECT id FROM campaigns WHERE id = ? AND account_id = ? AND client_id = ?", [campaignId, account.id, scopedClientId]);
      if (!rows[0]) throw new Error("campaign not found for client");
    };
    const assertScopedAudience = async (audienceId) => {
      if (!scopedClientId) return;
      const [rows] = await pool.execute("SELECT id FROM audiences WHERE id = ? AND account_id = ? AND client_id = ?", [audienceId, account.id, scopedClientId]);
      if (!rows[0]) throw new Error("audience not found for client");
    };
    const assertScopedTemplate = async (templateId) => {
      if (!scopedClientId) return;
      const [rows] = await pool.execute("SELECT id FROM templates WHERE id = ? AND account_id = ? AND client_id = ?", [templateId, account.id, scopedClientId]);
      if (!rows[0]) throw new Error("template not found for client");
    };
    const clientId = scopeClientId(requestUrl.searchParams.get("clientId"));
    const pathName = requestUrl.pathname;

    if (request.method === "GET" && pathName === "/api/platform/account") {
      return sendJson(response, 200, { ok: true, account, access: { role: session.role, clientId: scopedClientId } });
    }
    if (request.method === "GET" && pathName === "/api/platform/clients") {
      const rows = await platformRepository.listClients(account.id);
      return sendJson(response, 200, { ok: true, rows: scopedClientId ? rows.filter((client) => Number(client.id) === scopedClientId) : rows });
    }
    if (request.method === "POST" && pathName === "/api/platform/clients") {
      requirePlatformAdmin();
      return sendJson(response, 201, { ok: true, client: await platformRepository.createClient(account.id, await readJsonBody(request)) });
    }
    const clientMatch = pathName.match(/^\/api\/platform\/clients\/(\d+)$/);
    if (request.method === "PATCH" && clientMatch) {
      requirePlatformAdmin();
      return sendJson(response, 200, { ok: true, client: await platformRepository.updateClient(account.id, Number(clientMatch[1]), await readJsonBody(request)) });
    }
    if (request.method === "POST" && pathName === "/api/platform/users") {
      requirePlatformAdmin();
      const body = await readJsonBody(request);
      const clientId = Number(body.clientId);
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      if (!Number.isSafeInteger(clientId) || !email || !name || password.length < 10) throw new Error("clientId, name, email and a 10-character password are required");
      const [clients] = await pool.execute("SELECT id FROM clients WHERE id = ? AND account_id = ? AND status = 'active'", [clientId, account.id]);
      if (!clients[0]) throw new Error("client not found for account");
      const [result] = await pool.execute("INSERT INTO users (account_id, client_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?, 'client')", [account.id, clientId, name.slice(0, 160), email.slice(0, 255), hashPlatformPassword(password)]);
      return sendJson(response, 201, { ok: true, user: { id: result.insertId, clientId, name, email, role: "client" } });
    }
    if (request.method === "GET" && pathName === "/api/platform/campaigns") {
      return sendJson(response, 200, { ok: true, rows: await platformRepository.listCampaigns(account.id, clientId) });
    }
    if (request.method === "POST" && pathName === "/api/platform/campaigns") {
      const body = await readJsonBody(request);
      body.clientId = scopeClientId(body.clientId);
      return sendJson(response, 201, { ok: true, campaign: await platformRepository.createCampaign(account.id, body) });
    }
    const campaignAction = pathName.match(/^\/api\/platform\/campaigns\/(\d+)\/(recipients|tests|approve|send|results)$/);
    if (campaignAction) {
      const campaignId = Number(campaignAction[1]);
      await assertScopedCampaign(campaignId);
      const action = campaignAction[2];
      if (request.method === "POST" && action === "recipients") return sendJson(response, 201, { ok: true, ...await snapshotCampaignRecipients(account.id, campaignId) });
      if (request.method === "POST" && action === "tests") return sendJson(response, 200, { ok: true, rows: await sendCampaignTests(account.id, campaignId, await readJsonBody(request)) });
      if (request.method === "POST" && action === "approve") { const body = await readJsonBody(request); await approveCampaign(account.id, campaignId, body.approvedBy); return sendJson(response, 200, { ok: true }); }
      if (request.method === "POST" && action === "send") return sendJson(response, 201, { ok: true, job: await createCampaignJob(account.id, campaignId, await readJsonBody(request)) });
      if (request.method === "GET" && action === "results") return sendJson(response, 200, { ok: true, results: await getCampaignResults(account.id, campaignId) });
    }
    const previewMatch = pathName.match(/^\/api\/platform\/campaigns\/(\d+)\/preview$/);
    if (request.method === "GET" && previewMatch) {
      await assertScopedCampaign(Number(previewMatch[1]));
      const campaign = await getCampaignForDelivery(account.id, Number(previewMatch[1]));
      if (!campaign.html) throw new Error("campaign requires a template version for preview");
      const email = String(requestUrl.searchParams.get("email") || "preview@example.test");
      const token = "preview-token";
      const html = renderTemplate(campaign.html, { email, campaign_name: campaign.name, preheader: campaign.preheader || campaign.templatePreheader || "", tracking_image_url: `${platformBaseUrl()}/api/email-tracking/image?token=${token}`, tracking_pixel_url: `${platformBaseUrl()}/api/email-tracking/open.gif?token=${token}` });
      return sendJson(response, 200, { ok: true, subject: campaign.subject || campaign.templateSubject, preheader: campaign.preheader || campaign.templatePreheader, html });
    }
    const campaignMatch = pathName.match(/^\/api\/platform\/campaigns\/(\d+)\/status$/);
    if (request.method === "PATCH" && campaignMatch) {
      await assertScopedCampaign(Number(campaignMatch[1]));
      const body = await readJsonBody(request);
      return sendJson(response, 200, { ok: true, campaign: await platformRepository.transitionCampaign(account.id, Number(campaignMatch[1]), body.status) });
    }
    if (request.method === "GET" && pathName === "/api/platform/audiences") {
      return sendJson(response, 200, { ok: true, rows: await platformRepository.listAudiences(account.id, clientId) });
    }
    if (request.method === "POST" && pathName === "/api/platform/audiences") {
      const body = await readJsonBody(request);
      body.clientId = scopeClientId(body.clientId);
      return sendJson(response, 201, { ok: true, audience: await platformRepository.createAudience(account.id, body) });
    }
    const audienceMatch = pathName.match(/^\/api\/platform\/audiences\/(\d+)$/);
    if (request.method === "DELETE" && audienceMatch) {
      await assertScopedAudience(Number(audienceMatch[1]));
      await platformRepository.deleteAudience(account.id, Number(audienceMatch[1]));
      response.writeHead(204); response.end(); return;
    }
    const audienceImport = pathName.match(/^\/api\/platform\/audiences\/(\d+)\/contacts\/import$/);
    if (request.method === "POST" && audienceImport) {
      await assertScopedAudience(Number(audienceImport[1]));
      const body = await readJsonBody(request);
      return sendJson(response, 200, { ok: true, ...await platformRepository.importAudienceContacts(account.id, Number(audienceImport[1]), body.csv) });
    }
    const audienceContactsMatch = pathName.match(/^\/api\/platform\/audiences\/(\d+)\/contacts$/);
    if (request.method === "GET" && audienceContactsMatch) {
      await assertScopedAudience(Number(audienceContactsMatch[1]));
      const [rows] = await pool.execute("SELECT ac.id, ac.email, ac.name, ac.status, ac.metadata_json AS metadataJson, ac.created_at AS createdAt FROM audience_contacts ac JOIN audiences a ON a.id = ac.audience_id WHERE ac.audience_id = ? AND a.account_id = ? ORDER BY ac.id DESC LIMIT 500", [Number(audienceContactsMatch[1]), account.id]);
      return sendJson(response, 200, { ok: true, rows });
    }
    if (request.method === "GET" && pathName === "/api/platform/templates") {
      return sendJson(response, 200, { ok: true, rows: await platformRepository.listTemplates(account.id, clientId) });
    }
    if (request.method === "POST" && pathName === "/api/platform/templates") {
      const body = await readJsonBody(request);
      body.clientId = scopeClientId(body.clientId);
      return sendJson(response, 201, { ok: true, template: await platformRepository.createTemplate(account.id, body) });
    }
    const templateVersionMatch = pathName.match(/^\/api\/platform\/templates\/(\d+)\/versions$/);
    if (request.method === "POST" && templateVersionMatch) {
      await assertScopedTemplate(Number(templateVersionMatch[1]));
      return sendJson(response, 201, { ok: true, templateVersion: await platformRepository.addTemplateVersion(account.id, Number(templateVersionMatch[1]), await readJsonBody(request)) });
    }
    if (request.method === "GET" && templateVersionMatch) {
      await assertScopedTemplate(Number(templateVersionMatch[1]));
      const [rows] = await pool.execute("SELECT v.id, v.version, v.subject, v.preheader, v.source_type AS sourceType, v.created_at AS createdAt FROM template_versions v JOIN templates t ON t.id = v.template_id WHERE v.template_id = ? AND t.account_id = ? ORDER BY v.version DESC", [Number(templateVersionMatch[1]), account.id]);
      return sendJson(response, 200, { ok: true, rows });
    }
    const templateAiMatch = pathName.match(/^\/api\/platform\/templates\/(\d+)\/ai$/);
    if (request.method === "POST" && templateAiMatch) {
      const templateId = Number(templateAiMatch[1]);
      await assertScopedTemplate(templateId);
      const body = await readJsonBody(request);
      const [[current]] = await pool.execute("SELECT t.client_id AS clientId, v.html, v.subject, v.preheader FROM templates t JOIN template_versions v ON v.template_id = t.id WHERE t.id = ? AND t.account_id = ? ORDER BY v.version DESC LIMIT 1", [templateId, account.id]);
      if (!current) throw new Error("template not found for account");
      const [assets] = await pool.execute("SELECT name, public_url AS publicUrl FROM assets WHERE account_id = ? AND client_id = ? ORDER BY created_at DESC", [account.id, current.clientId]);
      const draft = await reviseTemplateWithAi({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_TEMPLATE_MODEL || "gpt-5", instruction: body.instruction, html: current.html, subject: current.subject, preheader: current.preheader, assets });
      return sendJson(response, 201, { ok: true, templateVersion: await platformRepository.addTemplateVersion(account.id, templateId, { ...draft, sourceType: "ai", createdBy: body.createdBy }) });
    }
    const templateCloneMatch = pathName.match(/^\/api\/platform\/templates\/(\d+)\/clone$/);
    if (request.method === "POST" && templateCloneMatch) {
      await assertScopedTemplate(Number(templateCloneMatch[1]));
      const body = await readJsonBody(request);
      const [[source]] = await pool.execute("SELECT t.client_id AS clientId, t.description, v.html, v.subject, v.preheader FROM templates t JOIN template_versions v ON v.template_id = t.id WHERE t.id = ? AND t.account_id = ? ORDER BY v.version DESC LIMIT 1", [Number(templateCloneMatch[1]), account.id]);
      if (!source) throw new Error("template not found for account");
      return sendJson(response, 201, { ok: true, template: await platformRepository.createTemplate(account.id, { ...source, name: body.name, clientId: body.clientId || source.clientId, sourceType: "clone", createdBy: body.createdBy }) });
    }
    if (request.method === "GET" && pathName === "/api/platform/assets") {
      const [rows] = await pool.execute(`SELECT id, client_id AS clientId, campaign_id AS campaignId, name, original_filename AS originalFilename, public_url AS publicUrl, mime_type AS mimeType, size, width, height, created_at AS createdAt FROM assets WHERE account_id = ?${scopedClientId ? " AND client_id = ?" : ""} ORDER BY created_at DESC`, scopedClientId ? [account.id, scopedClientId] : [account.id]);
      return sendJson(response, 200, { ok: true, rows });
    }
    if (request.method === "POST" && pathName === "/api/platform/assets") {
      const body = await readJsonBody(request);
      const clientId = scopeClientId(body.clientId);
      if (!Number.isSafeInteger(clientId) || !body.filename || !body.base64 || !body.mimeType) throw new Error("clientId, filename, mimeType and base64 are required");
      const [clients] = await pool.execute("SELECT id FROM clients WHERE id = ? AND account_id = ?", [clientId, account.id]);
      if (!clients[0]) throw new Error("client not found for account");
      const buffer = Buffer.from(String(body.base64).replace(/^data:[^;]+;base64,/, ""), "base64");
      if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw new Error("asset must be between 1 byte and 15 MB");
      const bucket = process.env.ASSET_S3_BUCKET;
      const region = process.env.ASSET_S3_REGION;
      if (!bucket || !region || !process.env.ASSET_S3_ACCESS_KEY || !process.env.ASSET_S3_SECRET_KEY) throw new Error("S3 asset configuration is incomplete");
      const safeName = String(body.filename).replace(/[^a-zA-Z0-9._-]/g, "-");
      const key = `clients/${clientId}/${crypto.randomUUID()}-${safeName}`;
      const publicUrl = await uploadAssetToS3({ region, bucket, accessKeyId: process.env.ASSET_S3_ACCESS_KEY, secretAccessKey: process.env.ASSET_S3_SECRET_KEY, key, body: buffer, mimeType: String(body.mimeType) });
      const campaignId = body.campaignId ? Number(body.campaignId) : null;
      const [result] = await pool.execute("INSERT INTO assets (account_id, client_id, campaign_id, name, original_filename, s3_key, public_url, mime_type, size, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [account.id, clientId, campaignId, String(body.name || body.filename).slice(0, 160), safeName, key, publicUrl, String(body.mimeType).slice(0, 120), buffer.length, Number(body.width) || null, Number(body.height) || null]);
      return sendJson(response, 201, { ok: true, asset: { id: result.insertId, publicUrl } });
    }
    if (request.method === "GET" && pathName === "/api/platform/ses-accounts") {
      const [rows] = await pool.execute(`SELECT id, client_id AS clientId, name, aws_region AS awsRegion, default_from_name AS defaultFromName, default_from_email AS defaultFromEmail, default_reply_to AS defaultReplyTo, status, created_at AS createdAt FROM ses_accounts WHERE account_id = ?${scopedClientId ? " AND client_id = ?" : ""} ORDER BY name`, scopedClientId ? [account.id, scopedClientId] : [account.id]);
      return sendJson(response, 200, { ok: true, rows });
    }
    if (request.method === "POST" && pathName === "/api/platform/ses-accounts") {
      const body = await readJsonBody(request);
      const clientId = scopeClientId(body.clientId);
      if (!Number.isSafeInteger(clientId) || clientId < 1 || !body.name || !body.awsRegion || !body.accessKey || !body.secretKey || !body.fromEmail) throw new Error("clientId, name, awsRegion, accessKey, secretKey and fromEmail are required");
      const [clients] = await pool.execute("SELECT id FROM clients WHERE id = ? AND account_id = ?", [clientId, account.id]);
      if (!clients[0]) throw new Error("client not found for account");
      const [result] = await pool.execute("INSERT INTO ses_accounts (account_id, client_id, name, aws_region, access_key_encrypted, secret_key_encrypted, default_from_name, default_from_email, default_reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [account.id, clientId, String(body.name).slice(0, 160), String(body.awsRegion).slice(0, 40), encryptSecret(body.accessKey, platformEncryptionKey), encryptSecret(body.secretKey, platformEncryptionKey), String(body.fromName || "").slice(0, 160) || null, String(body.fromEmail).slice(0, 255), String(body.replyTo || "").slice(0, 255) || null]);
      return sendJson(response, 201, { ok: true, sesAccount: { id: result.insertId } });
    }
    const jobAction = pathName.match(/^\/api\/platform\/send-jobs\/(\d+)(?:\/(pause|resume))?$/);
    if (jobAction) {
      const jobId = Number(jobAction[1]);
      if (scopedClientId) {
        const [rows] = await pool.execute("SELECT j.id FROM send_jobs j JOIN campaigns c ON c.id = j.campaign_id WHERE j.id = ? AND c.account_id = ? AND c.client_id = ?", [jobId, account.id, scopedClientId]);
        if (!rows[0]) throw new Error("send job not found for client");
      }
      if (request.method === "GET" && !jobAction[2]) {
        const [rows] = await pool.execute("SELECT id, campaign_id AS campaignId, status, total, processed, sent, failed, pending, started_at AS startedAt, finished_at AS finishedAt, last_activity_at AS lastActivity FROM send_jobs WHERE id = ?", [jobId]);
        if (!rows[0]) throw new Error("send job not found");
        return sendJson(response, 200, { ok: true, job: { ...rows[0], percentage: rows[0].total ? Number(((rows[0].processed / rows[0].total) * 100).toFixed(2)) : 0 } });
      }
      if (request.method === "POST" && jobAction[2] === "pause") { await pool.execute("UPDATE send_jobs SET status = 'paused' WHERE id = ? AND status IN ('queued', 'running')", [jobId]); await pool.execute("UPDATE campaigns c JOIN send_jobs j ON j.campaign_id = c.id SET c.status = 'paused' WHERE j.id = ?", [jobId]); return sendJson(response, 200, { ok: true }); }
      if (request.method === "POST" && jobAction[2] === "resume") { await pool.execute("UPDATE send_jobs SET status = 'queued' WHERE id = ? AND status = 'paused'", [jobId]); await pool.execute("UPDATE campaigns c JOIN send_jobs j ON j.campaign_id = c.id SET c.status = 'sending' WHERE j.id = ?", [jobId]); return sendJson(response, 200, { ok: true }); }
    }
    return sendJson(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    console.error("platform request error", error);
    const isClientError = /is required|not found|must include|does not exist/.test(String(error.message));
    return sendJson(response, isClientError ? 400 : 500, { ok: false, error: isClientError ? error.message : "internal server error" });
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  const requestUrl = new URL(request.url, "http://localhost");

  if (request.method === "GET" && requestUrl.pathname === "/brand/hulul-logo.png") {
    try {
      const logo = await fs.readFile(path.join(publicDir, "brand", "hulul-logo.png"));
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      response.end(logo);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
    return;
  }

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

  if (request.method === "GET" && requestUrl.pathname === "/admin/tracking") {
    const session = requireAdmin(request, response);
    if (!session) {
      return;
    }
    if (!isPlatformAdmin(session)) return sendHtml(response, 403, renderLoginPage("El tracking global sólo está disponible para administradores."));

    return sendHtml(response, 200, renderAdminPage());
  }

  if (request.method === "GET" && requestUrl.pathname === "/admin") {
    if (!requireAdmin(request, response)) {
      return;
    }

    return sendHtml(response, 200, renderPlatformPage());
  }

  if (request.method === "GET" && requestUrl.pathname === "/platform") {
    if (!requireAdmin(request, response)) {
      return;
    }
    return sendHtml(response, 200, renderPlatformPage());
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/admin/links") {
    const session = requireAdmin(request, response);
    if (!session) {
      return;
    }
    if (!isPlatformAdmin(session)) return sendJson(response, 403, { ok: false, error: "forbidden" });

    return handleAdminLinks(request, response);
  }

  if (requestUrl.pathname.startsWith("/api/platform/")) {
    const session = requireAdmin(request, response);
    if (!session) {
      return;
    }
    return handlePlatformRequest(request, response, requestUrl, session);
  }

  const eventsMatch = requestUrl.pathname.match(/^\/api\/admin\/links\/(\d+)\/events$/);
  if (request.method === "GET" && eventsMatch) {
    const session = requireAdmin(request, response);
    if (!session) {
      return;
    }
    if (!isPlatformAdmin(session)) return sendJson(response, 403, { ok: false, error: "forbidden" });

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
    const session = requireAdmin(request, response);
    if (!session) {
      return;
    }
    if (!isPlatformAdmin(session)) return sendJson(response, 403, { ok: false, error: "forbidden" });

    return handleExport(request, response);
  }

  response.writeHead(404);
  response.end("Not found");
});

server.listen(port, host, () => {
  console.log(`Tracking service listening on http://${host}:${port}`);
});
