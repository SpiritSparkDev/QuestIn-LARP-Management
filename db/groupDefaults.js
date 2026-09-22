export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'mitglieder', 'events', 'checkin', 'dateien'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut', 'group'],
    canEditCharacters: true, canOverrideCheckinStatus: true, isProtected: true,
  },
  {
    key: 'moderator', name: 'Moderator',
    visibleMenus: ['konto', 'mitglieder', 'events', 'checkin', 'dateien'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut'],
    canEditCharacters: true, canOverrideCheckinStatus: true, isProtected: false,
  },
  {
    key: 'mitglied', name: 'Mitglied',
    visibleMenus: ['konto', 'dateien'],
    accountFields: [], canEditCharacters: false, canOverrideCheckinStatus: false, isProtected: false,
  },
];
