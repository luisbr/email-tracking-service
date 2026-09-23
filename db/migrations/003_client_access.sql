-- Client-scoped accounts. Existing environment-admin authentication remains valid.
DROP PROCEDURE IF EXISTS apply_client_access_columns;
DELIMITER //
CREATE PROCEDURE apply_client_access_columns()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'role') THEN
    ALTER TABLE users ADD COLUMN role ENUM('admin', 'client') NOT NULL DEFAULT 'client' AFTER password_hash;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'client_id') THEN
    ALTER TABLE users ADD COLUMN client_id BIGINT UNSIGNED NULL AFTER account_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'idx_users_client') THEN
    ALTER TABLE users ADD INDEX idx_users_client (client_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'users' AND constraint_name = 'fk_users_client') THEN
    ALTER TABLE users ADD CONSTRAINT fk_users_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL;
  END IF;
END//
DELIMITER ;
CALL apply_client_access_columns();
DROP PROCEDURE apply_client_access_columns;
