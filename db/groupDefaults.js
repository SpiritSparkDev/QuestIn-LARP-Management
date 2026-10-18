export const GROUP_DEFAULTS = [
  {
    key: 'admin', name: 'Admin',
    visibleMenus: ['konto', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut', 'group', 'childPhotoInternal', 'childPhotoPublic', 'childVideo'],
    canEditCharacters: true, canOverrideCheckinStatus: true, canExportMembers: true, canExportSensitive: true, isProtected: true,
  },
  {
    key: 'moderator', name: 'Moderator',
    visibleMenus: ['konto', 'mitglieder', 'events', 'checkin'],
    accountFields: ['address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone', 'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut', 'childPhotoInternal', 'childPhotoPublic', 'childVideo'],
    canEditCharacters: true, canOverrideCheckinStatus: true, canExportMembers: true, canExportSensitive: true, isProtected: false,
  },
  {
    key: 'mitglied', name: 'Mitglied',
    visibleMenus: ['konto'],
    accountFields: [], canEditCharacters: false, canOverrideCheckinStatus: false, canExportMembers: false, canExportSensitive: false, isProtected: false,
  },
];
