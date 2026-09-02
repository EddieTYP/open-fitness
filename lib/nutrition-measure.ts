type ParsedMeasure = {
  dimension: string;
  amount: number;
};

const unitAliases = new Map<string, { dimension: string; scale: number }>([
  ["mg", { dimension: "mass", scale: 0.001 }],
  ["milligram", { dimension: "mass", scale: 0.001 }],
  ["milligrams", { dimension: "mass", scale: 0.001 }],
  ["g", { dimension: "mass", scale: 1 }],
  ["gram", { dimension: "mass", scale: 1 }],
  ["grams", { dimension: "mass", scale: 1 }],
  ["kg", { dimension: "mass", scale: 1000 }],
  ["kilogram", { dimension: "mass", scale: 1000 }],
  ["kilograms", { dimension: "mass", scale: 1000 }],
  ["ml", { dimension: "volume", scale: 1 }],
  ["millilitre", { dimension: "volume", scale: 1 }],
  ["millilitres", { dimension: "volume", scale: 1 }],
  ["milliliter", { dimension: "volume", scale: 1 }],
  ["milliliters", { dimension: "volume", scale: 1 }],
  ["l", { dimension: "volume", scale: 1000 }],
  ["litre", { dimension: "volume", scale: 1000 }],
  ["litres", { dimension: "volume", scale: 1000 }],
  ["liter", { dimension: "volume", scale: 1000 }],
  ["liters", { dimension: "volume", scale: 1000 }],
  ["serving", { dimension: "count:serving", scale: 1 }],
  ["servings", { dimension: "count:serving", scale: 1 }],
  ["portion", { dimension: "count:portion", scale: 1 }],
  ["portions", { dimension: "count:portion", scale: 1 }],
  ["piece", { dimension: "count:piece", scale: 1 }],
  ["pieces", { dimension: "count:piece", scale: 1 }],
  ["pc", { dimension: "count:piece", scale: 1 }],
  ["pcs", { dimension: "count:piece", scale: 1 }],
  ["slice", { dimension: "count:slice", scale: 1 }],
  ["slices", { dimension: "count:slice", scale: 1 }],
  ["scoop", { dimension: "count:scoop", scale: 1 }],
  ["scoops", { dimension: "count:scoop", scale: 1 }],
  ["bowl", { dimension: "count:bowl", scale: 1 }],
  ["bowls", { dimension: "count:bowl", scale: 1 }],
  ["pack", { dimension: "count:pack", scale: 1 }],
  ["packs", { dimension: "count:pack", scale: 1 }],
  ["packet", { dimension: "count:pack", scale: 1 }],
  ["packets", { dimension: "count:pack", scale: 1 }],
]);

export class NutritionMeasureError extends Error {
  readonly requestedUnit: string;
  readonly basisUnit: string;
  readonly errorCode:
    | "INCOMPATIBLE_NUTRITION_UNIT"
    | "NUTRITION_QUANTITY_REQUIRED_FOR_UNIT"
    | "NUTRITION_MEASURE_OUT_OF_RANGE";

  constructor(
    requestedUnit: string,
    basisUnit: string,
    errorCode:
      | "INCOMPATIBLE_NUTRITION_UNIT"
      | "NUTRITION_QUANTITY_REQUIRED_FOR_UNIT"
      | "NUTRITION_MEASURE_OUT_OF_RANGE" = "INCOMPATIBLE_NUTRITION_UNIT",
  ) {
    super(
      errorCode === "INCOMPATIBLE_NUTRITION_UNIT"
        ? `Incompatible nutrition units: ${requestedUnit} and ${basisUnit}`
        : errorCode === "NUTRITION_QUANTITY_REQUIRED_FOR_UNIT"
          ? `Nutrition quantity is required when unit is supplied: ${requestedUnit}`
        : `Nutrition measure is out of range: ${requestedUnit}`,
    );
    this.name = "NutritionMeasureError";
    this.requestedUnit = requestedUnit;
    this.basisUnit = basisUnit;
    this.errorCode = errorCode;
  }
}

export function requireQuantityForExplicitNutritionUnit({
  quantity,
  unit,
  basisUnit,
}: {
  quantity: number | null | undefined;
  unit?: string | null;
  basisUnit: string;
}) {
  const requestedUnit = unit?.trim();
  if (requestedUnit && quantity == null) {
    throw new NutritionMeasureError(
      requestedUnit,
      basisUnit,
      "NUTRITION_QUANTITY_REQUIRED_FOR_UNIT",
    );
  }
}

const maximumCanonicalAmount = 100000;
const maximumNutrientScale = 100000;

function boundedRatio(
  requestedAmount: number,
  basisAmount: number,
  requestedUnit: string,
  basisUnit: string,
) {
  const ratio = requestedAmount / basisAmount;
  if (
    !Number.isFinite(requestedAmount) ||
    requestedAmount <= 0 ||
    requestedAmount > maximumCanonicalAmount ||
    !Number.isFinite(basisAmount) ||
    basisAmount <= 0 ||
    !Number.isFinite(ratio) ||
    ratio <= 0 ||
    ratio > maximumNutrientScale
  ) {
    throw new NutritionMeasureError(
      requestedUnit,
      basisUnit,
      "NUTRITION_MEASURE_OUT_OF_RANGE",
    );
  }
  return ratio;
}

function parsedMeasure(quantity: number, unit: string): ParsedMeasure {
  const normalized = unit.trim().toLocaleLowerCase().replaceAll(" ", "");
  const embedded = /^(\d+(?:\.\d+)?)(.+)$/.exec(normalized);
  const unitQuantity = embedded ? Number(embedded[1]) : 1;
  const unitName = embedded?.[2] ?? normalized;
  const known = unitAliases.get(unitName);
  if (known) {
    return {
      dimension: known.dimension,
      amount: quantity * unitQuantity * known.scale,
    };
  }
  return {
    dimension: `opaque:${unitName}`,
    amount: quantity * unitQuantity,
  };
}

function compatibleRatio(
  requestedQuantity: number,
  requestedUnit: string,
  basisQuantity: number,
  basisUnit: string,
) {
  const requested = parsedMeasure(requestedQuantity, requestedUnit);
  const basis = parsedMeasure(basisQuantity, basisUnit);
  if (requested.dimension !== basis.dimension) {
    throw new NutritionMeasureError(requestedUnit, basisUnit);
  }
  return boundedRatio(
    requested.amount,
    basis.amount,
    requestedUnit,
    basisUnit,
  );
}

export function resolveRegisteredFoodMeasure({
  quantity,
  unit,
  baseQuantity,
  baseUnit,
}: {
  quantity: number;
  unit?: string | null;
  baseQuantity: number;
  baseUnit: string;
}) {
  const requestedUnit = unit?.trim() || null;
  if (!requestedUnit) {
    return {
      quantity,
      unit: baseUnit,
      nutrientScale: boundedRatio(
        quantity,
        baseQuantity,
        baseUnit,
        baseUnit,
      ),
    };
  }
  return {
    quantity,
    unit: requestedUnit,
    nutrientScale: compatibleRatio(
      quantity,
      requestedUnit,
      baseQuantity,
      baseUnit,
    ),
  };
}

export function resolveRelativeNutritionMeasure({
  quantity,
  unit,
  currentQuantity,
  currentUnit,
}: {
  quantity: number;
  unit?: string | null;
  currentQuantity: number;
  currentUnit: string;
}) {
  const requestedUnit = unit?.trim() || null;
  if (!requestedUnit) {
    return {
      quantity,
      unit: currentUnit,
      nutrientScale: boundedRatio(
        quantity,
        currentQuantity,
        currentUnit,
        currentUnit,
      ),
    };
  }
  return {
    quantity,
    unit: requestedUnit,
    nutrientScale: compatibleRatio(
      quantity,
      requestedUnit,
      currentQuantity,
      currentUnit,
    ),
  };
}
