import nodemailer from 'nodemailer';

let transporter;

function getTransporter() {
  if (!transporter) {
    transporter = process.env.SMTP_HOST
      ? nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        })
      : nodemailer.createTransport({ jsonTransport: true });
  }
  return transporter;
}

function fromAddress() {
  return process.env.SMTP_FROM || 'no-reply@pakyrion.local';
}

function baseUrl() {
  return process.env.APP_BASE_URL || 'http://localhost:3000';
}

export async function sendVerificationEmail(to, token) {
  const url = `${baseUrl()}/verify?token=${token}`;
  return getTransporter().sendMail({
    to,
    from: fromAddress(),
    subject: 'Bitte bestätige deine E-Mail-Adresse',
    text: `Bitte bestätige deine E-Mail-Adresse: ${url}`,
  });
}

export async function sendPasswordResetEmail(to, token) {
  const url = `${baseUrl()}/reset-password?token=${token}`;
  return getTransporter().sendMail({
    to,
    from: fromAddress(),
    subject: 'Passwort zurücksetzen',
    text: `Setze dein Passwort zurück: ${url}`,
  });
}
