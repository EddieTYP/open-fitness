export const D1_MAX_BOUND_PARAMETERS = 100;

export function chunkByParameterLimit<T>(
  values: readonly T[],
  parametersPerValue = 1,
): T[][] {
  if (!Number.isInteger(parametersPerValue) || parametersPerValue < 1) {
    throw new Error("parametersPerValue must be a positive integer");
  }

  const chunkSize = Math.max(
    1,
    Math.floor(D1_MAX_BOUND_PARAMETERS / parametersPerValue),
  );
  const chunks: T[][] = [];

  for (let start = 0; start < values.length; start += chunkSize) {
    chunks.push(values.slice(start, start + chunkSize));
  }

  return chunks;
}
