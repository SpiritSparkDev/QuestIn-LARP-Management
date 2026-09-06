export const ACCOUNT_FIELD_KEYS = [
  'address', 'birthdate', 'phone', 'emergencyContactLastName', 'emergencyContactFirstName', 'emergencyContactPhone',
  'medicalNotes', 'conTage', 'accommodation', 'craftOffer', 'travelMethod', 'dataSharingOptOut', 'photoOptOut', 'group',
];

// Encrypted-at-rest member (OT) fields, mapped to their column. 'group' is
// deliberately excluded: it's an access-control field, not personal data.
export const ENCRYPTED_ACCOUNT_FIELD_COLUMNS = {
  address: 'address_enc',
  birthdate: 'birthdate_enc',
  phone: 'phone_enc',
  emergencyContactLastName: 'emergency_contact_last_name_enc',
  emergencyContactFirstName: 'emergency_contact_first_name_enc',
  emergencyContactPhone: 'emergency_contact_phone_enc',
  medicalNotes: 'medical_notes_enc',
  conTage: 'con_tage_enc',
  accommodation: 'accommodation_enc',
  craftOffer: 'craft_offer_enc',
  travelMethod: 'travel_method_enc',
  dataSharingOptOut: 'data_sharing_opt_out_enc',
  photoOptOut: 'photo_opt_out_enc',
};
