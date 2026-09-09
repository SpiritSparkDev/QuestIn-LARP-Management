export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'charaktere', 'con-anmeldungen', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut', 'group'],
    canEditCharacters: true, canOverrideCheckinStatus: true, isProtected: true,
  },
  {
    key: 'moderator', name: 'Moderator',
    visibleMenus: ['konto', 'charaktere', 'con-anmeldungen', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut'],
    canEditCharacters: true, canOverrideCheckinStatus: true, isProtected: false,
  },
  {
    key: 'mitglied', name: 'Mitglied',
    visibleMenus: ['konto', 'charaktere', 'con-anmeldungen'],
    accountFields: [], canEditCharacters: false, canOverrideCheckinStatus: false, isProtected: false,
  },
];
