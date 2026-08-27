export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen', 'group'],
    canEditCharacters: true, isProtected: true,
  },
  {
    key: 'orga', name: 'Orga',
    visibleMenus: ['konto', 'charaktere', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContact', 'medicalNotes', 'pronomen'],
    canEditCharacters: true, isProtected: false,
  },
  {
    key: 'plot_orga', name: 'Plot-Orga',
    visibleMenus: ['konto', 'charaktere', 'events', 'checkin'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'sl', name: 'SL',
    visibleMenus: ['konto', 'charaktere', 'checkin'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'hilfs_sl', name: 'Hilfs-SL',
    visibleMenus: ['konto', 'charaktere', 'checkin'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'nsc', name: 'NSC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'gsc', name: 'GSC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
  {
    key: 'sc', name: 'SC',
    visibleMenus: ['konto', 'charaktere'],
    accountFields: [], canEditCharacters: false, isProtected: false,
  },
];
