import nodemailer from 'nodemailer';
import { getSmtpSettingsForSending } from '../smtpSettings/repository.js';
import { logger } from '../logger.js';

async function resolveSmtpConfig() {
  let settings = null;
  if (process.env.DATABASE_URL) {
    try {
      settings = await getSmtpSettingsForSending();
    } catch (err) {
      logger.error('failed to read smtp_settings, falling back to environment variables', { error: err.message });
    }
  }
  return {
    host: settings?.host || process.env.SMTP_HOST,
    port: settings?.port || Number(process.env.SMTP_PORT || 587),
    username: settings?.username || process.env.SMTP_USER,
    password: settings?.password || process.env.SMTP_PASS,
    from: settings?.fromAddress || process.env.SMTP_FROM || 'no-reply@pakyrion.local',
  };
}

export async function getTransporterAndFrom() {
  const { host, port, username, password, from } = await resolveSmtpConfig();
  const transporter = host
    ? nodemailer.createTransport({
        host,
        port,
        auth: username ? { user: username, pass: password } : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      })
    : nodemailer.createTransport({ jsonTransport: true });
  return { transporter, from };
}

export function baseUrl() {
  return process.env.APP_BASE_URL || 'http://localhost:3000';
}

export async function sendVerificationEmail(to, token) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${baseUrl()}/verify.html?token=${token}`;
  return transporter.sendMail({
    to,
    from,
    subject: 'Bitte bestätige deine E-Mail-Adresse',
    text: `Bitte bestätige deine E-Mail-Adresse: ${url}`,
  });
}

export async function sendPasswordResetEmail(to, token) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${baseUrl()}/reset-password.html?token=${token}`;
  return transporter.sendMail({
    to,
    from,
    subject: 'Passwort zurücksetzen',
    text: `Setze dein Passwort zurück: ${url}`,
  });
}

export async function sendInvitationEmail(to, token) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${baseUrl()}/set-password.html?token=${token}`;
  return transporter.sendMail({
    to,
    from,
    subject: 'Du wurdest zu Pakyrion eingeladen',
    text: `Du wurdest eingeladen. Setze dein Passwort, um loszulegen: ${url}`,
  });
}

export async function sendRegistrationOtFieldsChangedEmail(to, { userName, eventName }, { transporter, from }) {
  return transporter.sendMail({
    to,
    from,
    subject: `Anmeldungsdaten geändert: ${eventName}`,
    text: `Die Con-Tage/Unterbringung/Handwerk/Anreise/Opt-Out-Angaben der Anmeldung von ${userName} für "${eventName}" wurden nachträglich geändert.`,
  });
}

export async function sendWaitlistedEmail(to, { eventName }, { transporter, from }) {
  return transporter.sendMail({
    to,
    from,
    subject: `Warteliste: ${eventName}`,
    text: `Deine Anmeldung für "${eventName}" ist eingegangen, das Event ist aber bereits ausgebucht. Du stehst auf der Warteliste und wirst benachrichtigt, sobald ein Platz frei wird.`,
  });
}

export async function sendWaitlistPromotedEmail(to, { eventName }, { transporter, from }) {
  return transporter.sendMail({
    to,
    from,
    subject: `Ein Platz ist frei geworden: ${eventName}`,
    text: `Für "${eventName}" ist ein Platz frei geworden — deine Anmeldung wurde von der Warteliste in die reguläre Anmeldung übernommen und wird nun wie gewohnt von der Orga bearbeitet.`,
  });
}

export async function sendEventDeletedEmail(to, { eventName }, { transporter, from }) {
  return transporter.sendMail({
    to,
    from,
    subject: `Event abgesagt: ${eventName}`,
    text: `Das Event "${eventName}" wurde abgesagt und gelöscht. Deine Anmeldung dafür wurde entfernt.`,
  });
}
