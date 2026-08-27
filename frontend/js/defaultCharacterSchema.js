// Default character-form-schema template. Loadable in the admin event form
// as a starting point for a new event's character_form_schema — not a fixed
// schema forced on every event, just a convenience preset an admin can load
// and then adjust.
export const DEFAULT_CHARACTER_SCHEMA = [
  { key: 'klasse', label: 'Klasse', type: 'text', required: true },
  { key: 'volk', label: 'Volk', type: 'text', required: true },
  { key: 'religion', label: 'Religion', type: 'text', required: false },
  {
    key: 'magischBegabt',
    label: 'Magisch begabt',
    type: 'select',
    required: false,
    options: ['Arkan', 'Bardisch', 'Klerikal', 'Natur', 'Dämonisch', 'Anderes'],
  },
  { key: 'conTage', label: 'Con-Tage des Charakters', type: 'text', required: false },
  { key: 'titel', label: 'Titel', type: 'text', required: false },
  { key: 'gesinnung', label: 'Gesinnung', type: 'text', required: false },
  { key: 'heimatland', label: 'Heimatland', type: 'text', required: false },
  { key: 'erfahrungspunkte', label: 'Erfahrung (Punkte)', type: 'number', required: false },
  { key: 'charakterVorlieben', label: 'Charakter-Gerne', type: 'textarea', required: false },
  { key: 'charaktergeschichte', label: 'Charaktergeschichte/Wissenswertes', type: 'textarea', required: false },
  { key: 'konfliktpotenzial', label: 'Konfliktpotenzial', type: 'textarea', required: false },
];
