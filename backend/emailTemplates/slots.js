// Catalog of system emails that can be overridden with an admin-authored
// template (see backend/emailTemplates/send.js). Every template is written
// for exactly one slot (email_templates.slot) and can only be assigned to
// that slot, because the same placeholder means a different link per slot:
// {{link}} in an invitation sets a first password, in a password reset it
// resets one, in a group invitation it joins a group.
//
// `extraFields` are the slot-specific placeholders available at the TOP
// level of the Handlebars context (e.g. {{link}}), separate from the
// {{account.*}}/{{character.*}} OT/IT fields. `required` ones must appear
// in the template body (a mail without its link is useless); `example` is
// what the admin preview fills in -- a path starting with "/" is prefixed
// with the instance's base URL. `linkSummary` says in one line where the
// mail's link leads, shown next to the slot in the admin UI.
export const EMAIL_SLOT_CATEGORIES = [
  { key: 'access', label: 'Konto & Zugang' },
  { key: 'registration', label: 'Anmeldung & Zahlung' },
  { key: 'orga', label: 'Orga-Hinweise (an die Orga, nicht an Mitglieder)' },
];

export const EMAIL_SLOTS = [
  {
    key: 'verification',
    category: 'access',
    label: 'E-Mail-Verifizierung',
    description: 'Nach der Selbstregistrierung und beim „Zugangslink senden“ an ein Mitglied, dessen E-Mail noch nicht bestätigt ist.',
    linkSummary: 'Bestätigungslink: bestätigt die E-Mail-Adresse (verify.html)',
    supportsAccount: true,
    extraFields: [
      { key: 'link', label: 'Bestätigungslink (E-Mail bestätigen)', required: true, example: '/verify.html?token=BEISPIEL' },
    ],
  },
  {
    key: 'password_reset',
    category: 'access',
    label: 'Passwort zurücksetzen',
    description: 'Bei „Passwort vergessen“ und beim „Zugangslink senden“ an ein Mitglied mit bestätigter E-Mail.',
    linkSummary: 'Passwort-Link: setzt ein neues Passwort für ein bestehendes Konto (reset-password.html)',
    supportsAccount: true,
    extraFields: [
      { key: 'link', label: 'Link zum Zurücksetzen des Passworts', required: true, example: '/reset-password.html?token=BEISPIEL' },
    ],
  },
  {
    key: 'invitation',
    category: 'access',
    label: 'Einladung (neues Konto)',
    description: 'Wenn die Orga jemanden einlädt oder eine Direktanmeldung in ein Konto umwandelt. Der Empfänger hat noch kein Konto.',
    linkSummary: 'Einladungslink: legt das Konto an und setzt das erste Passwort (set-password.html)',
    supportsAccount: true,
    extraFields: [
      { key: 'link', label: 'Einladungslink (erstes Passwort setzen)', required: true, example: '/set-password.html?token=BEISPIEL' },
    ],
  },
  {
    key: 'group_invitation',
    category: 'access',
    label: 'Gruppeneinladung',
    description: 'Wenn ein Gruppenverwalter jemanden in seine Gruppe einlädt.',
    linkSummary: 'Gruppenlink: bestehendes Konto → Einladung im Konto annehmen (account.html); noch kein Konto → Konto anlegen und Gruppe beitreten (join-group.html)',
    supportsAccount: true,
    extraFields: [
      { key: 'parentName', label: 'Name des einladenden Gruppenverwalters', example: 'Max Mustermann' },
      { key: 'link', label: 'Gruppenlink (annehmen bzw. Konto anlegen)', required: true, example: '/join-group.html?token=BEISPIEL' },
    ],
  },
  {
    key: 'guest_access',
    category: 'access',
    label: 'Passwort vergessen bei Direktanmeldung (kein Konto)',
    description: 'Wenn jemand „Passwort vergessen“ nutzt, der sich nur direkt angemeldet hat und deshalb kein Konto und kein Passwort hat.',
    linkSummary: 'Ticketlinks: je Anmeldung die Ticketseite ohne Login (guest-payment.html)',
    supportsAccount: true,
    extraFields: [
      { key: 'tickets', label: 'Liste der Anmeldungen mit Ticketlink', required: true, example: '- Beispiel-Con: https://…/guest-payment.html?token=BEISPIEL' },
      { key: 'hasTickets', label: 'Wahr, wenn mindestens ein Ticketlink vorhanden ist (für {{#if hasTickets}})', example: 'true' },
    ],
  },
  {
    key: 'waitlisted',
    category: 'registration',
    label: 'Auf die Warteliste gesetzt',
    supportsAccount: true,
    extraFields: [{ key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' }],
  },
  {
    key: 'waitlist_promoted',
    category: 'registration',
    label: 'Von der Warteliste nachgerückt',
    supportsAccount: true,
    extraFields: [{ key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' }],
  },
  {
    key: 'guest_ticket',
    category: 'registration',
    label: 'Direktanmeldung eingegangen (Ticket)',
    description: 'Nach einer Direktanmeldung ohne Konto.',
    linkSummary: 'Ticketlink: Zahlung abschließen und Ticket ansehen, ohne Login (guest-payment.html)',
    supportsAccount: true,
    extraFields: [
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'link', label: 'Ticketlink (Zahlung & Ticket)', required: true, example: '/guest-payment.html?token=BEISPIEL' },
    ],
  },
  {
    key: 'payment_reminder',
    category: 'registration',
    label: 'Zahlungserinnerung',
    linkSummary: 'Zahlungslink: Mitglieder → Anmeldungen im Konto; Direktanmeldungen → Ticketseite (guest-payment.html)',
    supportsAccount: true,
    extraFields: [
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'amount', label: 'Offener Betrag', example: '45,00 €' },
      { key: 'payUrl', label: 'Zahlungslink', required: true, example: '/account.html?payment=reminder#anmelden' },
    ],
  },
  {
    key: 'payment_received',
    category: 'registration',
    label: 'Zahlung eingegangen',
    linkSummary: 'Ticketlink: Mitglieder → Konto-Übersicht; Direktanmeldungen → Ticketseite (guest-payment.html)',
    supportsAccount: true,
    extraFields: [
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'link', label: 'Link zum Ticket', required: true, example: '/account.html#dashboard' },
    ],
  },
  {
    key: 'guest_deadline',
    category: 'registration',
    label: 'Erinnerung: Preisstufe endet bald (Opt-in)',
    linkSummary: 'Ticketlink zur Zahlung (guest-payment.html) plus Abmelde-Link für diese Erinnerungen',
    supportsAccount: true,
    extraFields: [
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'deadline', label: 'Ende der Preisstufe (Datum)', example: '31.12.2026' },
      { key: 'link', label: 'Ticketlink (Zahlung & Ticket)', required: true, example: '/guest-payment.html?token=BEISPIEL' },
      { key: 'optoutLink', label: 'Abmelde-Link (Pflicht in jeder Mail)', required: true, example: '/deadline-optout.html?token=BEISPIEL' },
    ],
  },
  {
    key: 'event_deleted',
    category: 'registration',
    label: 'Event abgesagt',
    supportsAccount: true,
    extraFields: [{ key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' }],
  },
  {
    key: 'nsc_dialog_player',
    category: 'registration',
    label: 'Neue Nachricht der Orga im NSC-Dialog',
    linkSummary: 'Kontolink: Anmeldungen im eigenen Konto (account.html#anmelden), Login nötig',
    supportsAccount: true,
    extraFields: [
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'link', label: 'Link zum Konto (Anmeldungen)', required: true, example: '/account.html#anmelden' },
    ],
  },
  {
    key: 'pdf_import_received',
    category: 'registration',
    label: 'PDF-Import: Eingangsbestätigung',
    supportsAccount: false,
    extraFields: [{ key: 'name', label: 'Name des Einsenders', example: 'Erika Musterfrau' }],
  },
  {
    key: 'registration_ot_changed',
    category: 'orga',
    label: 'Anmeldedaten geändert',
    supportsAccount: false,
    extraFields: [
      { key: 'userName', label: 'Name des betroffenen Mitglieds', example: 'Erika Musterfrau' },
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
    ],
  },
  {
    key: 'character_deleted_orga',
    category: 'orga',
    label: 'Charakter mit Anmeldung gelöscht',
    supportsAccount: false,
    extraFields: [
      { key: 'userName', label: 'Name des betroffenen Mitglieds', example: 'Erika Musterfrau' },
      { key: 'characterName', label: 'Name des gelöschten Charakters', example: 'Held der Lande' },
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'consequence', label: 'Folge für die Anmeldung (Text)', example: 'Die Teilnahme entfällt dadurch.' },
    ],
  },
  {
    key: 'registration_withdrawn_orga',
    category: 'orga',
    label: 'Bestätigte Anmeldung zurückgezogen',
    supportsAccount: false,
    extraFields: [
      { key: 'userName', label: 'Name des Mitglieds', example: 'Erika Musterfrau' },
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'paymentInfo', label: 'Zahlungsstand (Text)', example: 'Die Anmeldung war bereits bezahlt.' },
    ],
  },
  {
    key: 'nsc_dialog_staff',
    category: 'orga',
    label: 'Neue Nachricht im NSC-Dialog',
    linkSummary: 'Adminlink: NSC-Dialog im Adminbereich (admin/nsc-dialog.html)',
    supportsAccount: false,
    extraFields: [
      { key: 'userName', label: 'Name des Spielers', example: 'Erika Musterfrau' },
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'link', label: 'Link zum NSC-Dialog', required: true, example: '/admin/nsc-dialog.html' },
    ],
  },
  {
    key: 'unpaid_reminder_orga',
    category: 'orga',
    label: 'Erinnerung: offene Zahlungen (PDF-Anmeldungen)',
    supportsAccount: false,
    extraFields: [
      { key: 'eventName', label: 'Eventname', example: 'Beispiel-Con' },
      { key: 'reminderNumber', label: 'Nummer der Erinnerung', example: '1' },
      { key: 'list', label: 'Liste der Personen mit offener Zahlung', example: '- Erika Musterfrau\n- Max Mustermann' },
    ],
  },
];

export const EMAIL_SLOT_KEYS = EMAIL_SLOTS.map((s) => s.key);

export function getEmailSlot(key) {
  return EMAIL_SLOTS.find((s) => s.key === key) ?? null;
}

function mentions(source, key) {
  return new RegExp(`\\{\\{\\{?\\s*${key}\\s*\\}?\\}\\}`).test(source ?? '');
}

// Required placeholders of `slotKey` that `body` never uses -- empty when
// the template is complete (or the slot has none).
export function missingRequiredFields(slotKey, body) {
  const slot = getEmailSlot(slotKey);
  if (!slot) return [];
  return slot.extraFields.filter((f) => f.required && !mentions(body, f.key));
}

// Fills every slot-specific placeholder with its example value, so an admin
// preview shows which kind of link the real mail will carry.
export function exampleExtraFields(slotKey, base) {
  const slot = getEmailSlot(slotKey);
  if (!slot) return {};
  return Object.fromEntries(slot.extraFields.map((f) => [
    f.key,
    typeof f.example === 'string' && f.example.startsWith('/') ? `${base}${f.example}` : (f.example ?? ''),
  ]));
}
