-- A managed person's invitation link can be created without an e-mail address; it is entered when the link is redeemed.
ALTER TABLE invitations ALTER COLUMN email DROP NOT NULL;
