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
];

const NURSES: readonly string[] = [
  'Priya', 'Danny', 'Rosa', 'Ade', 'Marisa', 'Tobias', 'Grace', 'Nkechi',
  'Colm', 'Yuki', 'Hafsa', 'Lorenzo',
];

const ALLERGIES: readonly string[] = [
  'NKDA', 'NKDA', 'NKDA',
  'Penicillin (rash)', 'Penicillin (anaphylaxis)', 'Sulfa (rash)',
  'Codeine (nausea)', 'Contrast (urticaria)', 'Latex',
];

/**
 * Build a distinct cast for one shift.
 *
 * Names, rooms and nurses are drawn without replacement so no two patients on the
 * ward share either, which matters because room number is how the player refers
 * to people under pressure.
 */
export function makeCast(rng: Rng, count: number): (ageRange: [number, number]) => Demographics {
  const usedGiven = new Set<string>();
  const usedFamily = new Set<string>();
  const rooms = rng.shuffle(roomNumbers()).slice(0, count);
  // Three or four nurses covering eight patients, as on a real ward.
  const nursePool = rng.sample(NURSES, rng.int(3, 4));
  let index = 0;

  return (ageRange) => {
    const gender = pickGender(rng);
    const name = `${pickUnique(rng, GIVEN_NAMES[gender], usedGiven)} ${pickUnique(rng, FAMILY_NAMES, usedFamily)}`;
    const demo: Demographics = {
      name,
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

/** Mostly binary, as a ward is, but not exclusively. */
function pickGender(rng: Rng): Gender {
  const roll = rng.next();
  if (roll < 0.47) return 'female';
  if (roll < 0.94) return 'male';
  return 'nonbinary';
}

function pickUnique(rng: Rng, pool: readonly string[], used: Set<string>): string {
  const available = pool.filter((n) => !used.has(n));
  const chosen = rng.pick(available.length > 0 ? available : pool);
  used.add(chosen);
  return chosen;
}

function roomNumbers(): string[] {
  const rooms: string[] = [];
  for (let n = 401; n <= 424; n++) rooms.push(String(n));
  return rooms;
}
