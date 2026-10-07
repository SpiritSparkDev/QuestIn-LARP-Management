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
  // Test-Modus people live on a reserved, undeliverable domain -- never try to mail them.
  if (String(to).toLowerCase().endsWith('@test.invalid')) return Promise.resolve({ skipped: true });
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

export async function sendGroupInvitationEmail(to, { parentName, userId, token }) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${await baseUrl()}/${token ? `join-group.html?token=${token}` : 'account.html'}`;
  const rendered = await renderSlotEmail('group_invitation', () => ({
    subject: `${parentName} lädt dich in eine Gruppe ein`,
    body: !token
      ? `${parentName} hat dich eingeladen, einer Gruppe beizutreten. Bestätige oder lehne die Einladung in deinem Konto ab: ${url}`
      : `${parentName} hat dich zu Pakyrion eingeladen. Lege hier dein Konto an, du kommst dabei direkt in die Gruppe: ${url}`,
  }), { userId, extra: { parentName, link: url } });
  return deliver(transporter, from, to, rendered);
}

export async function sendRegistrationOtFieldsChangedEmail(to, { userName, eventName }, { transporter, from }) {
  const rendered = await renderSlotEmail('registration_ot_changed', () => ({
    subject: `Anmeldungsdaten geändert: ${eventName}`,
    body: `Die Con-Tage/Unterbringung/Handwerk/Anreise/Opt-Out-Angaben der Anmeldung von ${userName} für "${eventName}" wurden nachträglich geändert.`,
  }), { extra: { userName, eventName } });
  return deliver(transporter, from, to, rendered);
}

export async function sendCharacterDeletedOrgaEmail(to, { userName, characterName, eventName, participationLost, paid }, { transporter, from }) {
  const consequence = participationLost
    ? `Die Teilnahme von ${userName} an "${eventName}" entfällt dadurch.${paid ? ' Die Anmeldung war bereits bezahlt – bitte Stornierung/Erstattung klären.' : ' Bitte prüfen, ob eine Stornierung nötig ist.'}`
    : `Der Charakter war bei ${userName} für "${eventName}" nur als NSC-Charakter hinterlegt; die Anmeldung bleibt bestehen.`;
  const rendered = await renderSlotEmail('character_deleted_orga', () => ({
    subject: `Charakter gelöscht: ${characterName} (${eventName})`,
    body: `${userName} hat den Charakter "${characterName}" gelöscht. ${consequence}`,
  }), { extra: { userName, characterName, eventName, consequence } });
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

export async function sendPdfImportReceivedEmail(to, { name }, { transporter, from }) {
  const rendered = await renderSlotEmail('pdf_import_received', () => ({
    subject: 'Deine Anmeldung ist eingegangen',
    body: `Hallo ${name}, deine Anmeldung per PDF ist bei uns eingegangen. Wir melden uns, sobald sie bearbeitet wurde.`,
  }), { extra: { name } });
  return deliver(transporter, from, to, rendered);
}

export async function sendUnpaidReminderOrgaEmail(to, { eventName, reminderNumber, list }, { transporter, from }) {
  const rendered = await renderSlotEmail('unpaid_reminder_orga', () => ({
    subject: `Offene Zahlungen: ${eventName} (Erinnerung ${reminderNumber})`,
    body: `Für "${eventName}" haben folgende per PDF angemeldete Personen noch nicht gezahlt:\n\n${list}\n\nBitte schreibt sie ggf. noch einmal an.`,
  }), { extra: { eventName, reminderNumber, list } });
  return deliver(transporter, from, to, rendered);
}
