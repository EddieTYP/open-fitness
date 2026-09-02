import type { Nutrients } from "@/lib/nutrition";

export type NutrientKey = keyof Nutrients;

export type NutrientPreviewSource = {
  nutrients: Nutrients;
  multiplier: number | null;
};

export type NutrientPreview = {
  invalid: boolean;
  empty: boolean;
  values: Record<NutrientKey, { value: number | null; partial: boolean }>;
};

const nutrientKeys: NutrientKey[] = [
  "energyKcal",
  "proteinG",
  "totalFatG",
  "saturatedFatG",
  "transFatG",
  "carbsG",
  "sugarG",
  "fibreG",
  "sodiumMg",
  "cholesterolMg",
];

export function calculateNutrientPreview(
  sources: NutrientPreviewSource[],
): NutrientPreview {
  const invalid = sources.some(
    (source) =>
      source.multiplier === null ||
      !Number.isFinite(source.multiplier) ||
      source.multiplier <= 0,
  );
  const values = Object.fromEntries(
    nutrientKeys.map((key) => {
      if (invalid || sources.length === 0) {
        return [key, { value: null, partial: false }];
      }
      const known = sources
        .map((source) => {
          const value = source.nutrients[key];
          return value === null ? null : value * source.multiplier!;
        })
        .filter((value): value is number => value !== null);
      if (known.length === 0) {
        return [key, { value: null, partial: false }];
      }
      return [
        key,
        {
          value: known.reduce((total, value) => total + value, 0),
          partial: known.length < sources.length,
        },
      ];
    }),
  ) as NutrientPreview["values"];

  return { invalid, empty: sources.length === 0, values };
}
