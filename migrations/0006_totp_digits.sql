-- Existing active and pending bindings were issued with eight digits.
ALTER TABLE admin_auth ADD COLUMN totp_digits INTEGER NOT NULL DEFAULT 8 CHECK (totp_digits IN (6, 8));
