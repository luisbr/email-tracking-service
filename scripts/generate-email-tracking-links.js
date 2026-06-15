import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

const [, , inputFileArg, outputFileArg, campaignArg] = process.argv;

if (!inputFileArg) {
  console.error(
    "Usage: node scripts/generate-email-tracking-links.js <input.csv> [output.csv] [campaign]"
  );
  process.exit(1);
}

const inputFile = path.resolve(inputFileArg);
const outputFile = path.resolve(outputFileArg || "email-tracking-links-output.csv");
const fallbackCampaign = String(campaignArg || process.env.EMAIL_TRACKING_DEFAULT_CAMPAIGN || "").trim();
const baseUrl = String(process.env.EMAIL_TRACKING_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "3010"}`).replace(/\/$/, "");
const defaultAssetPath = String(process.env.EMAIL_TRACKING_ASSET_PATH || "/image/060926-Mailing2_01.png").trim();

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number.parseInt(process.env.MYSQL_PORT || "3306", 10),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5
});

function createTrackingToken() {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeAssetPath(assetPath) {
  const normalized = String(assetPath || defaultAssetPath).trim();
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function parseCsv(content) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        i += 1;
      }

      row.push(field);
      field = "";

      if (row.some((value) => value !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => value !== "")) {
    rows.push(row);
  }

  return rows;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function buildOutputCsv(rows) {
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
}

function getHeaderIndexMap(headers) {
  return Object.fromEntries(headers.map((header, index) => [header.trim().toLowerCase(), index]));
}

function pickValue(record, indexMap, possibleHeaders) {
  for (const header of possibleHeaders) {
    const index = indexMap[header];
    if (index !== undefined) {
      return String(record[index] || "").trim();
    }
  }

  return "";
}

async function main() {
  const csvContent = await fs.readFile(inputFile, "utf8");
  const rows = parseCsv(csvContent);

  if (rows.length < 2) {
    throw new Error("Input CSV must include a header row and at least one data row.");
  }

  const headers = rows[0];
  const indexMap = getHeaderIndexMap(headers);
  const dataRows = rows.slice(1);

  if (indexMap.email === undefined && indexMap.correo === undefined) {
    throw new Error("Input CSV must include an 'email' or 'correo' column.");
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const outputRows = [[
      "email",
      "campaign",
      "token",
      "asset_path",
      "image_url",
      "pixel_url"
    ]];

    for (const record of dataRows) {
      const email = pickValue(record, indexMap, ["email", "correo"]);
      const campaign = pickValue(record, indexMap, ["campaign", "campana"]) || fallbackCampaign;
      const assetPath = normalizeAssetPath(
        pickValue(record, indexMap, ["asset_path", "asset", "image_path", "image"])
      );

      if (!email) {
        continue;
      }

      if (!campaign) {
        throw new Error(`Campaign is required for email ${email}. Add a campaign column or pass a fallback campaign.`);
      }

      const metadata = {};

      headers.forEach((header, index) => {
        const normalizedHeader = header.trim().toLowerCase();
        if (["email", "correo", "campaign", "campana", "asset_path", "asset", "image_path", "image"].includes(normalizedHeader)) {
          return;
        }

        metadata[header.trim()] = record[index] ?? "";
      });

      const token = createTrackingToken();

      await connection.execute(
        `INSERT INTO email_tracking_links (
          token,
          email,
          campaign,
          asset_path,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          token,
          email.slice(0, 255),
          campaign.slice(0, 120),
          assetPath.slice(0, 255),
          Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
        ]
      );

      outputRows.push([
        email,
        campaign,
        token,
        assetPath,
        `${baseUrl}/api/email-tracking/image?token=${token}`,
        `${baseUrl}/api/email-tracking/open.gif?token=${token}`
      ]);
    }

    await connection.commit();
    await fs.writeFile(outputFile, `${buildOutputCsv(outputRows)}\n`, "utf8");

    console.log(`Generated ${outputRows.length - 1} tracking links.`);
    console.log(`Output written to: ${outputFile}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
