// Catalog of system emails that can be overridden with an admin-authored
// template (see backend/emailTemplates/send.js). `extraFields` are the
// slot-specific placeholders available at the TOP level of the Handlebars
// context (e.g. {{link}}), separate from the {{account.*}}/{{character.*}}
// OT/IT fields -- documented here so the admin UI can show, per slot, which
// of these a template for it may use.
export const EMAIL_SLOTS = [
  {
    key: 'verification',
    label: 'E-Mail-Verifizierung',
    supportsAccount: true,
    extraFields: [{ key: 'link', label: 'Bestätigungslink' }],
  },
  {
    key: 'password_reset',
    label: 'Passwort zurücksetzen',
    supportsAccount: true,
    extraFields: [{ key: 'link', label: 'Link zum Zurücksetzen' }],
  },
  {
    key: 'invitation',
    label: 'Einladung (neues Konto / Gast-Umwandlung)',
    supportsAccount: true,
    extraFields: [{ key: 'link', label: 'Link zum Passwort setzen' }],
  },
  {
    key: 'group_invitation',
    label: 'Gruppeneinladung (an bestehendes Konto)',
    supportsAccount: true,
    extraFields: [
      { key: 'parentName', label: 'Name des einladenden Gruppenverwalters' },
      { key: 'link', label: 'Link zum Konto' },
    ],
  },
  {
    key: 'registration_ot_changed',
    label: 'Orga-Hinweis: Anmeldedaten geändert',
    supportsAccount: false,
    extraFields: [
      { key: 'userName', label: 'Name des betroffenen Mitglieds' },
      { key: 'eventName', label: 'Eventname' },
    ],
  },
  {
    key: 'character_deleted_orga',
    label: 'Orga-Hinweis: Charakter mit Anmeldung gelöscht',
    supportsAccount: false,
    extraFields: [
      { key: 'userName', label: 'Name des betroffenen Mitglieds' },
      { key: 'characterName', label: 'Name des gelöschten Charakters' },
      { key: 'eventName', label: 'Eventname' },
      { key: 'consequence', label: 'Folge für die Anmeldung (Text)' },
    ],
  },
  {
    key: 'waitlisted',
    label: 'Auf die Warteliste gesetzt',
    supportsAccount: true,
    extraFields: [{ key: 'eventName', label: 'Eventname' }],
  },
  {
    key: 'waitlist_promoted',
    label: 'Von der Warteliste nachgerückt',
    supportsAccount: true,
    extraFields: [{ key: 'eventName', label: 'Eventname' }],
  },
  {
    key: 'payment_reminder',
    label: 'Zahlungserinnerung',
    supportsAccount: true,
    extraFields: [
      { key: 'eventName', label: 'Eventname' },
      { key: 'amount', label: 'Offener Betrag' },
      { key: 'payUrl', label: 'Zahlungslink' },
    ],
  },
  {
    key: 'guest_ticket',
    label: 'Gast-Ticket bestätigt',
    supportsAccount: true,
    extraFields: [
      { key: 'eventName', label: 'Eventname' },
      { key: 'link', label: 'Bestätigungs-/Zahlungslink' },
    ],
  },
  {
    key: 'event_deleted',
    label: 'Event abgesagt',
    supportsAccount: true,
    extraFields: [{ key: 'eventName', label: 'Eventname' }],
  },
  {
    key: 'pdf_import_received',
    label: 'PDF-Import: Eingangsbestätigung',
    supportsAccount: false,
    extraFields: [{ key: 'name', label: 'Name des Einsenders' }],
  },
];

export const EMAIL_SLOT_KEYS = EMAIL_SLOTS.map((s) => s.key);

export function getEmailSlot(key) {
  return EMAIL_SLOTS.find((s) => s.key === key) ?? null;
}
