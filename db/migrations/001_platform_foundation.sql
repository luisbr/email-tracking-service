-- First platform migration. It only adds tables/columns; existing tracking rows remain valid.

CREATE TABLE IF NOT EXISTS accounts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    slug VARCHAR(160) NOT NULL,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_accounts_slug (slug)
);

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_account_email (account_id, email),
    CONSTRAINT fk_users_account FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS clients (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    slug VARCHAR(160) NOT NULL,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_clients_account_slug (account_id, slug),
    INDEX idx_clients_account (account_id),
    CONSTRAINT fk_clients_account FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE IF NOT EXISTS ses_accounts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    client_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    aws_region VARCHAR(40) NOT NULL,
    access_key_encrypted TEXT NOT NULL,
    secret_key_encrypted TEXT NOT NULL,
    default_from_name VARCHAR(160) NULL,
    default_from_email VARCHAR(255) NULL,
    default_reply_to VARCHAR(255) NULL,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ses_accounts_client (client_id),
    CONSTRAINT fk_ses_accounts_account FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT fk_ses_accounts_client FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS templates (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    client_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    description TEXT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_templates_client_name (client_id, name),
    INDEX idx_templates_account (account_id),
    CONSTRAINT fk_templates_account FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT fk_templates_client FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS template_versions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    template_id BIGINT UNSIGNED NOT NULL,
    version INT UNSIGNED NOT NULL,
    html MEDIUMTEXT NOT NULL,
    subject VARCHAR(255) NULL,
    preheader VARCHAR(500) NULL,
    source_type ENUM('manual', 'ai', 'clone', 'imported') NOT NULL DEFAULT 'manual',
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_template_versions_version (template_id, version),
    CONSTRAINT fk_template_versions_template FOREIGN KEY (template_id) REFERENCES templates(id),
    CONSTRAINT fk_template_versions_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    client_id BIGINT UNSIGNED NOT NULL,
    ses_account_id BIGINT UNSIGNED NULL,
    audience_id BIGINT UNSIGNED NULL,
    template_version_id BIGINT UNSIGNED NULL,
    name VARCHAR(160) NOT NULL,
    subject VARCHAR(255) NULL,
    preheader VARCHAR(500) NULL,
    from_name VARCHAR(160) NULL,
    from_email VARCHAR(255) NULL,
    reply_to VARCHAR(255) NULL,
    status ENUM('draft', 'test_ready', 'test_sent', 'approved', 'scheduled', 'sending', 'paused', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'draft',
    scheduled_at DATETIME NULL,
    started_at DATETIME NULL,
    completed_at DATETIME NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_campaigns_client_name (client_id, name),
    INDEX idx_campaigns_account_status (account_id, status),
    CONSTRAINT fk_campaigns_account FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT fk_campaigns_client FOREIGN KEY (client_id) REFERENCES clients(id),
    CONSTRAINT fk_campaigns_ses_account FOREIGN KEY (ses_account_id) REFERENCES ses_accounts(id) ON DELETE SET NULL,
    CONSTRAINT fk_campaigns_template_version FOREIGN KEY (template_version_id) REFERENCES template_versions(id) ON DELETE SET NULL,
    CONSTRAINT fk_campaigns_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audiences (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    client_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    description TEXT NULL,
    total_contacts INT UNSIGNED NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_audiences_client_name (client_id, name),
    INDEX idx_audiences_account (account_id),
    CONSTRAINT fk_audiences_account FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT fk_audiences_client FOREIGN KEY (client_id) REFERENCES clients(id),
    CONSTRAINT fk_audiences_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audience_contacts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    audience_id BIGINT UNSIGNED NOT NULL,
    email VARCHAR(255) NOT NULL,
    name VARCHAR(160) NULL,
    metadata_json JSON NULL,
    status ENUM('active', 'unsubscribed', 'hard_bounce', 'complaint', 'suppressed') NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_audience_contacts_email (audience_id, email),
    INDEX idx_audience_contacts_status (audience_id, status),
    CONSTRAINT fk_audience_contacts_audience FOREIGN KEY (audience_id) REFERENCES audiences(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assets (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT UNSIGNED NOT NULL,
    client_id BIGINT UNSIGNED NOT NULL,
    campaign_id BIGINT UNSIGNED NULL,
    name VARCHAR(160) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    s3_key VARCHAR(1024) NOT NULL,
    public_url VARCHAR(2048) NOT NULL,
    mime_type VARCHAR(120) NOT NULL,
    size BIGINT UNSIGNED NOT NULL,
    width INT UNSIGNED NULL,
    height INT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_assets_client (client_id),
    INDEX idx_assets_campaign (campaign_id),
    CONSTRAINT fk_assets_account FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT fk_assets_client FOREIGN KEY (client_id) REFERENCES clients(id),
    CONSTRAINT fk_assets_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
);

-- Keep the old string campaign and link token flow intact. MySQL versions on the
-- deployment host do not support ADD ... IF NOT EXISTS, so use catalog checks.
DROP PROCEDURE IF EXISTS apply_platform_foundation_alters;
DELIMITER //
CREATE PROCEDURE apply_platform_foundation_alters()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'email_tracking_links' AND column_name = 'campaign_id') THEN
    ALTER TABLE email_tracking_links ADD COLUMN campaign_id BIGINT UNSIGNED NULL AFTER campaign;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'email_tracking_links' AND index_name = 'idx_email_tracking_links_campaign_id') THEN
    ALTER TABLE email_tracking_links ADD INDEX idx_email_tracking_links_campaign_id (campaign_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND column_name = 'audience_id') THEN
    ALTER TABLE campaigns ADD COLUMN audience_id BIGINT UNSIGNED NULL AFTER ses_account_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'audiences' AND column_name = 'created_by') THEN
    ALTER TABLE audiences ADD COLUMN created_by BIGINT UNSIGNED NULL AFTER total_contacts;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND constraint_name = 'fk_campaigns_audience') THEN
    ALTER TABLE campaigns ADD CONSTRAINT fk_campaigns_audience FOREIGN KEY (audience_id) REFERENCES audiences(id) ON DELETE SET NULL;
  END IF;
END//
DELIMITER ;
CALL apply_platform_foundation_alters();
DROP PROCEDURE apply_platform_foundation_alters;
