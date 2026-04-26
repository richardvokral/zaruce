/**
 * Attribute schema for the selfie-inspired flow.
 *
 * Total cardinality: 6 × 3 × 6 × 6 × 2 × 3 = 3,888 buckets.
 * Bias toward usability: enums are deliberately coarse so the resulting bucket
 * cannot be used to re-identify the visitor.
 */

export const AGE_BUCKETS = [
  "child",
  "teen",
  "young-adult",
  "adult",
  "middle",
  "senior",
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export const PRESENTATIONS = ["masc", "fem", "ambiguous"] as const;
export type Presentation = (typeof PRESENTATIONS)[number];

export const HAIR_COLORS = [
  "black",
  "brown",
  "blond",
  "red",
  "gray",
  "other",
] as const;
export type HairColor = (typeof HAIR_COLORS)[number];

// Fitzpatrick I–VI
export const SKIN_TONES = [1, 2, 3, 4, 5, 6] as const;
export type SkinTone = (typeof SKIN_TONES)[number];

export const HAIR_LENGTHS = ["short", "medium", "long"] as const;
export type HairLength = (typeof HAIR_LENGTHS)[number];

export interface Attributes {
  age: AgeBucket;
  presentation: Presentation;
  hairColor: HairColor;
  skinTone: SkinTone;
  glasses: boolean;
  hairLength: HairLength;
}

export const TOTAL_BUCKETS =
  AGE_BUCKETS.length *
  PRESENTATIONS.length *
  HAIR_COLORS.length *
  SKIN_TONES.length *
  2 *
  HAIR_LENGTHS.length;

/**
 * Stable id for a bucket. Used as the foreign key into `attribute_buckets`
 * and as the lookup key for the seed table.
 */
export function bucketId(a: Attributes): number {
  let id = 0;
  id = id * AGE_BUCKETS.length + AGE_BUCKETS.indexOf(a.age);
  id = id * PRESENTATIONS.length + PRESENTATIONS.indexOf(a.presentation);
  id = id * HAIR_COLORS.length + HAIR_COLORS.indexOf(a.hairColor);
  id = id * SKIN_TONES.length + SKIN_TONES.indexOf(a.skinTone);
  id = id * 2 + (a.glasses ? 1 : 0);
  id = id * HAIR_LENGTHS.length + HAIR_LENGTHS.indexOf(a.hairLength);
  return id;
}

export function bucketFromId(id: number): Attributes {
  let n = id;
  const hairLength = HAIR_LENGTHS[n % HAIR_LENGTHS.length]!;
  n = Math.floor(n / HAIR_LENGTHS.length);
  const glasses = (n % 2) === 1;
  n = Math.floor(n / 2);
  const skinTone = SKIN_TONES[n % SKIN_TONES.length]!;
  n = Math.floor(n / SKIN_TONES.length);
  const hairColor = HAIR_COLORS[n % HAIR_COLORS.length]!;
  n = Math.floor(n / HAIR_COLORS.length);
  const presentation = PRESENTATIONS[n % PRESENTATIONS.length]!;
  n = Math.floor(n / PRESENTATIONS.length);
  const age = AGE_BUCKETS[n % AGE_BUCKETS.length]!;
  return { age, presentation, hairColor, skinTone, glasses, hairLength };
}

/**
 * Human-readable preview shown to the user before they confirm upload.
 * Numbers and codes are deliberately replaced with phrases.
 */
export function describeAttributes(a: Attributes): string[] {
  const ageText: Record<AgeBucket, string> = {
    "child": "approx. age: under 13",
    "teen": "approx. age: 13–19",
    "young-adult": "approx. age: 20–29",
    "adult": "approx. age: 30–44",
    "middle": "approx. age: 45–59",
    "senior": "approx. age: 60+",
  };
  const presentationText: Record<Presentation, string> = {
    "masc": "presentation: masculine",
    "fem": "presentation: feminine",
    "ambiguous": "presentation: ambiguous",
  };
  const hairColorText: Record<HairColor, string> = {
    "black": "hair: dark",
    "brown": "hair: brown",
    "blond": "hair: blond",
    "red": "hair: red",
    "gray": "hair: gray",
    "other": "hair: other",
  };
  const skinText: Record<SkinTone, string> = {
    1: "skin tone: very light",
    2: "skin tone: light",
    3: "skin tone: medium-light",
    4: "skin tone: medium",
    5: "skin tone: medium-dark",
    6: "skin tone: dark",
  };
  const lengthText: Record<HairLength, string> = {
    "short": "hair length: short",
    "medium": "hair length: medium",
    "long": "hair length: long",
  };
  return [
    ageText[a.age],
    presentationText[a.presentation],
    hairColorText[a.hairColor],
    skinText[a.skinTone],
    a.glasses ? "glasses: yes" : "glasses: no",
    lengthText[a.hairLength],
  ];
}
