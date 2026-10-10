import nodemailer from 'nodemailer';
import { getSmtpSettingsForSending } from '../smtpSettings/repository.js';
import { getAppSettings, DEFAULT_BASE_URL } from '../appSettings/repository.js';
import { logger } from '../logger.js';
import { renderSlotEmail } from '../emailTemplates/send.js';
import { isOffline, outboxTransport } from '../appMode.js';
import { recordEmail } from '../emailLog/repository.js';

// Transporters handed out while no SMTP host is configured: nodemailer's
// jsonTransport "sends" into the void, so these mails are logged as
// not_configured instead of sent.
const unconfiguredTransporters = new WeakSet();

export function isUnconfiguredTransporter(transporter) {
  return unconfiguredTransporters.has(transporter);
}

// Delivers whatever renderSlotEmail resolved to (an admin-assigned template
// or the slot's hardcoded fallback text) -- isHtml picks sendMail's html vs
// text option, same rule as the manual "send test" flow in
// backend/emailTemplates/routes.js. Every attempt lands in the
// Versandprotokoll (email_log); a failure is recorded and rethrown.
export async function deliver(transporter, from, to, { subject, body, isHtml, slot = null, userId = null }) {
  const entry = { slot, userId, to, subject };
  // Test-Modus people live on a reserved, undeliverable domain -- never try to mail them.
  if (String(to).toLowerCase().endsWith('@test.invalid')) {
    await recordEmail({ ...entry, status: 'skipped', error: 'Test-Person (Test-Modus), nicht versendet' });
    return { skipped: true };
  }
  const mail = { to, from, subject, ...(isHtml ? { html: body } : { text: body }) };
  if (transporter === outboxTransport) {
    const info = await outboxTransport.sendMail(mail, { slot, userId });
    await recordEmail({ ...entry, status: 'queued', error: 'Offline-Version: wird nach der Rückgabe versendet' });
    return info;
  }
  let info;
  try {
    info = await transporter.sendMail(mail);
  } catch (err) {
    await recordEmail({ ...entry, status: 'failed', error: err.message });
    throw err;
  }
  if (unconfiguredTransporters.has(transporter)) {
    logger.warn('no SMTP host configured, mail was not sent', { slot, to });
    await recordEmail({ ...entry, status: 'not_configured', error: 'Kein SMTP-Server eingerichtet' });
  } else {
    await recordEmail({ ...entry, status: 'sent' });
  }
  return info;
}

export async function resolveSmtpConfig() {
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
  if (isOffline()) return { transporter: outboxTransport, from };
  if (!host) {
    const transporter = nodemailer.createTransport({ jsonTransport: true });
    unconfiguredTransporters.add(transporter);
    return { transporter, from };
  }
  const transporter = nodemailer.createTransport({
    host,
    port,
    auth: username ? { user: username, pass: password } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
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

// "Passwort vergessen" from someone who only has a Direktanmeldung: there is
// no password to reset, so they get their ticket links instead of silence.
export async function sendGuestAccessEmail(to, { userId, tickets }) {
  const { transporter, from } = await getTransporterAndFrom();
  const base = await baseUrl();
  const list = tickets.map((t) => `- ${t.eventName}: ${base}/guest-payment.html?token=${t.paymentToken}`).join('\n');
  const rendered = await renderSlotEmail('guest_access', () => ({
    subject: 'Deine Anmeldung – du hast kein Konto mit Passwort',
    body: tickets.length > 0
      ? `Du hast „Passwort vergessen“ angefragt. Zu dieser Adresse gibt es nur eine Direktanmeldung ohne Konto und daher auch kein Passwort. Deine Tickets findest du hier, ganz ohne Login:\n\n${list}\n\nWenn du ein eigenes Konto möchtest, wende dich an die Orga – sie kann deine Anmeldung in ein Konto umwandeln.`
      : 'Du hast „Passwort vergessen“ angefragt. Zu dieser Adresse gibt es nur eine Direktanmeldung ohne Konto und daher auch kein Passwort. Wenn du ein eigenes Konto möchtest, wende dich an die Orga – sie kann deine Anmeldung in ein Konto umwandeln.',
  }), { userId, extra: { tickets: list, hasTickets: tickets.length > 0 } });
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

export async function sendRegistrationWithdrawnOrgaEmail(to, { userName, eventName, paymentInfo }, { transporter, from }) {
  const rendered = await renderSlotEmail('registration_withdrawn_orga', () => ({
    subject: `Abmeldung: ${userName} (${eventName})`,
    body: `${userName} hat sich von "${eventName}" abgemeldet (Anmeldung war bestätigt). ${paymentInfo} Bitte manuell prüfen, insbesondere eine Erstattung der Ticketgebühr.`,
  }), { extra: { userName, eventName, paymentInfo } });
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

export async function sendGuestTicketEmail(to, { eventName, paymentToken, userId, conPayer = false, free = false }) {
  const { transporter, from } = await getTransporterAndFrom();
  const url = `${await baseUrl()}/guest-payment.html?token=${paymentToken}`;
  const rendered = await renderSlotEmail('guest_ticket', () => ({
    subject: `Dein Ticket für ${eventName}`,
    body: free
      ? `Deine Anmeldung für "${eventName}" ist eingegangen. Hier findest du dein Ticket: ${url}`
      : conPayer
        ? `Deine Anmeldung für "${eventName}" ist eingegangen. Du bist als Con-Zahler angemeldet und bezahlst vor Ort beim Check-In. Dein Ticket findest du hier: ${url}`
        : `Deine Anmeldung für "${eventName}" ist eingegangen. Falls die Bezahlung gerade nicht geklappt hat oder du sie später abschließen möchtest, geht es hier weiter – nach der Zahlung findest du dort auch dein Ticket: ${url}`,
  }), { userId, extra: { eventName, link: url, conPayer, free } });
  return deliver(transporter, from, to, rendered);
}

export async function sendPaymentReceivedEmail(to, { eventName, url, userId }) {
  const { transporter, from } = await getTransporterAndFrom();
  const rendered = await renderSlotEmail('payment_received', () => ({
    subject: `Zahlung eingegangen: ${eventName}`,
    body: `Wir haben deine Zahlung für "${eventName}" erhalten, danke! Dein Ticket findest du hier: ${url}`,
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

export async function sendGuestDeadlineEmail(to, { eventName, deadline, url, optoutUrl, conPayerNext, userId }, { transporter, from }) {
  const date = new Date(`${deadline}T00:00:00Z`).toLocaleDateString('de-DE', { timeZone: 'UTC' });
  const after = conPayerNext
    ? 'Danach wirst du automatisch als Con-Zahler geführt: Das Ticket bleibt gültig, der Preis ist höher und wird vor Ort beim Check-In bezahlt.'
    : 'Danach gilt der nächste, höhere Preis.';
  const rendered = await renderSlotEmail('guest_deadline', () => ({
    subject: `Preisstufe endet am ${date}: ${eventName}`,
    body: `Für "${eventName}" endet am ${date} die aktuelle Preisstufe. Du hast noch nicht bezahlt. ${after} Jetzt zahlen oder Ticket ansehen: ${url}\n\nKeine Erinnerungen mehr erhalten: ${optoutUrl}`,
  }), { userId, extra: { eventName, deadline: date, link: url, optoutLink: optoutUrl, conPayerNext } });
  return deliver(transporter, from, to, rendered);
}

// Hint only: the message text never travels by mail.
export async function sendNscDialogStaffEmail(to, { eventName, userName }, { transporter, from }) {
  const url = `${await baseUrl()}/admin/nsc-dialog.html`;
  const rendered = await renderSlotEmail('nsc_dialog_staff', () => ({
    subject: `Neue NSC-Nachricht: ${eventName}`,
    body: `${userName} hat im NSC-Dialog zu "${eventName}" geschrieben. Antworten: ${url}`,
  }), { extra: { userName, eventName, link: url } });
  return deliver(transporter, from, to, rendered);
}

export async function sendNscDialogPlayerEmail(to, { eventName, userId }, { transporter, from }) {
  const url = `${await baseUrl()}/account.html#anmelden`;
  const rendered = await renderSlotEmail('nsc_dialog_player', () => ({
    subject: `Neue Nachricht zu deiner NSC-Anmeldung: ${eventName}`,
    body: `Die Orga hat dir im NSC-Dialog zu "${eventName}" geschrieben. Lies und antworte in deinem Konto: ${url}`,
  }), { userId, extra: { eventName, link: url } });
  return deliver(transporter, from, to, rendered);
}
