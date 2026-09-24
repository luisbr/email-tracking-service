import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const recipientStatuses = ["pending", "queued", "sending", "sent", "failed", "skipped", "suppressed"];

export function encryptSecret(value, encryptionKey) {
  const key = Buffer.from(encryptionKey || "", "base64");
  if (key.length !== 32) throw new Error("PLATFORM_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value, encryptionKey) {
  const key = Buffer.from(encryptionKey || "", "base64");
  if (key.length !== 32) throw new Error("PLATFORM_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  const [iv, tag, encrypted] = String(value || "").split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !encrypted) throw new Error("invalid encrypted credential");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function buildSesClient(profile, encryptionKey) {
  return new SESv2Client({
    region: profile.awsRegion,
    credentials: {
      accessKeyId: decryptSecret(profile.accessKeyEncrypted, encryptionKey),
      secretAccessKey: decryptSecret(profile.secretKeyEncrypted, encryptionKey)
    }
  });
}

export async function sendWithSes({ profile, encryptionKey, to, subject, html, replyTo }) {
  const client = buildSesClient(profile, encryptionKey);
  const from = profile.defaultFromName ? `${profile.defaultFromName} <${profile.defaultFromEmail}>` : profile.defaultFromEmail;
  const result = await client.send(new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: [replyTo || profile.defaultReplyTo].filter(Boolean),
    Content: { Simple: { Subject: { Data: subject || "" }, Body: { Html: { Data: html } } } }
  }));
  return result.MessageId || null;
}

export function renderTemplate(html, values) {
  const rendered = String(html || "").replace(/{{\s*([a-z_]+)\s*}}/gi, (_, key) => String(values[key] ?? ""));
  const pixelUrl = String(values.tracking_pixel_url || "");
  if (!pixelUrl || rendered.includes(pixelUrl)) return rendered;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;border:0;outline:none" />`;
  return /<\/body\s*>/i.test(rendered) ? rendered.replace(/<\/body\s*>/i, `${pixel}</body>`) : `${rendered}${pixel}`;
}

export async function uploadAssetToS3({ region, bucket, accessKeyId, secretAccessKey, key, body, mimeType }) {
  const client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: mimeType }));
  return `https://${bucket}.s3.${region}.amazonaws.com/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function isRecipientStatus(value) {
  return recipientStatuses.includes(value);
}
