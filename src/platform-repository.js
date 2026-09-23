function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function requireText(value, field, maxLength = 255) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${field} is required`);
  return text.slice(0, maxLength);
}

function parseCsv(content) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (character === '"') {
      if (quoted && next === '"') { field += '"'; index += 1; } else quoted = !quoted;
    } else if (character === "," && !quoted) { row.push(field); field = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(field); if (row.some((value) => value.trim())) rows.push(row); row = []; field = "";
    } else field += character;
  }
  row.push(field); if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseContactsCsv(csv) {
  const rows = parseCsv(String(csv || ""));
  if (rows.length < 2) throw new Error("CSV must include a header and at least one contact");
  const headers = rows[0].map((header) => header.trim());
  const index = Object.fromEntries(headers.map((header, position) => [header.toLowerCase(), position]));
  const emailIndex = index.email ?? index.correo;
  if (emailIndex === undefined) throw new Error("CSV must include an email or correo column");
  const nameIndex = index.name ?? index.nombre;
  return rows.slice(1).map((row) => {
    const metadata = {};
    headers.forEach((header, position) => {
      if (position !== emailIndex && position !== nameIndex && header) metadata[header] = row[position] || "";
    });
    return { email: String(row[emailIndex] || "").trim().toLowerCase(), name: nameIndex === undefined ? "" : String(row[nameIndex] || "").trim(), metadata };
  }).filter((contact) => contact.email);
}

const campaignTransitions = {
  draft: ["test_ready", "cancelled"],
  test_ready: ["test_sent", "cancelled"],
  test_sent: ["test_ready", "approved", "cancelled"],
  approved: ["scheduled", "sending", "cancelled"],
  scheduled: ["sending", "paused", "cancelled"],
  sending: ["paused", "completed", "failed"],
  paused: ["sending", "cancelled"],
  completed: [],
  failed: ["paused", "cancelled"],
  cancelled: []
};

export function createPlatformRepository(pool) {
  async function assertClient(accountId, clientId) {
    const [rows] = await pool.execute("SELECT id FROM clients WHERE id = ? AND account_id = ? LIMIT 1", [clientId, accountId]);
    if (!rows[0]) throw new Error("client not found for account");
  }

  async function resolveCreatedBy(accountId, value) {
    if (value === undefined || value === null || value === "") return null;
    const userId = Number(value);
    if (!Number.isSafeInteger(userId) || userId < 1) throw new Error("createdBy must be a valid user id");
    const [rows] = await pool.execute("SELECT id FROM users WHERE id = ? AND account_id = ? LIMIT 1", [userId, accountId]);
    if (!rows[0]) throw new Error("createdBy user not found for account");
    return userId;
  }

  return {
    async resolveDefaultAccount(configuredAccountId, configuredAccountName) {
      const accountId = Number(configuredAccountId);
      if (Number.isSafeInteger(accountId) && accountId > 0) {
        const [rows] = await pool.execute("SELECT id, name, slug FROM accounts WHERE id = ? LIMIT 1", [accountId]);
        if (!rows[0]) throw new Error("PLATFORM_DEFAULT_ACCOUNT_ID does not exist");
        return rows[0];
      }
      const slug = normalizeSlug(configuredAccountName || "lbr") || "lbr";
      const [rows] = await pool.execute("SELECT id, name, slug FROM accounts WHERE slug = ? LIMIT 1", [slug]);
      if (rows[0]) return rows[0];
      const name = String(configuredAccountName || "LBR").trim().slice(0, 160) || "LBR";
      const [result] = await pool.execute("INSERT INTO accounts (name, slug) VALUES (?, ?)", [name, slug]);
      return { id: result.insertId, name, slug };
    },
    async listClients(accountId) {
      const [rows] = await pool.execute("SELECT id, name, slug, status, created_at AS createdAt, updated_at AS updatedAt FROM clients WHERE account_id = ? ORDER BY name", [accountId]);
      return rows;
    },
    async createClient(accountId, input) {
      const name = requireText(input.name, "name", 160);
      const slug = normalizeSlug(input.slug || name);
      if (!slug) throw new Error("slug is required");
      const [result] = await pool.execute("INSERT INTO clients (account_id, name, slug) VALUES (?, ?, ?)", [accountId, name, slug]);
      return { id: result.insertId, name, slug, status: "active" };
    },
    async updateClient(accountId, clientId, input) {
      const name = requireText(input.name, "name", 160);
      const slug = normalizeSlug(input.slug || name);
      const status = ["active", "inactive"].includes(input.status) ? input.status : "active";
      const [result] = await pool.execute("UPDATE clients SET name = ?, slug = ?, status = ? WHERE id = ? AND account_id = ?", [name, slug, status, clientId, accountId]);
      if (!result.affectedRows) throw new Error("client not found for account");
      return { id: clientId, name, slug, status };
    },
    async listCampaigns(accountId, clientId) {
      const conditions = ["c.account_id = ?"];
      const params = [accountId];
      if (clientId) { conditions.push("c.client_id = ?"); params.push(clientId); }
      const [rows] = await pool.execute(`SELECT c.id, c.name, c.subject, c.preheader, c.status, c.audience_id AS audienceId, c.template_version_id AS templateVersionId, c.scheduled_at AS scheduledAt, c.created_at AS createdAt, cl.name AS clientName FROM campaigns c JOIN clients cl ON cl.id = c.client_id WHERE ${conditions.join(" AND ")} ORDER BY c.created_at DESC`, params);
      return rows;
    },
    async createCampaign(accountId, input) {
      const clientId = Number(input.clientId);
      if (!Number.isSafeInteger(clientId) || clientId < 1) throw new Error("clientId is required");
      await assertClient(accountId, clientId);
      const audienceId = input.audienceId === undefined || input.audienceId === null || input.audienceId === "" ? null : Number(input.audienceId);
      if (audienceId !== null) {
        if (!Number.isSafeInteger(audienceId) || audienceId < 1) throw new Error("audienceId must be a valid audience id");
        const [rows] = await pool.execute("SELECT id FROM audiences WHERE id = ? AND account_id = ? AND client_id = ? LIMIT 1", [audienceId, accountId, clientId]);
        if (!rows[0]) throw new Error("audience not found for client");
      }
      const templateVersionId = input.templateVersionId === undefined || input.templateVersionId === null || input.templateVersionId === "" ? null : Number(input.templateVersionId);
      if (templateVersionId !== null) {
        if (!Number.isSafeInteger(templateVersionId) || templateVersionId < 1) throw new Error("templateVersionId must be a valid template version id");
        const [rows] = await pool.execute("SELECT v.id FROM template_versions v JOIN templates t ON t.id = v.template_id WHERE v.id = ? AND t.account_id = ? AND t.client_id = ? LIMIT 1", [templateVersionId, accountId, clientId]);
        if (!rows[0]) throw new Error("template version not found for client");
      }
      const sesAccountId = input.sesAccountId === undefined || input.sesAccountId === null || input.sesAccountId === "" ? null : Number(input.sesAccountId);
      if (sesAccountId !== null) {
        if (!Number.isSafeInteger(sesAccountId) || sesAccountId < 1) throw new Error("sesAccountId must be a valid SES account id");
        const [rows] = await pool.execute("SELECT id FROM ses_accounts WHERE id = ? AND account_id = ? AND client_id = ? AND status = 'active' LIMIT 1", [sesAccountId, accountId, clientId]);
        if (!rows[0]) throw new Error("SES account not found for client");
      }
      const createdBy = await resolveCreatedBy(accountId, input.createdBy);
      const name = requireText(input.name, "name", 160);
      const subject = String(input.subject || "").trim().slice(0, 255) || null;
      const preheader = String(input.preheader || "").trim().slice(0, 500) || null;
      const [result] = await pool.execute("INSERT INTO campaigns (account_id, client_id, ses_account_id, audience_id, template_version_id, name, subject, preheader, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [accountId, clientId, sesAccountId, audienceId, templateVersionId, name, subject, preheader, createdBy]);
      return { id: result.insertId, clientId, sesAccountId, audienceId, templateVersionId, name, subject, preheader, createdBy, status: "draft" };
    },
    async transitionCampaign(accountId, campaignId, nextStatus) {
      const [rows] = await pool.execute("SELECT status FROM campaigns WHERE id = ? AND account_id = ? LIMIT 1", [campaignId, accountId]);
      const currentStatus = rows[0]?.status;
      if (!currentStatus) throw new Error("campaign not found for account");
      if (!campaignTransitions[currentStatus].includes(nextStatus)) throw new Error(`invalid campaign transition: ${currentStatus} -> ${nextStatus}`);
      await pool.execute("UPDATE campaigns SET status = ? WHERE id = ?", [nextStatus, campaignId]);
      return { id: campaignId, status: nextStatus };
    },
    async listAudiences(accountId, clientId) {
      const conditions = ["a.account_id = ?"];
      const params = [accountId];
      if (clientId) { conditions.push("a.client_id = ?"); params.push(clientId); }
      const [rows] = await pool.execute(`SELECT a.id, a.name, a.description, a.total_contacts AS totalContacts, a.created_at AS createdAt, c.name AS clientName FROM audiences a JOIN clients c ON c.id = a.client_id WHERE ${conditions.join(" AND ")} ORDER BY a.name`, params);
      return rows;
    },
    async createAudience(accountId, input) {
      const clientId = Number(input.clientId);
      if (!Number.isSafeInteger(clientId) || clientId < 1) throw new Error("clientId is required");
      await assertClient(accountId, clientId);
      const name = requireText(input.name, "name", 160);
      const description = String(input.description || "").trim() || null;
      const createdBy = await resolveCreatedBy(accountId, input.createdBy);
      const [result] = await pool.execute("INSERT INTO audiences (account_id, client_id, name, description, created_by) VALUES (?, ?, ?, ?, ?)", [accountId, clientId, name, description, createdBy]);
      return { id: result.insertId, clientId, name, description, createdBy, totalContacts: 0 };
    },
    async deleteAudience(accountId, audienceId) {
      const [result] = await pool.execute("DELETE FROM audiences WHERE id = ? AND account_id = ?", [audienceId, accountId]);
      if (!result.affectedRows) throw new Error("audience not found for account");
    },
    async importAudienceContacts(accountId, audienceId, csv) {
      const [audienceRows] = await pool.execute("SELECT id FROM audiences WHERE id = ? AND account_id = ? LIMIT 1", [audienceId, accountId]);
      if (!audienceRows[0]) throw new Error("audience not found for account");
      const contacts = parseContactsCsv(csv);
      const connection = await pool.getConnection();
      let imported = 0;
      let duplicates = 0;
      try {
        await connection.beginTransaction();
        for (const contact of contacts) {
          const [result] = await connection.execute("INSERT IGNORE INTO audience_contacts (audience_id, email, name, metadata_json) VALUES (?, ?, ?, ?)", [audienceId, contact.email.slice(0, 255), contact.name.slice(0, 160) || null, Object.keys(contact.metadata).length ? JSON.stringify(contact.metadata) : null]);
          if (result.affectedRows) imported += 1; else duplicates += 1;
        }
        await connection.execute("UPDATE audiences SET total_contacts = (SELECT COUNT(*) FROM audience_contacts WHERE audience_id = ?) WHERE id = ?", [audienceId, audienceId]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
      return { received: contacts.length, imported, duplicates };
    },
    async listTemplates(accountId, clientId) {
      const conditions = ["t.account_id = ?"];
      const params = [accountId];
      if (clientId) { conditions.push("t.client_id = ?"); params.push(clientId); }
      const [rows] = await pool.execute(`SELECT t.id, t.name, t.description, t.created_at AS createdAt, c.name AS clientName, MAX(v.version) AS latestVersion FROM templates t JOIN clients c ON c.id = t.client_id LEFT JOIN template_versions v ON v.template_id = t.id WHERE ${conditions.join(" AND ")} GROUP BY t.id ORDER BY t.updated_at DESC`, params);
      return rows;
    },
    async createTemplate(accountId, input) {
      const clientId = Number(input.clientId);
      if (!Number.isSafeInteger(clientId) || clientId < 1) throw new Error("clientId is required");
      await assertClient(accountId, clientId);
      const name = requireText(input.name, "name", 160);
      const html = requireText(input.html, "html", 16_000_000);
      const description = String(input.description || "").trim() || null;
      const sourceType = ["manual", "ai", "clone", "imported"].includes(input.sourceType) ? input.sourceType : "manual";
      const createdBy = await resolveCreatedBy(accountId, input.createdBy);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [template] = await connection.execute("INSERT INTO templates (account_id, client_id, name, description) VALUES (?, ?, ?, ?)", [accountId, clientId, name, description]);
        const [version] = await connection.execute("INSERT INTO template_versions (template_id, version, html, subject, preheader, source_type, created_by) VALUES (?, 1, ?, ?, ?, ?, ?)", [template.insertId, html, String(input.subject || "").trim().slice(0, 255) || null, String(input.preheader || "").trim().slice(0, 500) || null, sourceType, createdBy]);
        await connection.commit();
        return { id: template.insertId, versionId: version.insertId, version: 1, name };
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
    async addTemplateVersion(accountId, templateId, input) {
      const [rows] = await pool.execute("SELECT t.id FROM templates t WHERE t.id = ? AND t.account_id = ? LIMIT 1", [templateId, accountId]);
      if (!rows[0]) throw new Error("template not found for account");
      const html = requireText(input.html, "html", 16_000_000);
      const sourceType = ["manual", "ai", "clone", "imported"].includes(input.sourceType) ? input.sourceType : "manual";
      const createdBy = await resolveCreatedBy(accountId, input.createdBy);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [versionRows] = await connection.execute("SELECT COALESCE(MAX(version), 0) + 1 AS nextVersion FROM template_versions WHERE template_id = ? FOR UPDATE", [templateId]);
        const version = Number(versionRows[0].nextVersion);
        const [result] = await connection.execute("INSERT INTO template_versions (template_id, version, html, subject, preheader, source_type, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)", [templateId, version, html, String(input.subject || "").trim().slice(0, 255) || null, String(input.preheader || "").trim().slice(0, 500) || null, sourceType, createdBy]);
        await connection.execute("UPDATE templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [templateId]);
        await connection.commit();
        return { id: result.insertId, templateId, version };
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    }
  };
}
