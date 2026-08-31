import type { Rng } from './rng';
import { makeVoice, type Gender, type Voice } from './voice';

/**
 * Who the patient is, sampled independently of what is wrong with them.
 *
 * The point of the separation: a name should carry no clinical information. If
 * the same name always arrives with the same diagnosis, a returning player stops
 * reading the patient and starts recalling the answer, and the game quietly turns
 * into a quiz about eight fictional people.
 */
export interface Demographics {
  name: string;
  age: number;
  voice: Voice;
  room: string;
  nurse: string;
  allergies: string;
}

const GIVEN_NAMES: Record<Gender, readonly string[]> = {
  female: [
    'Margaret', 'Delia', 'Bonnie', 'Eileen', 'Priya', 'Yolanda', 'Ingrid', 'Rosalind',
    'Amara', 'Guadalupe', 'Noor', 'Beatrice', 'Winifred', 'Thandiwe', 'Marisol', 'Agnes',
    'Fatima', 'Deborah', 'Siobhan', 'Mei-Ling', 'Carmen', 'Harriet', 'Zainab', 'Lucille',
  ],
  male: [
    'Harold', 'Raymond', 'Arthur', 'Yusuf', 'Desmond', 'Ignatius', 'Bartholomew', 'Kwame',
    'Silvio', 'Nathaniel', 'Aleksander', 'Rupert', 'Emmanuel', 'Horace', 'Tomasz', 'Cyril',
    'Abdul', 'Vernon', 'Duncan', 'Hiroshi', 'Malachy', 'Wendell', 'Osric', 'Clement',
  ],
  nonbinary: [
    'Alex', 'Rowan', 'Jules', 'Kit', 'Morgan', 'Sasha', 'Nico', 'Bly',
    'Ellis', 'Wren', 'Ari', 'Frankie',
  ],
};

const FAMILY_NAMES: readonly string[] = [
  'Whitfield', 'Brennan', 'Okonkwo', 'Castellanos', 'Penhale', 'Demir', 'Marsh', 'Fitzgerald',
  'Achterberg', 'Nakamura', 'Oyelaran', 'Vasquez', 'Lindqvist', 'Halvorsen', 'Mbeki', 'Sridhar',
  'Kowalczyk', 'Bello', 'Ferreira', 'Novotny', 'Aldridge', 'Trakas', 'Haddad', 'Villanueva',
  'Okafor', 'Brightwater', 'Considine', 'Marchetti', 'Ndiaye', 'Rasmussen', 'Quiroga', 'Featherstone',
  'Adeyemi', 'Bergstrom', 'Cavanagh', 'Delacroix', 'Ekwueme', 'Fontaine', 'Gallardo', 'Hollingsworth',
  'Iyengar', 'Jarvinen', 'Karamanlis', 'Lefebvre', 'Mwangi', 'Nurmi', 'Odugbemi', 'Pettigrew',
  'Rahimi', 'Sorensen', 'Tanaka', 'Ubaldi', 'Vantongeren', 'Wickramasinghe', 'Yilmaz', 'Zubiri',
];

const NURSES: readonly string[] = [
  'Priya', 'Danny', 'Rosa', 'Ade', 'Marisa', 'Tobias', 'Grace', 'Nkechi',
  'Colm', 'Yuki', 'Hafsa', 'Lorenzo', 'Bex', 'Ottoline', 'Samir', 'Della',
  'Ike', 'Marguerite', 'Tunde', 'Saoirse',
];

const ALLERGIES: readonly string[] = [
  'NKDA', 'NKDA', 'NKDA',
  'Penicillin (rash)', 'Penicillin (anaphylaxis)', 'Sulfa (rash)',
  'Codeine (nausea)', 'Contrast (urticaria)', 'Latex',
];

/**
 * Build a distinct cast for one shift.
 *
 * Names and rooms are unique across the list, which matters because the room
 * number is how the player refers to people under pressure and a duplicate would
 * make a page ambiguous at exactly the moment ambiguity costs most.
 */
export function makeCast(rng: Rng, count: number): (ageRange: [number, number]) => Demographics {
  const usedNames = new Set<string>();
  const rooms = rng.shuffle(roomNumbers()).slice(0, count);
  // Roughly one nurse to five patients, which is what a night ratio looks like,
  // with a floor of three so even a small list has more than one voice on it.
  const nursePool = rng.sample(NURSES, Math.min(NURSES.length, Math.max(3, Math.round(count / 5))));
  let index = 0;

  return (ageRange) => {
    const gender = pickGender(rng);
    const demo: Demographics = {
      name: pickName(rng, gender, usedNames),
      age: rng.int(ageRange[0], ageRange[1]),
      voice: makeVoice(gender),
      room: rooms[index % rooms.length],
      nurse: nursePool[index % nursePool.length],
      allergies: rng.pick(ALLERGIES),
    };
    index += 1;
    return demo;
  };
}

/**
 * A full name nobody else on the list is using.
 *
 * Uniqueness is enforced on the whole name rather than on each half: with a long
 * list the given-name pools run dry long before the pairs do, and refusing to
 * reuse a first name would exhaust the cast far earlier than it needs to.
 */
function pickName(rng: Rng, gender: Gender, used: Set<string>): string {
  for (let attempt = 0; attempt < 40; attempt++) {
    const name = `${rng.pick(GIVEN_NAMES[gender])} ${rng.pick(FAMILY_NAMES)}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  // Astronomically unlikely, but a duplicated name is better than a hung loop.
  const fallback = `${rng.pick(GIVEN_NAMES[gender])} ${rng.pick(FAMILY_NAMES)}`;
  used.add(fallback);
  return fallback;
}

/** Mostly binary, as a ward is, but not exclusively. */
function pickGender(rng: Rng): Gender {
  const roll = rng.next();
  if (roll < 0.47) return 'female';
  if (roll < 0.94) return 'male';
  return 'nonbinary';
}

/**
 * Beds the covering doctor might hold.
 *
 * Three floors rather than one. A list of eight is one ward; a list of forty is
 * cross-cover spanning several, which is what makes the room number worth reading
 * — 6 is not 4, and the walk is different.
 */
function roomNumbers(): string[] {
  const rooms: string[] = [];
  for (const floor of [4, 5, 6]) {
    for (let n = 1; n <= 24; n++) rooms.push(`${floor}${String(n).padStart(2, '0')}`);
  }
  return rooms;
}
