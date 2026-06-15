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
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
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

async function listEmailTrackingLinks() {
  const [rows] = await pool.execute(
    `SELECT id, email, campaign, token, asset_path AS assetPath,
            open_count AS openCount, last_opened_at AS lastOpenedAt,
            metadata_json AS metadataJson, created_at AS createdAt
     FROM email_tracking_links
     ORDER BY created_at DESC`
  );

  return rows;
}

async function listEmailTrackingEvents() {
  const [rows] = await pool.execute(
    `SELECT events.id, events.event_type AS eventType, events.user_agent AS userAgent,
            events.ip_address AS ipAddress, events.referer, events.query_string AS queryString,
            events.created_at AS createdAt, links.email, links.campaign, links.token
     FROM email_tracking_events events
     INNER JOIN email_tracking_links links
       ON links.id = events.tracking_link_id
     ORDER BY events.created_at DESC`
  );

  return rows;
}

function parseMetadata(metadataJson) {
  if (!metadataJson) {
    return null;
  }

  try {
    return JSON.parse(metadataJson);
  } catch {
    return metadataJson;
  }
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

async function handleExport(response) {
  try {
    const [links, events] = await Promise.all([
      listEmailTrackingLinks(),
      listEmailTrackingEvents()
    ]);

    const workbook = new ExcelJS.Workbook();
    const linksSheet = workbook.addWorksheet("TrackingLinks");
    linksSheet.columns = [
      { header: "Email", key: "email", width: 32 },
      { header: "Campaign", key: "campaign", width: 24 },
      { header: "Token", key: "token", width: 68 },
      { header: "Asset Path", key: "assetPath", width: 30 },
      { header: "Open Count", key: "openCount", width: 12 },
      { header: "Last Opened At", key: "lastOpenedAt", width: 22 },
      { header: "Metadata", key: "metadata", width: 40 },
      { header: "Created At", key: "createdAt", width: 22 }
    ];

    links.forEach((row) => {
      linksSheet.addRow({
        ...row,
        metadata: JSON.stringify(parseMetadata(row.metadataJson) || {})
      });
    });

    const eventsSheet = workbook.addWorksheet("TrackingEvents");
    eventsSheet.columns = [
      { header: "Email", key: "email", width: 32 },
      { header: "Campaign", key: "campaign", width: 24 },
      { header: "Token", key: "token", width: 68 },
      { header: "Event Type", key: "eventType", width: 16 },
      { header: "IP Address", key: "ipAddress", width: 20 },
      { header: "Referer", key: "referer", width: 32 },
      { header: "User Agent", key: "userAgent", width: 60 },
      { header: "Query String", key: "queryString", width: 28 },
      { header: "Created At", key: "createdAt", width: 22 }
    ];

    events.forEach((row) => {
      eventsSheet.addRow(row);
    });

    const buffer = await workbook.xlsx.writeBuffer();
    response.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="email-tracking-${Date.now()}.xlsx"`,
      "Content-Length": buffer.length
    });
    response.end(buffer);
  } catch (error) {
    console.error("tracking export error", error);
    response.writeHead(500);
    response.end("Internal server error");
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    return sendJson(response, 200, { ok: true });
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

  if (request.method === "GET" && request.url === "/api/email-tracking/export") {
    return handleExport(response);
  }

  response.writeHead(404);
  response.end("Not found");
});

server.listen(port, host, () => {
  console.log(`Tracking service listening on http://${host}:${port}`);
});
