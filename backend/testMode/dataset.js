// The fictional test data set: 75 people, some in groups (one account owning
// several managed persons, like a LARP group registering together), the rest
// individuals, plus one fictional event. Pure and deterministic -- the same
// call always yields the same people -- so screenshots, demos and tests are
// reproducible. backend/testMode/load.js turns it into database rows.

export const TEST_EMAIL_DOMAIN = 'test.invalid';

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = ['Mara', 'Jonas', 'Lena', 'Tim', 'Sophie', 'Felix', 'Hannah', 'Lukas', 'Clara', 'Jan', 'Emma', 'Paul', 'Nele', 'Ben', 'Mia', 'Finn', 'Lea', 'Noah', 'Greta', 'Elias', 'Johanna', 'Moritz', 'Pia', 'Anton', 'Ida', 'Leon', 'Marie', 'Niklas', 'Frieda', 'Oskar', 'Luisa', 'Henri', 'Anna', 'Vincent', 'Ronja', 'Matteo', 'Charlotte', 'Julian', 'Alina', 'Theo', 'Katharina', 'David', 'Svenja', 'Robin', 'Merle', 'Kilian', 'Tabea', 'Erik', 'Josefine', 'Samuel', 'Liv', 'Jakob', 'Amelie', 'Rafael', 'Helena', 'Benedikt', 'Smilla', 'Konrad', 'Carla', 'Gregor', 'Jule', 'Arne', 'Birte', 'Malte', 'Rieke', 'Tobias', 'Sina', 'Lasse', 'Wiebke', 'Hendrik', 'Lotta', 'Fabian', 'Yara', 'Mats', 'Elif', 'Cem', 'Ayla', 'Jonne'];
const LAST_NAMES = ['Falk', 'Berg', 'Wolf', 'Roth', 'Brandt', 'Vogel', 'Keller', 'Sommer', 'Winter', 'Lang', 'Kraus', 'Bauer', 'Hartmann', 'Schuster', 'Voss', 'Albrecht', 'Engel', 'Fuchs', 'Graf', 'Haas', 'Ibsen', 'Jansen', 'Koch', 'Lorenz', 'Meyer', 'Neumann', 'Otto', 'Peters', 'Richter', 'Seidel', 'Thomas', 'Ullrich', 'Vetter', 'Weber', 'Zimmer', 'Arnold', 'Busch', 'Dietrich', 'Ebert', 'Friedrich', 'Gross', 'Hahn', 'Kaiser', 'Lehmann', 'Maurer', 'Nowak', 'Pohl', 'Reuter', 'Schreiber', 'Trapp', 'Unger', 'Walter', 'Yilmaz', 'Zander', 'Bergmann', 'Conrad', 'Decker', 'Eberle', 'Fischer', 'Gerlach', 'Heinz', 'Kluge', 'Lindner', 'Marx', 'Naumann', 'Pfeiffer', 'Rademacher', 'Stein', 'Thiel', 'Urban', 'Vollmer', 'Wendt', 'Ziegler', 'Yildiz', 'Krämer'];
const CHARACTER_FIRST = ['Aldric', 'Brienne', 'Corvin', 'Dara', 'Eldrin', 'Fenna', 'Garrick', 'Hilda', 'Ivo', 'Jorun', 'Kaelen', 'Laciel', 'Mirabel', 'Noldor', 'Orla', 'Perrin', 'Quill', 'Rhea', 'Sigmund', 'Tamsin', 'Ulric', 'Vesna', 'Wulf', 'Xandra', 'Ysolde', 'Zephyr', 'Arvid', 'Bryn', 'Caelum', 'Dorian', 'Elowen', 'Fargrim', 'Gwyn', 'Halvar', 'Isolde', 'Jarek', 'Kirsa', 'Lorcan', 'Maeve', 'Nyx', 'Osric', 'Petra', 'Rurik', 'Sunniva', 'Torin', 'Una', 'Valdis', 'Wren', 'Yorick', 'Zora', 'Alaric', 'Bertram', 'Cinder', 'Dunstan', 'Edda', 'Frode', 'Gisela', 'Hakon', 'Ilse', 'Jasper', 'Katla', 'Leif', 'Morwen', 'Nerys', 'Odo', 'Pelia', 'Ragna', 'Sten', 'Thessaly', 'Uther', 'Vigdis', 'Wystan', 'Ylva', 'Zeno', 'Astrid', 'Bruno', 'Cora'];
const CHARACTER_EPITHETS = ['Nachtwind', 'Eisenhand', 'Silberzunge', 'Aschenbart', 'Rabenfeder', 'Dornenherz', 'Sturmfels', 'Goldkehle', 'Nebelschritt', 'Wolfsblut', 'Eichenschild', 'Funkenflug', 'Mondschatten', 'Kupferkessel', 'Tannenwacht'];

export const GROUPS = [
  { name: 'Haus Falkenstein', size: 6 },
  { name: 'Die Rabenschar', size: 5 },
  { name: 'Söldnerkompanie Eisenwolf', size: 5 },
  { name: 'Gilde der Silbernen Feder', size: 4 },
  { name: 'Das fahrende Volk', size: 4 },
  { name: 'Kloster Sankt Odilia', size: 3 },
];

const TOTAL_PEOPLE = 75;
const ROLES_BY_INDEX = (i) => {
  if (i % 17 === 5) return 'nsc';
  if (i % 13 === 4) return 'helfer';
  if (i === 9) return 'orga';
  if (i === 31) return 'hilfs_orga';
  if (i % 29 === 20) return 'ticket';
  return 'sc';
};
const STATUS_BY_INDEX = (i, role) => {
  if (i % 23 === 7) return 'waitlisted';
  if (i % 31 === 12) return 'cancelled';
  if (i % 7 === 0 || i % 11 === 3) return 'pending';
  if (role !== 'ticket' && i % 5 === 1) return 'checked_in';
  return 'confirmed';
};

export function buildTestDataset() {
  const rng = mulberry32(20271212);
  const shuffled = (list) => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const firstNames = shuffled(FIRST_NAMES);
  const lastNames = shuffled(LAST_NAMES);
  const characterNames = shuffled(CHARACTER_FIRST);

  const persons = [];
  const groupCount = GROUPS.reduce((sum, g) => sum + g.size, 0);
  const slotGroup = [];
  GROUPS.forEach((group, groupIndex) => {
    for (let n = 0; n < group.size; n += 1) slotGroup.push({ groupIndex, isOwner: n === 0, familyName: null });
  });
  const familyNameOfGroup = GROUPS.map((_, i) => lastNames[i]);

  for (let i = 0; i < TOTAL_PEOPLE; i += 1) {
    const slot = i < groupCount ? slotGroup[i] : null;
    const firstName = firstNames[i % firstNames.length];
    // Members of a group share the owner's family name now and then, like a family would.
    const lastName = slot && i % 2 === 0 ? familyNameOfGroup[slot.groupIndex] : lastNames[(i + GROUPS.length) % lastNames.length];
    const role = ROLES_BY_INDEX(i);
    const status = STATUS_BY_INDEX(i, role);
    const isChild = slot && !slot.isOwner && i % 6 === 3;
    const characterName = `${characterNames[i % characterNames.length]}${rng() < 0.45 ? ` ${CHARACTER_EPITHETS[Math.floor(rng() * CHARACTER_EPITHETS.length)]}` : ''}`;
    persons.push({
      index: i,
      firstName,
      lastName,
      nickname: rng() < 0.25 ? `${firstName.slice(0, 3)}${i}` : null,
      email: `test.person${String(i + 1).padStart(2, '0')}@${TEST_EMAIL_DOMAIN}`,
      groupIndex: slot ? slot.groupIndex : null,
      isGroupOwner: Boolean(slot?.isOwner),
      // Group members are managed persons of their owner; a few singles are guest-widget style accounts.
      isManaged: Boolean(slot && !slot.isOwner),
      isGuest: Boolean(slot && !slot.isOwner) || (!slot && i % 9 === 0),
      role,
      status,
      priceGroup: isChild ? 'Kinder' : 'Erwachsene',
      flags: [
        ...(i % 8 === 2 ? ['GSC'] : []),
        ...(i % 10 === 6 ? ['VP'] : []),
        ...(i % 12 === 11 ? ['Ersthelfer'] : []),
      ],
      paid: status === 'checked_in' || (status === 'confirmed' && i % 3 !== 0),
      characterName,
      hasNscCharacter: role === 'nsc' || i % 9 === 4,
      nscCharacterName: `${characterNames[(i + 7) % characterNames.length]} (NSC)`,
    });
  }

  return {
    event: {
      name: 'Testcon: Die Nebel von Ravenmoor',
      code: 'TEST/2027',
      flags: ['GSC', 'VP', 'Ersthelfer'],
      capacity: 80,
      address: 'Burg Ravenmoor\nNebelweg 1\n12345 Teststadt',
      directions: 'Dies ist ein fiktives Event für den Test-Modus. Von der Autobahn nehmen Sie die Ausfahrt "Teststadt" und folgen Sie der Beschilderung "Burg Ravenmoor".',
      briefing: 'Fiktiver Plot: Ein dichter Nebel zieht über Ravenmoor auf und die Burgbewohner verschwinden nacheinander. Wer steckt dahinter?',
      pricing: {
        groups: ['Erwachsene', 'Kinder'],
        tiers: [
          { name: 'Frühbucher', until: '2027-01-01', amounts: { Erwachsene: 24500, Kinder: 14500 } },
          { name: 'Normal', until: '2027-07-01', amounts: { Erwachsene: 25500, Kinder: 16000 } },
          { name: 'Conzahler', until: null, amounts: { Erwachsene: 27500, Kinder: 18000 } },
        ],
      },
    },
    groups: GROUPS,
    persons,
  };
}
