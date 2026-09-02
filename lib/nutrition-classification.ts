export type MealClassification<MealType extends string = string> = {
  mealType: MealType;
  contextTag: string | null;
  originalMealType: string | null;
};

export class MealClassificationValidationError extends Error {}

export function validateMealClassification<MealType extends string>(
  classification: MealClassification<MealType>,
): MealClassification<MealType> {
  const { mealType, contextTag, originalMealType } = classification;

  if (contextTag !== null && contextTag !== "post_workout") {
    throw new MealClassificationValidationError("Unsupported meal contextTag");
  }
  if (contextTag === "post_workout" && mealType !== "other") {
    throw new MealClassificationValidationError(
      "post_workout classification requires mealType other",
    );
  }
  if (contextTag === null && originalMealType !== null) {
    throw new MealClassificationValidationError(
      "originalMealType is only valid for post_workout",
    );
  }

  return classification;
}
