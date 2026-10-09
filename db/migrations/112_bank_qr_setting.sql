-- Whether the manual bank transfer offers a QR code (Girocode) to pay.
ALTER TABLE payment_settings ADD COLUMN bank_qr_enabled boolean NOT NULL DEFAULT true;
