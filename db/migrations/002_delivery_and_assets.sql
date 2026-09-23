-- Second/third iteration: persistent delivery, test sends and uploaded assets.

CREATE TABLE IF NOT EXISTS campaign_recipients (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    audience_contact_id BIGINT UNSIGNED NULL,
    tracking_link_id BIGINT UNSIGNED NULL,
    email VARCHAR(255) NOT NULL,
    tracking_token CHAR(64) NOT NULL,
    status ENUM('pending', 'queued', 'sending', 'sent', 'failed', 'skipped', 'suppressed') NOT NULL DEFAULT 'pending',
    queued_at DATETIME NULL,
    sending_at DATETIME NULL,
    sent_at DATETIME NULL,
    failed_at DATETIME NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    provider_message_id VARCHAR(255) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_campaign_recipients_email (campaign_id, email),
    UNIQUE KEY uq_campaign_recipients_token (tracking_token),
    UNIQUE KEY uq_campaign_recipients_tracking_link (tracking_link_id),
    INDEX idx_campaign_recipients_work (campaign_id, status, id),
    CONSTRAINT fk_campaign_recipients_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_campaign_recipients_contact FOREIGN KEY (audience_contact_id) REFERENCES audience_contacts(id) ON DELETE SET NULL,
    CONSTRAINT fk_campaign_recipients_tracking_link FOREIGN KEY (tracking_link_id) REFERENCES email_tracking_links(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS campaign_tests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    email VARCHAR(255) NOT NULL,
    tracking_link_id BIGINT UNSIGNED NULL,
    status ENUM('sent', 'failed') NOT NULL,
    provider_message_id VARCHAR(255) NULL,
    last_error TEXT NULL,
    sent_by BIGINT UNSIGNED NULL,
    sent_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_campaign_tests_campaign (campaign_id, created_at),
    CONSTRAINT fk_campaign_tests_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_campaign_tests_tracking_link FOREIGN KEY (tracking_link_id) REFERENCES email_tracking_links(id) ON DELETE SET NULL,
    CONSTRAINT fk_campaign_tests_user FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS campaign_approvals (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_campaign_approvals_campaign (campaign_id),
    CONSTRAINT fk_campaign_approvals_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
    CONSTRAINT fk_campaign_approvals_user FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS send_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNSIGNED NOT NULL,
    status ENUM('queued', 'running', 'paused', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
    total INT UNSIGNED NOT NULL DEFAULT 0,
    processed INT UNSIGNED NOT NULL DEFAULT 0,
    sent INT UNSIGNED NOT NULL DEFAULT 0,
    failed INT UNSIGNED NOT NULL DEFAULT 0,
    pending INT UNSIGNED NOT NULL DEFAULT 0,
    rate_per_second INT UNSIGNED NOT NULL DEFAULT 1,
    batch_size INT UNSIGNED NOT NULL DEFAULT 10,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    last_activity_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_send_jobs_work (status, created_at),
    CONSTRAINT fk_send_jobs_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

DROP PROCEDURE IF EXISTS apply_delivery_columns;
DELIMITER //
CREATE PROCEDURE apply_delivery_columns()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND column_name = 'test_sent_at') THEN
    ALTER TABLE campaigns ADD COLUMN test_sent_at DATETIME NULL AFTER completed_at;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND column_name = 'approved_at') THEN
    ALTER TABLE campaigns ADD COLUMN approved_at DATETIME NULL AFTER test_sent_at;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'campaigns' AND column_name = 'approved_by') THEN
    ALTER TABLE campaigns ADD COLUMN approved_by BIGINT UNSIGNED NULL AFTER approved_at;
  END IF;
END//
DELIMITER ;
CALL apply_delivery_columns();
DROP PROCEDURE apply_delivery_columns;
