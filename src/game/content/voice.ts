/**
 * Pronouns and verb agreement for a generated patient.
 *
 * Once patients are sampled rather than hand-written, every "he's working hard to
 * breathe" in the nurse's dialogue becomes a bug waiting to misgender someone.
 * Templates take a Voice and read naturally for she/he/they alike — including the
 * plural agreement they/them needs, which is the part that silently breaks if it
 * is bolted on later.
 */
export type Gender = 'female' | 'male' | 'nonbinary';

export interface Voice {
  gender: Gender;
  /** Charted sex marker, e.g. "F". */
  marker: string;
  /** she / he / they */
  subj: string;
  /** She / He / They */
  Subj: string;
  /** her / him / them */
  obj: string;
  /** her / his / their */
  poss: string;
  /** is / are */
  is: string;
  /** was / were */
  was: string;
  /** has / have */
  has: string;
  /** does / do */
  does: string;
  /** isn't / aren't */
  isnt: string;
  /**
   * Third-person verb agreement: verb('look') gives "looks" or "look".
   * Handles the -es cases the ward actually uses.
   */
  verb(base: string): string;
}

const FORMS: Record<Gender, Omit<Voice, 'verb' | 'gender' | 'marker'>> = {
  female: { subj: 'she', Subj: 'She', obj: 'her', poss: 'her', is: 'is', was: 'was', has: 'has', does: 'does', isnt: "isn't" },
  male: { subj: 'he', Subj: 'He', obj: 'him', poss: 'his', is: 'is', was: 'was', has: 'has', does: 'does', isnt: "isn't" },
  nonbinary: { subj: 'they', Subj: 'They', obj: 'them', poss: 'their', is: 'are', was: 'were', has: 'have', does: 'do', isnt: "aren't" },
};

const MARKERS: Record<Gender, string> = { female: 'F', male: 'M', nonbinary: 'X' };

export function makeVoice(gender: Gender): Voice {
  const forms = FORMS[gender];
  const plural = gender === 'nonbinary';
  return {
    gender,
    marker: MARKERS[gender],
    ...forms,
    verb(base: string): string {
      if (plural) return base;
      if (/(s|sh|ch|x|z|o)$/.test(base)) return `${base}es`;
      if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
      return `${base}s`;
    },
  };
}
