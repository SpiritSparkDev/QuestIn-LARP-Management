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
  { key: 'conTag', label: 'Con-Tag des Charakters', type: 'text', required: false },
];
