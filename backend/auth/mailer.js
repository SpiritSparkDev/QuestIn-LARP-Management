import nodemailer from 'nodemailer';
import { getSmtpSettingsForSending } from '../smtpSettings/repository.js';
import { getAppSettings, DEFAULT_BASE_URL } from '../appSettings/repository.js';
import { logger } from '../logger.js';
import { renderSlotEmail } from '../emailTemplates/send.js';

// Delivers whatever renderSlotEmail resolved to (an admin-assigned template
// or the slot's hardcoded fallback text) -- isHtml picks sendMail's html vs
// text option, same rule as the manual "send test" flow in
// backend/emailTemplates/routes.js.
function deliver(transporter, from, to, { subject, body, isHtml }) {
  return transporter.sendMail({ to, from, subject, ...(isHtml ? { html: body } : { text: body }) });
}

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

export async function baseUrl() {
  if (process.env.DATABASE_URL) {
    try {
      const settings = await getAppSettings();
      return settings.effectiveBaseUrl;
    } catch (err) {
      logger.error('failed to read app_settings, falling back to environment variable', { error: err.message });
    }
  }
  return process.env.APP_BASE_URL || DEFAULT_BASE_URL;
}

export async function sendVerificationEmail(to, token, { userId } = {}) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${await baseUrl()}/verify.html?token=${token}`;
  const rendered = await renderSlotEmail('verification', () => ({
    subject: 'Bitte bestätige deine E-Mail-Adresse',
    body: `Bitte bestätige deine E-Mail-Adresse: ${url}`,
  }), { userId, extra: { link: url } });
  return deliver(transporter, from, to, rendered);
}

export async function sendPasswordResetEmail(to, token, { userId } = {}) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${await baseUrl()}/reset-password.html?token=${token}`;
  const rendered = await renderSlotEmail('password_reset', () => ({
    subject: 'Passwort zurücksetzen',
    body: `Setze dein Passwort zurück: ${url}`,
  }), { userId, extra: { link: url } });
  return deliver(transporter, from, to, rendered);
}

export async function sendInvitationEmail(to, token, { account } = {}) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${await baseUrl()}/set-password.html?token=${token}`;
  const rendered = await renderSlotEmail('invitation', () => ({
    subject: 'Du wurdest zu Pakyrion eingeladen',
    body: `Du wurdest eingeladen. Setze dein Passwort, um loszulegen: ${url}`,
  }), { account, extra: { link: url } });
  return deliver(transporter, from, to, rendered);
}

export async function sendRegistrationOtFieldsChangedEmail(to, { userName, eventName }, { transporter, from }) {
  const rendered = await renderSlotEmail('registration_ot_changed', () => ({
    subject: `Anmeldungsdaten geändert: ${eventName}`,
    body: `Die Con-Tage/Unterbringung/Handwerk/Anreise/Opt-Out-Angaben der Anmeldung von ${userName} für "${eventName}" wurden nachträglich geändert.`,
  }), { extra: { userName, eventName } });
  return deliver(transporter, from, to, rendered);
}

export async function sendWaitlistedEmail(to, { eventName, userId }, { transporter, from }) {
  const rendered = await renderSlotEmail('waitlisted', () => ({
    subject: `Warteliste: ${eventName}`,
    body: `Deine Anmeldung für "${eventName}" ist eingegangen, das Event ist aber bereits ausgebucht. Du stehst auf der Warteliste und wirst benachrichtigt, sobald ein Platz frei wird.`,
  }), { userId, extra: { eventName } });
  return deliver(transporter, from, to, rendered);
}

export async function sendWaitlistPromotedEmail(to, { eventName, userId }, { transporter, from }) {
  const rendered = await renderSlotEmail('waitlist_promoted', () => ({
    subject: `Ein Platz ist frei geworden: ${eventName}`,
    body: `Für "${eventName}" ist ein Platz frei geworden — deine Anmeldung wurde von der Warteliste in die reguläre Anmeldung übernommen und wird nun wie gewohnt von der Orga bearbeitet.`,
  }), { userId, extra: { eventName } });
  return deliver(transporter, from, to, rendered);
}

export async function sendPaymentReminderEmail(to, { eventName, amountDueCents, payUrl, userId }, { transporter, from }) {
  const amount = `${(amountDueCents / 100).toFixed(2).replace('.', ',')} €`;
  const rendered = await renderSlotEmail('payment_reminder', () => ({
    subject: `Zahlungserinnerung: ${eventName}`,
    body: `Für deine Anmeldung zu "${eventName}" ist noch ein Betrag von ${amount} offen. Bezahlen: ${payUrl}`,
  }), { userId, extra: { eventName, amount, payUrl } });
  return deliver(transporter, from, to, rendered);
}

export async function sendGuestTicketEmail(to, { eventName, paymentToken, userId }) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${await baseUrl()}/guest-payment.html?token=${paymentToken}`;
  const rendered = await renderSlotEmail('guest_ticket', () => ({
    subject: `Dein Ticket für ${eventName}`,
    body: `Deine Anmeldung für "${eventName}" ist eingegangen. Falls die Bezahlung gerade nicht geklappt hat oder du sie später abschließen möchtest, geht es hier weiter: ${url}`,
  }), { userId, extra: { eventName, link: url } });
  return deliver(transporter, from, to, rendered);
}

export async function sendEventDeletedEmail(to, { eventName, userId }, { transporter, from }) {
  const rendered = await renderSlotEmail('event_deleted', () => ({
    subject: `Event abgesagt: ${eventName}`,
    body: `Das Event "${eventName}" wurde abgesagt und gelöscht. Deine Anmeldung dafür wurde entfernt.`,
  }), { userId, extra: { eventName } });
  return deliver(transporter, from, to, rendered);
}
