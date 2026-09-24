import "dotenv/config";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { renderTemplate, sendWithSes } from "./src/platform-services.js";

const pool = mysql.createPool({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectionLimit: 5 });
const baseUrl = String(process.env.EMAIL_TRACKING_BASE_URL || `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "3010"}`).replace(/\/$/, "");
const encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY;
const configuredMaxAttempts = Number(process.env.SEND_MAX_ATTEMPTS);
const maxAttempts = Number.isFinite(configuredMaxAttempts) && configuredMaxAttempts > 0 ? Math.floor(configuredMaxAttempts) : 3;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function claimJob() {
  const [rows] = await pool.execute("SELECT j.id FROM send_jobs j JOIN campaigns c ON c.id = j.campaign_id WHERE j.status = 'queued' AND (c.scheduled_at IS NULL OR c.scheduled_at <= CURRENT_TIMESTAMP) ORDER BY j.created_at LIMIT 1");
  if (!rows[0]) return null;
  const [result] = await pool.execute("UPDATE send_jobs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), last_activity_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'", [rows[0].id]);
  return result.affectedRows ? rows[0].id : null;
}

async function workJob(jobId) {
  const [[job]] = await pool.execute(`SELECT j.*, j.campaign_id AS campaignId, j.batch_size AS batchSize, j.rate_per_second AS ratePerSecond, c.name AS campaignName, c.subject, c.preheader, c.from_name AS fromName, c.from_email AS fromEmail, c.reply_to AS replyTo, v.html, s.aws_region AS awsRegion, s.access_key_encrypted AS accessKeyEncrypted, s.secret_key_encrypted AS secretKeyEncrypted, s.default_from_name AS defaultFromName, s.default_from_email AS defaultFromEmail, s.default_reply_to AS defaultReplyTo FROM send_jobs j JOIN campaigns c ON c.id = j.campaign_id JOIN template_versions v ON v.id = c.template_version_id JOIN ses_accounts s ON s.id = c.ses_account_id WHERE j.id = ?`, [jobId]);
  if (!job) return;
  while (true) {
    const [[freshJob]] = await pool.execute("SELECT status FROM send_jobs WHERE id = ?", [jobId]);
    if (!freshJob || freshJob.status !== "running") return;
    const batchSize = Math.max(1, Math.floor(Number(job.batchSize) || 10));
    const [recipients] = await pool.execute(`SELECT id, email, tracking_token AS trackingToken FROM campaign_recipients WHERE campaign_id = ? AND (status IN ('pending', 'queued') OR (status = 'failed' AND attempts < ${maxAttempts})) ORDER BY id LIMIT ${batchSize}`, [job.campaignId]);
    if (!recipients.length) break;
    for (const recipient of recipients) {
      const [claimed] = await pool.execute(`UPDATE campaign_recipients SET status = 'sending', sending_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ? AND (status IN ('pending', 'queued') OR (status = 'failed' AND attempts < ${maxAttempts}))`, [recipient.id]);
      if (!claimed.affectedRows) continue;
      try {
        const imageUrl = `${baseUrl}/api/email-tracking/image?token=${recipient.trackingToken}`;
        const pixelUrl = `${baseUrl}/api/email-tracking/open.gif?token=${recipient.trackingToken}`;
        const html = renderTemplate(job.html, { email: recipient.email, campaign_name: job.campaignName, tracking_image_url: imageUrl, tracking_pixel_url: pixelUrl, preheader: job.preheader || "" });
        const providerMessageId = await sendWithSes({ profile: job, encryptionKey, to: recipient.email, subject: job.subject, html, replyTo: job.replyTo || job.defaultReplyTo });
        await pool.execute("UPDATE campaign_recipients SET status = 'sent', sent_at = CURRENT_TIMESTAMP, provider_message_id = ?, last_error = NULL WHERE id = ?", [providerMessageId, recipient.id]);
      } catch (error) {
        await pool.execute("UPDATE campaign_recipients SET status = 'failed', failed_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?", [String(error.message || error).slice(0, 4000), recipient.id]);
      }
      await pool.execute("UPDATE send_jobs SET processed = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ('sent', 'failed')), sent = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'sent'), failed = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status = 'failed'), pending = (SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ('pending', 'queued', 'sending')), last_activity_at = CURRENT_TIMESTAMP WHERE id = ?", [job.campaignId, job.campaignId, job.campaignId, job.campaignId, jobId]);
      await sleep(Math.ceil(1000 / Math.max(1, job.ratePerSecond)));
    }
  }
  await pool.execute("UPDATE send_jobs SET status = 'completed', finished_at = CURRENT_TIMESTAMP, last_activity_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'", [jobId]);
  await pool.execute("UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'sending'", [job.campaignId]);
}

async function loop() {
  for (;;) {
    const jobId = await claimJob();
    if (jobId) await workJob(jobId); else await sleep(2000);
  }
}

loop().catch((error) => { console.error("worker failed", error); process.exit(1); });
