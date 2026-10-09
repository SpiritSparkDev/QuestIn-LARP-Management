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

// Sample drinks menu (Getränkekarte) for the tavern add-on, prices in cents.
export const TEST_MENU = [
  { category: 'Bier', name: 'Helles 0,5 l', priceCents: 350 },
  { category: 'Bier', name: 'Weizen 0,5 l', priceCents: 400 },
  { category: 'Bier', name: 'Dunkles 0,5 l', priceCents: 400 },
  { category: 'Met', name: 'Met 0,25 l', priceCents: 450 },
  { category: 'Met', name: 'Honigwein, warm 0,25 l', priceCents: 500 },
  { category: 'Wein', name: 'Würzwein 0,25 l', priceCents: 400 },
  { category: 'Wein', name: 'Rotwein 0,2 l', priceCents: 450 },
  { category: 'Wein', name: 'Weißwein 0,2 l', priceCents: 450 },
  { category: 'Schnaps', name: 'Kräuterlikör 2 cl', priceCents: 300 },
  { category: 'Alkoholfrei', name: 'Apfelschorle 0,4 l', priceCents: 250 },
  { category: 'Alkoholfrei', name: 'Wasser 0,4 l', priceCents: 150 },
  { category: 'Alkoholfrei', name: 'Kräutertee', priceCents: 200 },
  { category: 'Speisen', name: 'Brot & Käse', priceCents: 600 },
  { category: 'Speisen', name: 'Eintopf', priceCents: 700 },
  { category: 'Speisen', name: 'Bratwurst im Brot', priceCents: 450 },
  { category: 'Speisen', name: 'Kuchenstück', priceCents: 300 },
];

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
      // Teilnahmegruppe as the event's rules would pick it: NSC pay the NSC price, everyone else the player price.
      priceGroup: role === 'nsc' || role === 'helfer' || role === 'orga' || role === 'hilfs_orga' ? 'NSC' : 'Spieler',
      flags: [
        ...(i % 8 === 2 ? ['GSC'] : []),
        ...(i % 10 === 6 ? ['VP'] : []),
        ...(i % 12 === 11 ? ['Ersthelfer'] : []),
      ],
      paid: status === 'checked_in' || (status === 'confirmed' && i % 3 !== 0),
      // How a paid registration was paid (rotates through the methods the tool knows).
      paymentMethod: ['stripe_card', 'stripe_paypal', 'stripe_bank_transfer', 'bank_transfer', 'sumup', 'paypal'][i % 6],
      // Open, unpaid and the person already clicked "Ich habe überwiesen".
      transferNotified: status === 'pending' && i % 4 === 0,
      characterName,
      hasNscCharacter: role === 'nsc' || i % 9 === 4,
    });
  }

  return {
    event: {
      name: 'Testcon: Die Nebel von Ravenmoor',
      code: 'TEST/2027',
      flags: ['GSC', 'VP', 'Ersthelfer'],
      capacity: 80,
      hardCapacity: 85,
      lowSeatsNotice: true,
      paymentsOpen: true,
      color: '#2e7d32',
      address: 'Burg Ravenmoor\nNebelweg 1\n12345 Teststadt',
      directions: 'Dies ist ein fiktives Event für den Test-Modus. Von der Autobahn nehmen Sie die Ausfahrt "Teststadt" und folgen Sie der Beschilderung "Burg Ravenmoor".',
      briefing: 'Fiktiver Plot: Ein dichter Nebel zieht über Ravenmoor auf und die Burgbewohner verschwinden nacheinander. Wer steckt dahinter?',
      pricing: {
        groups: ['Spieler', 'NSC'],
        // Which group is pre-selected at registration, by participation (SC/NSC).
        groupRules: {
          Spieler: [{ source: 'participation', field: 'conRole', op: 'eq', value: 'SC' }],
          NSC: [{ source: 'participation', field: 'conRole', op: 'eq', value: 'NSC' }],
        },
        tiers: [
          { name: 'Frühbucher', until: '2027-01-01', conPayer: false, amounts: { Spieler: 20000, NSC: 18000 } },
          { name: 'Normal', until: '2027-07-01', conPayer: false, amounts: { Spieler: 22500, NSC: 20000 } },
          { name: 'Conzahler', until: null, conPayer: true, amounts: { Spieler: 25000, NSC: 22000 } },
        ],
      },
    },
    groups: GROUPS,
    persons,
  };
}
