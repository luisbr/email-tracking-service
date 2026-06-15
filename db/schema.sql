CREATE TABLE IF NOT EXISTS email_tracking_links (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    token CHAR(64) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL,
    campaign VARCHAR(120) NOT NULL,
    asset_path VARCHAR(255) NOT NULL DEFAULT '/image/060926-Mailing2_01.png',
    metadata_json JSON NULL,
    open_count INT UNSIGNED NOT NULL DEFAULT 0,
    last_opened_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email_tracking_links_campaign (campaign),
    INDEX idx_email_tracking_links_email (email)
);

CREATE TABLE IF NOT EXISTS email_tracking_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tracking_link_id BIGINT UNSIGNED NOT NULL,
    event_type ENUM('pixel_open', 'image_open') NOT NULL,
    user_agent VARCHAR(500) NULL,
    ip_address VARCHAR(80) NULL,
    referer VARCHAR(500) NULL,
    query_string VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_email_tracking_events_link (tracking_link_id),
    INDEX idx_email_tracking_events_type (event_type),
    CONSTRAINT fk_email_tracking_events_link
        FOREIGN KEY (tracking_link_id) REFERENCES email_tracking_links(id)
        ON DELETE CASCADE
);
