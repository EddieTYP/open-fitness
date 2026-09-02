#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const readResources = {
  instructions: { local: true, query: [] },
  write_contract: {
    local: true,
    query: ["operation"],
    required: ["operation"],
  },
  evidence_reference: { local: true, query: [] },
  profile: { path: "/api/fitness/profile", query: [] },
  snapshot: { path: "/api/fitness/snapshot", query: ["venue"] },
  analysis: {
    path: "/api/fitness/analysis",
    query: ["from", "to", "exercise"],
  },
  revisions: { path: "/api/fitness/revisions", query: [] },
  workout_contract: { path: "/api/fitness/workout-sessions", query: [] },
  workout: {
    path: "/api/fitness/workout-sessions",
    query: ["sessionId"],
    required: ["sessionId"],
  },
  body_measurement: {
    path: "/api/fitness/body-measurements",
    query: ["measurementId"],
    required: ["measurementId"],
  },
  training_template: { path: "/api/fitness/training-template", query: [] },
  training_exercises: {
    path: "/api/fitness/training-selections",
    query: ["q", "phaseId", "slotId"],
  },
  training_progression: {
    path: "/api/fitness/training-progression",
    query: ["phaseId"],
    required: ["phaseId"],
  },
  nutrition_today: { path: "/api/nutrition/today", query: ["date"] },
  nutrition_targets: {
    path: "/api/nutrition/targets",
    query: ["date"],
  },
  nutrition_calibration: {
    path: "/api/nutrition/calibration",
    query: ["asOf"],
  },
  foods: {
    path: "/api/nutrition/items",
    query: ["q", "includeInactive"],
  },
  combos: {
    path: "/api/nutrition/combos",
    query: ["q", "includeInactive"],
  },
  plans: { path: "/api/nutrition/plans", query: [] },
};

const noWritePreflight = Object.freeze({ kind: "none" });

const writeOperationDescriptors = {
  workout_create: writeDescriptor("POST", "/api/fitness/workout-sessions", {
    preflight: noWritePreflight,
    normalise: normaliseWorkoutBody,
    validate: validateWorkoutCreate,
    receipt: receiptWithId("sessionId", ["setsInserted"]),
    readback: workoutReadbackRequest,
    verify: verifyWorkoutCreate,
  }),
  workout_validate: writeDescriptor(
    "POST",
    "/api/fitness/workout-sessions?validateOnly=1",
    {
      preflight: noWritePreflight,
      mutating: false,
      normalise: normaliseWorkoutBody,
      validate: validateWorkoutCreate,
      receipt: workoutValidationReceipt,
      verify: verifyReceipt,
    },
  ),
  workout_update: writeDescriptor("PATCH", "/api/fitness/workout-sessions", {
    preflight: noWritePreflight,
    validate: validateWorkoutUpdate,
    receipt: receiptWithId("sessionId", ["action", "noOp", "voidedAt"]),
    readback: workoutReadbackRequest,
    verify: verifyWorkoutUpdate,
  }),
  body_measurement_create: writeDescriptor(
    "POST",
    "/api/fitness/body-measurements",
    {
      preflight: noWritePreflight,
      normalise: normaliseDeepStrings,
      validate: validateBodyMeasurementCreate,
      receipt: receiptWithId("measurementId"),
      readback: bodyMeasurementReadbackRequest,
      verify: verifyBodyMeasurementCreate,
      facts: bodyMeasurementFacts,
    },
  ),
  body_measurement_enrich: writeDescriptor(
    "PATCH",
    "/api/fitness/body-measurements",
    {
      preflight: noWritePreflight,
      normalise: normaliseDeepStrings,
      validate: validateBodyMeasurementEnrich,
      receipt: bodyMeasurementEnrichReceipt,
      readback: bodyMeasurementReadbackRequest,
      verify: verifyBodyMeasurementEnrich,
    },
  ),
  session_note_create: writeDescriptor("POST", "/api/fitness/session-notes", {
    preflight: noWritePreflight,
    validate: validateSessionNoteCreate,
    receipt: receiptWithId("noteId"),
    readback: sessionNoteReadbackRequest,
    verify: verifySessionNoteCreate,
  }),
  correction_create: writeDescriptor("POST", "/api/fitness/corrections", {
    preflight: noWritePreflight,
    normalise: normaliseCorrectionBody,
    validate: validateCorrectionCreate,
    receipt: receiptWithId("correctionId"),
    readback: correctionReadbackRequest,
    verify: verifyCorrectionCreate,
  }),
  training_exercise_select: writeDescriptor(
    "POST",
    "/api/fitness/training-selections",
    {
      preflight: noWritePreflight,
      normalise: normaliseDeepStrings,
      validate: validateTrainingExerciseSelect,
      receipt: trainingSelectionReceipt,
      verify: verifyTrainingSelection,
    },
  ),
  training_course_update: writeDescriptor(
    "POST",
    "/api/fitness/training-course",
    {
      preflight: noWritePreflight,
      normalise: normaliseDeepStrings,
      validate: validateTrainingCourseUpdate,
      receipt: trainingCourseReceipt,
      verify: verifyTrainingCourse,
    },
  ),
  training_block_start: writeDescriptor("PATCH", "/api/fitness/profile", {
    preflight: noWritePreflight,
    normalise: normaliseTrainingBlockBody,
    validate: validateReceiptBody,
    receipt: trainingBlockReceipt,
    verify: verifyTrainingBlock,
  }),
  training_template_update: writeDescriptor(
    "PUT",
    "/api/fitness/training-template",
    {
      preflight: noWritePreflight,
      normalise: normaliseTrainingTemplateBody,
      validate: validateTrainingTemplateUpdate,
      receipt: trainingTemplateReceipt,
      verify: verifyTrainingTemplate,
    },
  ),
  food_item_create: writeDescriptor("POST", "/api/nutrition/items", {
    preflight: noWritePreflight,
    normalise: normaliseDeepStrings,
    validate: validateFoodItemCreate,
    receipt: receiptWithId("foodId", ["versionNo"], "item"),
    verify: verifyFoodItem,
  }),
  food_item_update: writeDescriptor("PATCH", "/api/nutrition/items", {
    preflight: noWritePreflight,
    normalise: normaliseDeepStrings,
    validate: validateFoodItemUpdate,
    receipt: receiptWithId("foodId", ["versionNo"], "item"),
    verify: verifyFoodItem,
  }),
  meal_create: writeDescriptor("POST", "/api/nutrition/meals", {
    preflight: noWritePreflight,
    normalise: normaliseMealBody,
    validate: validateMealCreate,
    receipt: receiptWithId("mealId", [
      "revisionNo",
      "mealType",
      "mealTypeInferred",
    ]),
    verify: verifyNutritionMeal,
  }),
  meal_update: writeDescriptor("PATCH", "/api/nutrition/meals", {
    preflight: noWritePreflight,
    normalise: normaliseMealBody,
    validate: validateMealUpdate,
    route: mealUpdateRoute,
    receipt: receiptWithId("mealId", ["revisionNo", "unchanged"]),
    verify: verifyNutritionMeal,
  }),
  meal_delete: writeDescriptor("DELETE", "/api/nutrition/meals", {
    preflight: noWritePreflight,
    validate: validateMealDelete,
    receipt: receiptWithId("mealId", [
      "revisionNo",
      "deletedMeal",
      "unchanged",
    ]),
    verify: verifyNutritionMeal,
  }),
  active_energy_create: writeDescriptor("POST", "/api/nutrition/energy", {
    preflight: noWritePreflight,
    validate: validateActiveEnergyCreate,
    receipt: receiptWithId("energyObservationId"),
    readback: activeEnergyReadbackRequest,
    verify: verifyActiveEnergyCreate,
  }),
  nutrition_target_set: writeDescriptor("POST", "/api/nutrition/targets", {
    preflight: noWritePreflight,
    validate: validateNutritionTargetSet,
    receipt: nutritionTargetReceipt,
    verify: verifyNutritionTarget,
  }),
  nutrition_formula_calibrate: writeDescriptor(
    "POST",
    "/api/nutrition/targets",
    {
      preflight: noWritePreflight,
      normalise: normaliseNutritionFormulaCalibration,
      validate: validateReceiptBody,
      receipt: nutritionTargetReceipt,
      verify: verifyNutritionTarget,
    },
  ),
  combo_create: writeDescriptor("POST", "/api/nutrition/combos", {
    preflight: noWritePreflight,
    normalise: normaliseSavedFoodQuantityBody,
    validate: validateComboCreate,
    receipt: receiptWithId("comboId", ["versionNo"], "combo"),
    verify: verifyNutritionCombo,
  }),
  combo_update: writeDescriptor("PATCH", "/api/nutrition/combos", {
    preflight: noWritePreflight,
    normalise: normaliseSavedFoodQuantityBody,
    validate: validateComboUpdate,
    receipt: receiptWithId("comboId", ["versionNo"], "combo"),
    verify: verifyNutritionCombo,
  }),
  plan_create: writeDescriptor("POST", "/api/nutrition/plans", {
    preflight: noWritePreflight,
    normalise: normaliseSavedFoodQuantityBody,
    validate: validatePlanCreate,
    receipt: nutritionPlanReceipt,
    verify: verifyNutritionPlan,
  }),
  plan_update: writeDescriptor("PATCH", "/api/nutrition/plans", {
    preflight: noWritePreflight,
    normalise: normaliseSavedFoodQuantityBody,
    validate: validatePlanUpdate,
    receipt: receiptWithId(
      "planId",
      ["versionNo", "mealId", "revisionNo"],
      "plan",
    ),
    verify: verifyNutritionPlan,
  }),
  plan_delete: writeDescriptor("DELETE", "/api/nutrition/plans", {
    preflight: noWritePreflight,
    validate: validatePlanDelete,
    receipt: nutritionPlanDeleteReceipt,
    verify: verifyNutritionPlanDelete,
  }),
};

const writeContractVersion = "2026-08-26.1";
const writeContractCards = Object.freeze({
  workout_create: contractCard({
    purpose: "Create one completed workout session.",
    requiredReads: ["snapshot", "workout_contract"],
    bodyTemplate: {
      title: "Session title",
      type: "Strength",
      startedAt: "ISO-8601 timestamp",
      durationSeconds: 3600,
      sessionIntent: "normal | deload | test",
      sets: [
        {
          exercise: "Exercise name",
          setNoExercise: 1,
          reps: 8,
          weightKgReported: 50,
          effortRaw: "RIR 2",
        },
      ],
    },
    rules: [
      "Use notesManual only for session notes, coachNote for a set note, and setTypeManual for set classification.",
      "Grouped exercises[].exerciseName with sets[].setNumber and sets[].weightKg is accepted and canonicalised deterministically.",
      "Preserve explicit date, venue, phase, block, effort, and source wording; never invent missing values.",
    ],
  }),
  workout_validate: contractCard({
    purpose: "Validate a completed-workout payload without writing it.",
    requiredReads: ["snapshot", "workout_contract"],
    bodyTemplate: {
      title: "Session title",
      type: "Strength",
      startedAt: "ISO-8601 timestamp",
      durationSeconds: 3600,
      sessionIntent: "normal | deload | test",
      sets: [{ exercise: "Exercise name", setNoExercise: 1, reps: 8 }],
    },
    rules: ["A successful result is validated, not succeeded, and no mutation occurs."],
  }),
  workout_update: contractCard({
    purpose: "Void or restore one existing workout.",
    requiredReads: ["workout"],
    bodyTemplate: {
      action: "void | restore",
      sessionId: "WORKOUT|...",
      reason: "Owner-provided reason",
    },
    rules: ["Use the exact current sessionId and do not create a replacement workout."],
  }),
  body_measurement_create: contractCard({
    purpose: "Create one body measurement with all supplied canonical fields.",
    requiredReads: [],
    bodyTemplate: {
      measurementId: "Stable owner/source measurement ID",
      measuredAt: "ISO-8601 timestamp",
      source: "Data channel",
      sourceDevice: "Measuring device",
      weightKg: 80,
    },
    rules: [
      "Include every supplied total and segmental value in this single create; do not split the measurement.",
      "Read profile only when an exact measuredAt timestamp cannot be derived without its timezone or locale; do not read it for an already explicit ISO-8601 timestamp.",
      "Do not pre-read analysis or body-measurement history to check duplicates; the connector owns deterministic validation and idempotency.",
      "A succeeded result already contains the current measurement, previous same-device comparison, and bounded seven-day trend facts; acknowledge one supported seven-day observation when sevenDay.sufficient is true, otherwise state briefly that the trend is not yet sufficient. Do not read analysis or repeat the exact readback for a daily acknowledgement.",
    ],
  }),
  body_measurement_enrich: contractCard({
    purpose: "Fill missing extended fields on one existing body measurement.",
    requiredReads: ["body_measurement"],
    bodyTemplate: {
      measurementId: "MEASUREMENT|...",
      expectedCreatedAt: "Exact current createdAt",
      values: { bmrKcal: 1800 },
    },
    rules: ["Only fill supported missing values; never overwrite an existing non-null measurement value."],
  }),
  session_note_create: contractCard({
    purpose: "Create one dated recovery, pain, readiness, or progress note.",
    requiredReads: [],
    bodyTemplate: {
      noteDate: "YYYY-MM-DD",
      noteType: "observation",
      note: "Owner wording or faithful summary",
    },
    rules: ["Keep a one-off observation scoped to its actual date and body area or training context."],
  }),
  correction_create: contractCard({
    purpose: "Append one field-level correction to an existing record.",
    requiredReads: ["workout or the smallest resource containing the target"],
    bodyTemplate: {
      targetScope: "workout_session | workout_set | operating_constraint",
      targetKey: "Exact target ID",
      fieldName: "Canonical field name",
      originalValue: null,
      correctedValue: "Correct typed value",
      effectiveDate: "YYYY-MM-DD",
      reason: "Owner-provided reason",
      source: "Owner correction",
    },
    rules: [
      "Read and send the exact current effective originalValue, including JSON null when it is unset.",
      "Workout fields are session_title, training_phase_id, exercise, reps, weight_kg_reported, and effort_raw.",
    ],
  }),
  training_exercise_select: contractCard({
    purpose: "Select one exercise for a training slot at date, venue, or template scope.",
    requiredReads: ["training_exercises", "snapshot or training_template"],
    bodyTemplate: {
      phaseId: "Phase ID",
      slotId: "Slot ID",
      exercise: "Exercise name",
      scope: "date | venue | template",
      date: "Required for date scope",
    },
    rules: ["For venue scope send venue; for template scope send expectedUpdatedAt instead of date."],
  }),
  training_course_update: contractCard({
    purpose: "Save one confirmed date course, planned deload/test, or next-normal progression override.",
    requiredReads: ["snapshot or training_progression"],
    bodyTemplate: {
      scope: "date | planned_session | next_normal_occurrence",
      phaseId: "Phase ID",
      date: "YYYY-MM-DD for date or planned_session",
      expectedPlanFingerprint: "Required for date or planned_session",
      items: [
        {
          slotId: "Slot ID",
          exercise: "Exercise name",
          prescription: "3 x 8-10",
          loadGuidance: "50 kg",
          effort: "RIR 2-3",
        },
      ],
    },
    rules: [
      "planned_session also requires trainingBlockId and sessionIntent deload or test.",
      "next_normal_occurrence requires trainingBlockId and expectedProgressionFingerprint; include sourceSessionId when supplied by progression.",
      "Do not mix scopes or omit working items from a complete date-scoped course.",
    ],
  }),
  training_block_start: contractCard({
    purpose: "Start one owner-confirmed persistent training block.",
    requiredReads: ["profile"],
    bodyTemplate: {
      expectedUpdatedAt: "Current profile updatedAt",
      goalType: "Goal type",
      primaryGoal: "Owner-confirmed goal",
      trainingBlockChangeReason: "Reason for the new block",
      trainingCycleConfig: { version: 2, phases: [] },
    },
    rules: ["Only write after the owner confirms a persistent block rather than a one-session change."],
  }),
  training_template_update: contractCard({
    purpose: "Replace the owner-confirmed training template.",
    requiredReads: ["training_template"],
    bodyTemplate: {
      expectedUpdatedAt: "Current template/profile updatedAt",
      template: { phases: [] },
    },
    rules: ["Send the complete template snapshot and preserve every unaffected phase and slot."],
  }),
  food_item_create: contractCard({
    purpose: "Create one reusable registered food that does not already exist.",
    requiredReads: ["foods"],
    bodyTemplate: {
      displayName: "Food name",
      brand: "Optional brand",
      baseQuantity: 100,
      baseUnit: "g",
      nutrients: { energyKcal: 100, proteinG: 10 },
      sourceNote: "Optional source note",
    },
    rules: [
      "The canonical create field is baseUnit; defaultUnit is read-only output and is invalid here.",
      "Search broadly enough to reuse an existing food. For the same product with revised packaging or nutrition, use food_item_update rather than creating a duplicate.",
    ],
  }),
  food_item_update: contractCard({
    purpose: "Revise, deactivate, or reactivate one registered food.",
    requiredReads: ["foods with includeInactive when needed"],
    bodyTemplate: {
      foodId: "FOOD|...",
      action: "revise | deactivate | reactivate",
      expectedVersionNo: 1,
      baseQuantity: 100,
      baseUnit: "g",
      nutrients: { energyKcal: 100 },
    },
    rules: ["For revise send only supported changed fields plus the exact food identity/version required by the current API state."],
  }),
  meal_create: contractCard({
    purpose: "Record one completed/eaten meal.",
    requiredReads: ["nutrition_today", "foods or combos when referenced"],
    bodyTemplate: {
      localDate: "YYYY-MM-DD",
      mealType: "breakfast | lunch | snack | dinner | other",
      timePrecision: "exact | inferred | date_only",
      eatenAt: null,
      items: [
        {
          name: "One-off food name",
          quantity: 1,
          unit: "serving",
          nutrients: { energyKcal: 100 },
        },
      ],
    },
    rules: [
      "Use meal_create only for food already eaten; pending meal prep must use plan_create.",
      "For a registered food, include unit whenever quantity is not expressed as a count of the food's native base unit; the API performs the authoritative compatible-unit conversion.",
    ],
  }),
  meal_update: contractCard({
    purpose: "Replace or target-correct one existing completed meal.",
    requiredReads: ["nutrition_today containing the exact meal"],
    bodyTemplate: {
      mealId: "MEAL|...",
      expectedRevisionNo: 1,
      action: "quantity | classification | append_food, or omit for full replacement",
    },
    rules: [
      "A full replacement is top-level and includes the complete items array; do not nest it under meal.",
      "For a targeted quantity or append_food update, include unit when the reported quantity uses a different compatible unit from the stored item or food basis.",
    ],
  }),
  meal_delete: contractCard({
    purpose: "Soft-delete or restore a completed meal or one meal item.",
    requiredReads: ["nutrition_today containing the exact meal"],
    bodyTemplate: {
      mealId: "MEAL|...",
      expectedRevisionNo: 1,
      deleteMeal: true,
    },
    rules: ["When deleteMeal is not true, provide the exact mealItemId."],
  }),
  active_energy_create: contractCard({
    purpose: "Save one owner-supplied Active Energy observation.",
    requiredReads: ["nutrition_today"],
    bodyTemplate: {
      localDate: "YYYY-MM-DD",
      activeEnergyKcal: 500,
      status: "provisional | final",
      observedAt: null,
      source: "Source name",
    },
    rules: ["Do not substitute workout-reported calories for daily Active Energy."],
  }),
  nutrition_target_set: contractCard({
    purpose: "Set one owner-confirmed fixed calorie and protein target.",
    requiredReads: ["nutrition_targets"],
    bodyTemplate: {
      effectiveFrom: "YYYY-MM-DD",
      calorieTargetKcal: 2000,
      proteinTargetG: 150,
    },
    rules: ["Calories must be an integer 500-6000; protein must be greater than 0 and at most 500 g."],
  }),
  nutrition_formula_calibrate: contractCard({
    purpose: "Apply one owner-confirmed nutrition formula calibration.",
    requiredReads: ["nutrition_calibration", "nutrition_targets"],
    bodyTemplate: {
      mode: "formula",
      effectiveFrom: "YYYY-MM-DD",
      dailyDeficitKcal: 400,
      activeEnergyCreditRate: 0.8,
      proteinTargetG: 150,
      expectedSettingsId: "Current settings ID",
    },
    rules: ["Never auto-calibrate; present the exact proposal and write only after explicit owner confirmation."],
  }),
  combo_create: contractCard({
    purpose: "Create one reusable combination serving from registered foods.",
    requiredReads: ["foods", "combos"],
    bodyTemplate: {
      displayName: "Combination name",
      defaultMealType: "lunch",
      items: [{ foodId: "FOOD|...", quantity: 40, unit: "g" }],
    },
    rules: ["Include unit whenever quantity is not a count of the food's native base unit; never copy read-only defaultQuantity into a new request."],
  }),
  combo_update: contractCard({
    purpose: "Revise, deactivate, or reactivate one reusable combination.",
    requiredReads: ["combos", "foods for any revised item list"],
    bodyTemplate: {
      comboId: "COMBO|...",
      action: "revise | deactivate | reactivate",
      expectedVersionNo: 1,
      items: [{ foodId: "FOOD|...", quantity: 40, unit: "g" }],
    },
    rules: ["A revise sends the complete ordered item list and the exact current version. Include unit whenever quantity is not a count of the food's native base unit."],
  }),
  plan_create: contractCard({
    purpose: "Create pending/planned food that contributes nothing to intake until consumed.",
    requiredReads: ["plans", "foods", "combos when meal prep is reusable"],
    bodyTemplate: {
      scheduledDates: ["YYYY-MM-DD"],
      mealType: "breakfast | lunch | snack | dinner | other",
      items: [{ foodId: "FOOD|...", quantity: 0.4 }],
      confidence: "medium",
      originalText: "Optional owner wording",
    },
    rules: [
      "Represent the language-neutral intent as targetDate or scheduledDates, mealType, items, and action add before selecting a write operation.",
      "For a registered food, include unit whenever quantity is not expressed as a count of the food's native base unit; the API performs the authoritative compatible-unit conversion.",
      "For multi-day meal prep, use one plan_create call with all scheduledDates and the complete per-date items array.",
      "Reuse registered foods and an existing matching combination; create or revise only genuinely missing reusable data after reading its own write contract.",
      "Do not call meal_create and do not mark pending portions as eaten.",
    ],
  }),
  plan_update: contractCard({
    purpose: "Revise, consume, or undo consumption of one pending plan.",
    requiredReads: ["plans"],
    bodyTemplate: {
      planId: "PLAN|...",
      expectedVersionNo: 1,
      action: "revise | consume | undo_consume",
    },
    rules: [
      "For action add, read plans with no extra arguments, select by exact scheduledDate and mealType, preserve every existing item, append the requested items, then revise once with the exact current version.",
      "If no pending plan matches, use plan_create; if multiple plans match or the target date or meal type is ambiguous, ask the owner and do not write.",
      "For revise include at least one supported changed field; for consume/undo use the exact current plan version.",
    ],
  }),
  plan_delete: contractCard({
    purpose: "Cancel one pending nutrition plan.",
    requiredReads: ["plans"],
    bodyTemplate: { planId: "PLAN|...", expectedVersionNo: 1 },
    rules: ["Cancel only the exact current pending plan and stop on a version conflict."],
  }),
});

function contractCard({ purpose, requiredReads, bodyTemplate, rules }) {
  return Object.freeze({
    contractVersion: writeContractVersion,
    purpose,
    requiredReads: Object.freeze(requiredReads),
    bodyTemplate: Object.freeze(bodyTemplate),
    rules: Object.freeze(rules),
    outcomes: Object.freeze([
      "succeeded: mutation completed and was authoritatively verified",
      "validated: non-mutating validation completed",
      "failed: no safe retry with guessed fields or another endpoint",
      "conflict: re-read current state before proposing another write",
      "uncertain: retry at most once only when retryable is true, with the same requestId and identical body",
    ]),
  });
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const requestKeyPattern = /^[A-Za-z0-9._:-]{8,200}$/;
const apiErrorCodePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const maxMessageBytes = 1_048_576;
const maxBodyBytes = 524_288;
const maxFactsBytes = 8_192;
const maxFactDepth = 4;
const maxFactEntries = 24;
const maxEntityIds = 100;
const analysisViews = new Set(["default", "full"]);
const correctionNumericFields = new Set(["reps", "weight_kg_reported"]);
const mealTimePrecisionValues = new Set([
  "exact",
  "inferred",
  "date_only",
]);
const mealNameAliases = ["itemName", "itemNameSnapshot"];
const mealNutrientFields = [
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
const mealItemFields = new Set([
  "foodId",
  "name",
  "quantity",
  "unit",
  "confidence",
  "assumption",
  "nutrients",
]);
const comboItemFields = new Set(["foodId", "quantity", "unit"]);
const planItemFields = new Set([
  "planItemId",
  "foodId",
  "name",
  "quantity",
  "unit",
  "confidence",
  "assumption",
  "nutrients",
]);
const nutrientFields = new Set(mealNutrientFields);
const canonicalNumberPattern = /^(?:0|-[1-9]\d*|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const defaultAnalysisOmissions = new Set([
  "profileId",
  "measurementId",
  "metabolicAgeYears",
  "physiqueRating",
  "muscleMassRightArmKg",
  "muscleMassLeftArmKg",
  "muscleMassRightLegKg",
  "muscleMassLeftLegKg",
  "muscleMassTrunkKg",
  "muscleQualityRightArm",
  "muscleQualityLeftArm",
  "muscleQualityRightLeg",
  "muscleQualityLeftLeg",
  "muscleQualityTrunk",
  "bodyFatRightArmPct",
  "bodyFatLeftArmPct",
  "bodyFatRightLegPct",
  "bodyFatLeftLegPct",
  "bodyFatTrunkPct",
  "setId",
  "noteId",
  "correctionId",
  "ruleId",
  "evidenceId",
  "mealId",
  "mealItemId",
  "foodId",
  "foodVersionId",
  "energyObservationId",
  "settingsId",
  "source",
  "sourceFile",
  "sourceDevice",
  "createdAt",
  "createdBy",
  "updatedAt",
  "startedAtUtc",
  "evidenceBase",
  "dataPolicies",
  "operatingConstraintHistory",
]);

function configuredApi() {
  const rawBase = process.env.FITNESS_API_BASE_URL?.trim();
  const token = process.env.FITNESS_API_TOKEN?.trim();
  if (!rawBase) throw new Error("FITNESS_API_BASE_URL is not configured");
  if (!token || /[\r\n]/.test(token)) {
    throw new Error("FITNESS_API_TOKEN is not configured correctly");
  }

  const base = new URL(rawBase);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  ) {
    throw new Error(
      "FITNESS_API_BASE_URL must be an origin without credentials, path, query, or fragment",
    );
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !loopbackHosts.has(base.hostname)
  ) {
    throw new Error("FITNESS_API_BASE_URL must use a loopback HTTP or HTTPS origin");
  }
  return { base, token };
}

let api;
try {
  api = configuredApi();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Invalid fitness MCP configuration"}\n`,
  );
  process.exit(1);
}
const coreInstructions = Object.freeze({
  contractVersion: writeContractVersion,
  workflow: [
    "Treat the authenticated Open Fitness API as the record of truth and read only the smallest relevant resource.",
    "Classify the request as read/advice, completed record, pending plan, correction, or calculation only.",
    "Before every fitness_write operation, read fitness_read resource write_contract with that exact operation and follow its bounded card.",
    "Use the profile preferredLocale for newly composed stored text; preserve explicit owner wording and brand/product names.",
    "Make only the explicitly intended mutation. The connector performs validation and authoritative verification.",
    "Stop on failed or conflict. Retry at most once only after uncertain with retryable true, using the same requestId and identical body.",
  ],
  safety: [
    "Never read or edit SQLite directly, call an admin endpoint, expose credentials/internal paths, or use one owner's records for another person.",
    "Missing data stays absent or null. Never invent a date, venue, amount, unit, field alias, entity ID, or endpoint.",
    "Pending plans contribute nothing to intake until consumed; never turn a planned meal into an eaten meal unless the owner says it was eaten.",
  ],
  references: {
    writeContract: {
      resource: "write_contract",
      requiredArgument: "operation",
    },
    evidence: { resource: "evidence_reference" },
  },
});

const tools = [
  {
    name: "fitness_read",
    description:
      "Read the smallest allowlisted Open Fitness view. A generic client that has not loaded the Open Fitness Skill can read instructions for the bounded workflow. Before composing a write, read write_contract with the exact write operation; it returns a bounded canonical body card. Read evidence_reference only for coaching or evidence questions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["resource"],
      properties: {
        resource: { type: "string", enum: Object.keys(readResources) },
        operation: {
          type: "string",
          enum: Object.keys(writeOperationDescriptors),
          description: "Required only for resource write_contract",
        },
        from: { type: "string", description: "Profile-local date YYYY-MM-DD" },
        to: { type: "string", description: "Profile-local date YYYY-MM-DD" },
        exercise: { type: "string" },
        venue: {
          type: "string",
          description:
            "Snapshot only: a planning venue supplied for this request or deliberately configured by the owner; never invent one",
        },
        view: {
          type: "string",
          enum: [...analysisViews],
          description:
            "Analysis only: default is lean; full retains all non-null domain fields",
        },
        sessionId: { type: "string" },
        measurementId: { type: "string" },
        phaseId: { type: "string" },
        date: { type: "string", description: "Profile-local date YYYY-MM-DD" },
        asOf: { type: "string", description: "Profile-local date YYYY-MM-DD" },
        q: { type: "string" },
        includeInactive: { type: "boolean" },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "fitness_write",
    description:
      "Make one allowlisted Open Fitness mutation explicitly requested by the owner. Read the exact operation's bounded write_contract before composing the request. Each write is self-contained: the connector independently performs canonical validation, operation-specific preflight, at most one mutation, idempotency, and authoritative verification. A non-mutating workout_validate returns validated; mutations return succeeded, failed, conflict, or uncertain. Stop on failed/conflict and never guess another field or endpoint. Retry only an uncertain result whose retryable field is true, at most once, with its requestId and the identical body.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "body"],
      properties: {
        operation: {
          type: "string",
          enum: Object.keys(writeOperationDescriptors),
        },
        body: {
          type: "object",
          description:
            "Canonical operation-specific body. Read fitness_read resource write_contract with the same operation immediately before composing this object; never copy response-only field names into a write.",
        },
        requestId: {
          type: "string",
          pattern: "^[A-Za-z0-9._:-]{8,200}$",
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectExtraKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported argument: ${key}`);
  }
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function repairCanonicalCorrectionNumber(value) {
  if (typeof value !== "string" || !canonicalNumberPattern.test(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function normaliseMealItem(operation, item, index) {
  if (!isObject(item)) {
    throw new Error(`${operation} items[${index}] must be an object`);
  }

  const normalised = { ...item };
  for (const alias of mealNameAliases) {
    if (!Object.prototype.hasOwnProperty.call(item, alias)) continue;
    if (
      Object.prototype.hasOwnProperty.call(normalised, "name") &&
      !Object.is(normalised.name, item[alias])
    ) {
      throw new Error(
        `${operation} items[${index}] has conflicting ${alias} and name values`,
      );
    }
    normalised.name = item[alias];
    delete normalised[alias];
  }

  const hasAmount = Object.prototype.hasOwnProperty.call(item, "amount");
  const hasQuantity = Object.prototype.hasOwnProperty.call(item, "quantity");
  if (hasAmount && hasQuantity && !Object.is(item.amount, item.quantity)) {
    throw new Error(
      `${operation} items[${index}] has conflicting amount and quantity values`,
    );
  }
  if (hasAmount && !hasQuantity) normalised.quantity = item.amount;
  if (hasAmount) delete normalised.amount;

  const nestedNutrients = isObject(item.nutrients)
    ? { ...item.nutrients }
    : null;
  let hasTopLevelNutrients = false;
  for (const field of mealNutrientFields) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) continue;
    hasTopLevelNutrients = true;
    if (
      nestedNutrients &&
      Object.prototype.hasOwnProperty.call(nestedNutrients, field) &&
      !Object.is(nestedNutrients[field], item[field])
    ) {
      throw new Error(
        `${operation} items[${index}] has conflicting ${field} values`,
      );
    }
    if (nestedNutrients) nestedNutrients[field] = item[field];
    delete normalised[field];
  }
  if (hasTopLevelNutrients) {
    normalised.nutrients = nestedNutrients ?? Object.fromEntries(
      mealNutrientFields
        .filter((field) => Object.prototype.hasOwnProperty.call(item, field))
        .map((field) => [field, item[field]]),
    );
  }

  if (operation === "meal_update") {
    delete normalised.mealItemId;
    delete normalised.dataQualityFlags;
  }

  rejectExtraKeys(normalised, mealItemFields);
  if (normalised.nutrients !== undefined) {
    if (!isObject(normalised.nutrients)) {
      throw new Error(`${operation} items[${index}].nutrients must be an object`);
    }
    rejectExtraKeys(normalised.nutrients, nutrientFields);
  }

  if (!normalised.foodId) {
    nonEmptyString(normalised.name, `${operation} items[${index}].name`);
    if (
      normalised.quantity !== null &&
      normalised.quantity !== undefined &&
      (typeof normalised.quantity !== "number" ||
        !Number.isFinite(normalised.quantity) ||
        normalised.quantity < 0 ||
        normalised.quantity > 100000)
    ) {
      throw new Error(
        `${operation} items[${index}].quantity must be a JSON number from 0 to 100000`,
      );
    }
    if (!isObject(normalised.nutrients)) {
      throw new Error(
        `${operation} items[${index}].nutrients is required for a one-off item`,
      );
    }
    const energyKcal = normalised.nutrients.energyKcal;
    if (
      typeof energyKcal !== "number" ||
      !Number.isFinite(energyKcal) ||
      energyKcal < 0 ||
      energyKcal > 50000
    ) {
      throw new Error(
        `${operation} items[${index}].nutrients.energyKcal must be a JSON number from 0 to 50000`,
      );
    }
  }

  return normalised;
}

function normaliseMealTiming(operation, body) {
  const timePrecision = body.timePrecision;
  if (timePrecision === undefined) return body;

  if (timePrecision === "minute") {
    if (typeof body.eatenAt !== "string" || !body.eatenAt.trim()) {
      throw new Error(
        `${operation} timePrecision minute requires eatenAt; use date_only when only the date is known`,
      );
    }
    return { ...body, timePrecision: "inferred" };
  }

  if (!mealTimePrecisionValues.has(timePrecision)) {
    throw new Error(
      `${operation} timePrecision must be exact, inferred, or date_only`,
    );
  }

  const hasEatenAt = Object.prototype.hasOwnProperty.call(body, "eatenAt");
  if (
    (timePrecision === "date_only" && hasEatenAt && body.eatenAt !== null) ||
    (timePrecision !== "date_only" && hasEatenAt && body.eatenAt === null) ||
    (operation === "meal_create" &&
      timePrecision !== "date_only" &&
      !hasEatenAt)
  ) {
    throw new Error(
      `${operation} timePrecision is inconsistent with eatenAt`,
    );
  }
  return body;
}

function normaliseMealBody(operation, body) {
  const canonicalBody = normaliseDeepStrings(operation, body);
  const normalised = normaliseMealTiming(operation, canonicalBody);
  if (canonicalBody.items === undefined) return normalised;
  if (!Array.isArray(canonicalBody.items)) {
    throw new Error(`${operation} items must be an array`);
  }
  return {
    ...normalised,
    items: canonicalBody.items.map((item, index) =>
      normaliseMealItem(operation, item, index),
    ),
  };
}

function normaliseSavedFoodQuantityItem(operation, item, index) {
  if (!isObject(item)) {
    throw new Error(`${operation} items[${index}] must be an object`);
  }

  const normalised = { ...item };
  const hasDefaultQuantity = Object.prototype.hasOwnProperty.call(
    item,
    "defaultQuantity",
  );
  const hasQuantity = Object.prototype.hasOwnProperty.call(item, "quantity");
  if (
    hasDefaultQuantity &&
    hasQuantity &&
    !Object.is(item.defaultQuantity, item.quantity)
  ) {
    throw new Error(
      `${operation} items[${index}] has conflicting defaultQuantity and quantity values`,
    );
  }
  if (hasDefaultQuantity && !hasQuantity) {
    normalised.quantity = item.defaultQuantity;
  }
  if (hasDefaultQuantity) delete normalised.defaultQuantity;
  if (
    operation.startsWith("plan_") &&
    Object.prototype.hasOwnProperty.call(normalised, "dataQualityFlags")
  ) {
    delete normalised.dataQualityFlags;
  }
  rejectExtraKeys(
    normalised,
    operation.startsWith("combo_") ? comboItemFields : planItemFields,
  );
  if (normalised.nutrients !== undefined) {
    if (!isObject(normalised.nutrients)) {
      throw new Error(`${operation} items[${index}].nutrients must be an object`);
    }
    rejectExtraKeys(normalised.nutrients, nutrientFields);
  }
  return normalised;
}

function normaliseSavedFoodQuantityBody(operation, body) {
  const canonicalBody = normaliseDeepStrings(operation, body);
  if (canonicalBody.items === undefined) return canonicalBody;
  if (!Array.isArray(canonicalBody.items)) {
    throw new Error(`${operation} items must be an array`);
  }
  return {
    ...canonicalBody,
    items: canonicalBody.items.map((item, index) =>
      normaliseSavedFoodQuantityItem(operation, item, index),
    ),
  };
}

function normaliseWorkoutSet(operation, set, index) {
  if (!isObject(set)) return set;

  const normalised = { ...set };
  // Keep the API contract strict. The connector only repairs two
  // unambiguous set-local aliases commonly produced by general agents.
  for (const [alias, canonical] of [
    ["notesManual", "coachNote"],
    ["setType", "setTypeManual"],
    ["setNumber", "setNoExercise"],
    ["weightKg", "weightKgReported"],
  ]) {
    const hasAlias = Object.prototype.hasOwnProperty.call(set, alias);
    if (!hasAlias) continue;
    const hasCanonical = Object.prototype.hasOwnProperty.call(set, canonical);
    if (hasCanonical && !Object.is(set[alias], set[canonical])) {
      throw new Error(
        `${operation} sets[${index}] has conflicting ${alias} and ${canonical} values`,
      );
    }
    if (!hasCanonical) normalised[canonical] = set[alias];
    delete normalised[alias];
  }
  return normalised;
}

function normaliseWorkoutBody(operation, body) {
  const canonicalBody = normaliseDeepStrings(operation, body);
  for (const [alias, canonical] of [
    ["sessionTitle", "title"],
    ["sessionType", "type"],
  ]) {
    const hasAlias = Object.prototype.hasOwnProperty.call(canonicalBody, alias);
    if (!hasAlias) continue;
    const hasCanonical = Object.prototype.hasOwnProperty.call(
      canonicalBody,
      canonical,
    );
    if (
      hasCanonical &&
      !Object.is(canonicalBody[alias], canonicalBody[canonical])
    ) {
      throw new Error(
        `${operation} has conflicting ${alias} and ${canonical} values`,
      );
    }
    if (!hasCanonical) canonicalBody[canonical] = canonicalBody[alias];
    delete canonicalBody[alias];
  }

  const hasSets = Object.prototype.hasOwnProperty.call(canonicalBody, "sets");
  const hasGrouped = Object.prototype.hasOwnProperty.call(
    canonicalBody,
    "exercises",
  );
  if (hasSets && hasGrouped) {
    throw new Error(`${operation} cannot contain both sets and exercises`);
  }
  if (hasGrouped) {
    if (!Array.isArray(canonicalBody.exercises)) {
      throw new Error(`${operation} exercises must be an array`);
    }
    const sets = canonicalBody.exercises.flatMap((rawGroup, groupIndex) => {
      if (!isObject(rawGroup)) {
        throw new Error(
          `${operation} exercises[${groupIndex}] must be an object`,
        );
      }
      rejectExtraKeys(rawGroup, new Set(["exerciseName", "sets"]));
      const exercise = nonEmptyString(
        rawGroup.exerciseName,
        `${operation}.exercises[${groupIndex}].exerciseName`,
      );
      if (!Array.isArray(rawGroup.sets)) {
        throw new Error(
          `${operation} exercises[${groupIndex}].sets must be an array`,
        );
      }
      return rawGroup.sets.map((rawSet, setIndex) => {
        if (!isObject(rawSet)) {
          throw new Error(
            `${operation} exercises[${groupIndex}].sets[${setIndex}] must be an object`,
          );
        }
        if (
          Object.prototype.hasOwnProperty.call(rawSet, "exercise") &&
          rawSet.exercise !== exercise
        ) {
          throw new Error(
            `${operation} exercises[${groupIndex}].sets[${setIndex}] has conflicting exercise`,
          );
        }
        return normaliseWorkoutSet(
          operation,
          { ...rawSet, exercise },
          setIndex,
        );
      });
    });
    const normalised = { ...canonicalBody, sets };
    delete normalised.exercises;
    return normalised;
  }
  if (!Array.isArray(canonicalBody.sets)) return canonicalBody;
  return {
    ...canonicalBody,
    sets: canonicalBody.sets.map((set, index) =>
      normaliseWorkoutSet(operation, set, index),
    ),
  };
}

function normaliseNutritionFormulaCalibration(operation, body) {
  rejectExtraKeys(
    body,
    new Set([
      "mode",
      "effectiveFrom",
      "dailyDeficitKcal",
      "activeEnergyCreditRate",
      "proteinTargetG",
      "expectedSettingsId",
    ]),
  );
  if (body.mode !== "formula") {
    throw new Error(`${operation} mode must be formula`);
  }
  nonEmptyString(body.effectiveFrom, `${operation}.effectiveFrom`);
  nonEmptyString(body.expectedSettingsId, `${operation}.expectedSettingsId`);
  if (
    !Number.isInteger(body.dailyDeficitKcal) ||
    body.dailyDeficitKcal < 0 ||
    body.dailyDeficitKcal > 2000
  ) {
    throw new Error(
      `${operation}.dailyDeficitKcal must be an integer from 0 to 2000`,
    );
  }
  if (
    typeof body.activeEnergyCreditRate !== "number" ||
    !Number.isFinite(body.activeEnergyCreditRate) ||
    body.activeEnergyCreditRate < 0 ||
    body.activeEnergyCreditRate > 1
  ) {
    throw new Error(
      `${operation}.activeEnergyCreditRate must be a JSON number from 0 to 1`,
    );
  }
  if (
    typeof body.proteinTargetG !== "number" ||
    !Number.isFinite(body.proteinTargetG) ||
    body.proteinTargetG <= 0 ||
    body.proteinTargetG > 500
  ) {
    throw new Error(
      `${operation}.proteinTargetG must be a JSON number greater than 0 and at most 500`,
    );
  }
  return body;
}

function normaliseTrainingBlockBody(operation, body) {
  if (!isObject(body)) throw new Error(`${operation} body must be an object`);
  rejectExtraKeys(
    body,
    new Set([
      "expectedUpdatedAt",
      "goalType",
      "primaryGoal",
      "trainingBlockChangeReason",
      "trainingCycleConfig",
    ]),
  );
  for (const field of [
    "expectedUpdatedAt",
    "goalType",
    "primaryGoal",
    "trainingBlockChangeReason",
  ]) {
    nonEmptyString(body[field], field);
  }
  return normaliseDeepStrings(operation, body);
}

function normaliseCorrectionBody(operation, body) {
  const normalised = normaliseDeepStrings(operation, body);
  if (
    normalised.targetScope === "workout_session" &&
    normalised.fieldName === "training_phase_id" &&
    !Object.prototype.hasOwnProperty.call(normalised, "originalValue")
  ) {
    // Models sometimes omit explicit JSON null. The API's compare-and-swap
    // check still rejects this safely if the effective phase is not null.
    normalised.originalValue = null;
  }
  if (
    normalised.targetScope === "workout_set" &&
    correctionNumericFields.has(normalised.fieldName)
  ) {
    if (Object.prototype.hasOwnProperty.call(normalised, "originalValue")) {
      normalised.originalValue = repairCanonicalCorrectionNumber(
        normalised.originalValue,
      );
    }
    if (Object.prototype.hasOwnProperty.call(normalised, "correctedValue")) {
      normalised.correctedValue = repairCanonicalCorrectionNumber(
        normalised.correctedValue,
      );
    }
  }
  return normalised;
}

function writeDescriptor(method, path, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(options, "preflight")) {
    throw new Error("Write descriptors must declare preflight explicitly");
  }
  if (
    options.preflight !== noWritePreflight &&
    typeof options.preflight !== "function"
  ) {
    throw new Error("Write descriptor preflight must be none or a function");
  }
  return Object.freeze({
    method,
    path,
    mutating: options.mutating !== false,
    normalise: options.normalise ?? normaliseIdentity,
    validate: options.validate ?? validateReceiptBody,
    preflight: options.preflight,
    route: options.route ?? null,
    receipt: options.receipt,
    readback: options.readback ?? null,
    verify: options.verify ?? verifyReceipt,
    facts: options.facts ?? null,
  });
}

function normaliseIdentity(_operation, body) {
  return body;
}

function normaliseDeepStrings(_operation, value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map((item) => normaliseDeepStrings(null, item));
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, item]) => [
      field,
      normaliseDeepStrings(null, item),
    ]),
  );
}

function normaliseTrainingTemplateBody(operation, body) {
  const normalised = normaliseDeepStrings(operation, body);
  if (
    !isObject(normalised.template) ||
    !Array.isArray(normalised.template.phases)
  ) {
    return normalised;
  }
  return {
    ...normalised,
    template: {
      ...normalised.template,
      phases: normalised.template.phases.map((phase) =>
        isObject(phase) ? { ...phase, routine: phase.routine ?? [] } : phase,
      ),
    },
  };
}

function validateReceiptBody(operation, body) {
  if (!isObject(body)) throw new Error(`${operation} body must be an object`);
}

function requiredBodyString(operation, body, field) {
  nonEmptyString(body[field], `${operation}.${field}`);
}

function requiredBodyObject(operation, body, field) {
  if (!isObject(body[field])) {
    throw new Error(`${operation}.${field} must be an object`);
  }
}

function requiredBodyArray(operation, body, field) {
  if (!Array.isArray(body[field])) {
    throw new Error(`${operation}.${field} must be an array`);
  }
}

function requiredFiniteNumber(operation, body, field) {
  if (typeof body[field] !== "number" || !Number.isFinite(body[field])) {
    throw new Error(`${operation}.${field} must be a finite JSON number`);
  }
}

function validateWorkoutCreate(operation, body) {
  validateReceiptBody(operation, body);
  for (const field of ["title", "type", "startedAt", "sessionIntent"]) {
    requiredBodyString(operation, body, field);
  }
  requiredFiniteNumber(operation, body, "durationSeconds");
  if (!Number.isInteger(body.durationSeconds) || body.durationSeconds < 0) {
    throw new Error(
      `${operation}.durationSeconds must be a non-negative integer`,
    );
  }
  if (!new Set(["normal", "deload", "test"]).has(body.sessionIntent)) {
    throw new Error(`${operation}.sessionIntent must be normal, deload, or test`);
  }
  requiredBodyArray(operation, body, "sets");
}

function validateWorkoutUpdate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "action");
  requiredBodyString(operation, body, "sessionId");
  requiredBodyString(operation, body, "reason");
  if (!new Set(["void", "restore"]).has(body.action)) {
    throw new Error(`${operation}.action must be void or restore`);
  }
}

function validateBodyMeasurementCreate(operation, body) {
  validateReceiptBody(operation, body);
  for (const field of [
    "measurementId",
    "measuredAt",
    "source",
    "sourceDevice",
  ]) {
    requiredBodyString(operation, body, field);
  }
  rejectConflictingSourceAliases(operation, body);
  requiredFiniteNumber(operation, body, "weightKg");
}

function validateBodyMeasurementEnrich(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "measurementId");
  requiredBodyString(operation, body, "expectedCreatedAt");
  requiredBodyObject(operation, body, "values");
  if (Object.keys(body.values).length === 0) {
    throw new Error(`${operation}.values must not be empty`);
  }
  rejectConflictingSourceAliases(`${operation}.values`, body.values);
}

function rejectConflictingSourceAliases(operation, value) {
  if (
    typeof value.source === "string" &&
    typeof value.sourceFile === "string" &&
    value.source.trim() !== value.sourceFile.trim()
  ) {
    throw new Error(`${operation} has conflicting source and sourceFile values`);
  }
}

function validateSessionNoteCreate(operation, body) {
  validateReceiptBody(operation, body);
  for (const field of ["noteDate", "noteType", "note"]) {
    requiredBodyString(operation, body, field);
  }
}

function validateCorrectionCreate(operation, body) {
  validateReceiptBody(operation, body);
  for (const field of [
    "targetScope",
    "targetKey",
    "fieldName",
    "effectiveDate",
    "reason",
    "source",
  ]) {
    requiredBodyString(operation, body, field);
  }
  for (const field of ["originalValue", "correctedValue"]) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      throw new Error(`${operation}.${field} is required`);
    }
  }
  if (
    !new Set([
      "workout_session",
      "workout_set",
      "operating_constraint",
    ]).has(body.targetScope) &&
    (typeof body.correctedValue !== "string" || !body.correctedValue.trim())
  ) {
    throw new Error(
      `${operation}.correctedValue must be non-empty for a generic correction`,
    );
  }
}

function validateTrainingExerciseSelect(operation, body) {
  validateReceiptBody(operation, body);
  for (const field of ["phaseId", "slotId", "exercise", "scope"]) {
    requiredBodyString(operation, body, field);
  }
  if (!new Set(["date", "venue", "template"]).has(body.scope)) {
    throw new Error(`${operation}.scope must be date, venue, or template`);
  }
  const scopedField = {
    date: "date",
    venue: "venue",
    template: "expectedUpdatedAt",
  }[body.scope];
  requiredBodyString(operation, body, scopedField);
}

function validateTrainingCourseUpdate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "scope");
  requiredBodyString(operation, body, "phaseId");
  if (
    !new Set(["date", "next_normal_occurrence", "planned_session"]).has(
      body.scope,
    )
  ) {
    throw new Error(
      `${operation}.scope must be date, next_normal_occurrence, or planned_session`,
    );
  }
  requiredBodyArray(operation, body, "items");
  if (body.items.length === 0) {
    throw new Error(`${operation}.items must not be empty`);
  }
  const slots = new Set();
  body.items.forEach((item, index) => {
    if (!isObject(item)) {
      throw new Error(`${operation}.items[${index}] must be an object`);
    }
    for (const field of [
      "slotId",
      "exercise",
      "prescription",
      "loadGuidance",
      "effort",
    ]) {
      requiredBodyString(`${operation}.items[${index}]`, item, field);
    }
    if (slots.has(item.slotId)) {
      throw new Error(`${operation}.items contains duplicate slotId ${item.slotId}`);
    }
    slots.add(item.slotId);
  });
  if (body.scope === "date") {
    requiredBodyString(operation, body, "date");
    requiredBodyString(operation, body, "expectedPlanFingerprint");
  }
  if (body.scope === "planned_session") {
    for (const field of [
      "date",
      "trainingBlockId",
      "sessionIntent",
      "expectedPlanFingerprint",
    ]) {
      requiredBodyString(operation, body, field);
    }
    if (!new Set(["deload", "test"]).has(body.sessionIntent)) {
      throw new Error(
        `${operation}.sessionIntent must be deload or test for planned_session`,
      );
    }
  }
  if (body.scope === "next_normal_occurrence") {
    requiredBodyString(operation, body, "trainingBlockId");
    requiredBodyString(operation, body, "expectedProgressionFingerprint");
  }
}

function validateTrainingTemplateUpdate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "expectedUpdatedAt");
  requiredBodyObject(operation, body, "template");
}

function validateFoodItemCreate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "displayName");
  if (body.baseQuantity !== undefined) {
    requiredFiniteNumber(operation, body, "baseQuantity");
  }
  requiredBodyString(operation, body, "baseUnit");
  requiredBodyObject(operation, body, "nutrients");
}

function validateFoodItemUpdate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "foodId");
  if (
    body.action === undefined ||
    body.action === "revise"
  ) {
    const revisionFields = [
      "displayName",
      "brand",
      "category",
      "baseQuantity",
      "baseUnit",
      "alias",
      "sourceNote",
      "nutrients",
    ];
    if (
      !revisionFields.some((field) =>
        Object.prototype.hasOwnProperty.call(body, field),
      )
    ) {
      throw new Error(`${operation} revision must include a changed field`);
    }
  } else if (!new Set(["deactivate", "reactivate"]).has(body.action)) {
    throw new Error(
      `${operation}.action must be revise, deactivate, or reactivate`,
    );
  }
}

function validateMealCreate(operation, body) {
  validateReceiptBody(operation, body);
  const hasItems = Object.prototype.hasOwnProperty.call(body, "items");
  const hasCombo = Object.prototype.hasOwnProperty.call(body, "combo");
  if (hasItems === hasCombo) {
    throw new Error(`${operation} must contain either items or combo`);
  }
  if (hasItems) {
    requiredBodyArray(operation, body, "items");
    if (body.items.length === 0) {
      throw new Error(`${operation}.items must not be empty`);
    }
    return;
  }
  requiredBodyObject(operation, body, "combo");
  requiredBodyString(`${operation}.combo`, body.combo, "comboId");
  requiredFiniteNumber(
    `${operation}.combo`,
    body.combo,
    "expectedVersionNo",
  );
  if (
    !Number.isInteger(body.combo.expectedVersionNo) ||
    body.combo.expectedVersionNo < 1
  ) {
    throw new Error(
      `${operation}.combo.expectedVersionNo must be a positive integer`,
    );
  }
}

function isFullMealReplacement(body) {
  return (
    typeof body.mealId === "string" &&
    Number.isInteger(body.expectedRevisionNo) &&
    Array.isArray(body.items) &&
    body.action === undefined &&
    body.meal === undefined
  );
}

function isTargetedMealPatch(body) {
  return ["quantity", "classification", "append_food"].includes(body.action);
}

function validateMealUpdate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "mealId");
  if (!isFullMealReplacement(body) && !isTargetedMealPatch(body)) {
    throw new Error(
      "meal_update must be a top-level full replacement with mealId, expectedRevisionNo, and items, or a targeted patch with action quantity, classification, or append_food",
    );
  }
  if (!Number.isInteger(body.expectedRevisionNo) || body.expectedRevisionNo < 1) {
    throw new Error(`${operation}.expectedRevisionNo must be a positive integer`);
  }
  if (body.action === "quantity") {
    rejectExtraKeys(
      body,
      new Set([
        "action",
        "mealId",
        "mealItemId",
        "expectedRevisionNo",
        "quantity",
        "unit",
        "revisionReason",
      ]),
    );
    requiredBodyString(operation, body, "mealItemId");
    requiredFiniteNumber(operation, body, "quantity");
    if (body.unit !== undefined) requiredBodyString(operation, body, "unit");
  }
  if (body.action === "classification") {
    rejectExtraKeys(
      body,
      new Set([
        "action",
        "mealId",
        "expectedRevisionNo",
        "mealType",
        "contextTag",
        "originalMealType",
        "revisionReason",
      ]),
    );
    requiredBodyString(operation, body, "mealType");
  }
  if (body.action === "append_food") {
    rejectExtraKeys(
      body,
      new Set([
        "action",
        "mealId",
        "expectedRevisionNo",
        "foodId",
        "quantity",
        "unit",
        "revisionReason",
      ]),
    );
    requiredBodyString(operation, body, "foodId");
    requiredFiniteNumber(operation, body, "quantity");
    if (body.unit !== undefined) requiredBodyString(operation, body, "unit");
  }
}

function mealUpdateRoute(body) {
  return isFullMealReplacement(body)
    ? ["POST", "/api/nutrition/meals"]
    : ["PATCH", "/api/nutrition/meals"];
}

function validateMealDelete(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "mealId");
  requiredFiniteNumber(operation, body, "expectedRevisionNo");
  if (!Number.isInteger(body.expectedRevisionNo) || body.expectedRevisionNo < 1) {
    throw new Error(`${operation}.expectedRevisionNo must be a positive integer`);
  }
  if (body.deleteMeal !== true) {
    requiredBodyString(operation, body, "mealItemId");
  }
}

function validateActiveEnergyCreate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "localDate");
  requiredFiniteNumber(operation, body, "activeEnergyKcal");
}

function validateNutritionTargetSet(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "effectiveFrom");
  requiredFiniteNumber(operation, body, "calorieTargetKcal");
  requiredFiniteNumber(operation, body, "proteinTargetG");
}

function validateComboCreate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "displayName");
  requiredBodyArray(operation, body, "items");
}

function validateComboUpdate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "comboId");
  const action = body.action ?? "revise";
  if (!new Set(["revise", "deactivate", "reactivate"]).has(action)) {
    throw new Error(
      `${operation}.action must be revise, deactivate, or reactivate`,
    );
  }
  if (action === "revise") {
    requiredFiniteNumber(operation, body, "expectedVersionNo");
    if (
      !Number.isInteger(body.expectedVersionNo) ||
      body.expectedVersionNo < 1
    ) {
      throw new Error(
        `${operation}.expectedVersionNo must be a positive integer`,
      );
    }
    requiredBodyArray(operation, body, "items");
  }
}

function validatePlanCreate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyArray(operation, body, "items");
}

function validatePlanUpdate(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "planId");
  requiredFiniteNumber(operation, body, "expectedVersionNo");
  if (!Number.isInteger(body.expectedVersionNo) || body.expectedVersionNo < 1) {
    throw new Error(
      `${operation}.expectedVersionNo must be a positive integer`,
    );
  }
  const action = body.action ?? "revise";
  if (!new Set(["revise", "consume", "undo_consume"]).has(action)) {
    throw new Error(
      `${operation}.action must be revise, consume, or undo_consume`,
    );
  }
  if (action === "revise") {
    const revisionFields = [
      "scheduledDate",
      "mealType",
      "contextTag",
      "originalMealType",
      "confidence",
      "originalText",
      "items",
    ];
    if (
      !revisionFields.some((field) =>
        Object.prototype.hasOwnProperty.call(body, field),
      )
    ) {
      throw new Error(`${operation} revision must include a changed field`);
    }
  }
}

function validatePlanDelete(operation, body) {
  validateReceiptBody(operation, body);
  requiredBodyString(operation, body, "planId");
  requiredFiniteNumber(operation, body, "expectedVersionNo");
  if (!Number.isInteger(body.expectedVersionNo) || body.expectedVersionNo < 1) {
    throw new Error(
      `${operation}.expectedVersionNo must be a positive integer`,
    );
  }
}

class IncompleteWriteResult extends Error {}

function responseObject(value) {
  if (!isObject(value)) {
    throw new IncompleteWriteResult("Mutation response must be a JSON object");
  }
  return value;
}

function pathValue(value, path) {
  const parts = Array.isArray(path) ? path : String(path).split(".");
  let current = value;
  for (const part of parts) {
    if (Array.isArray(current) && Number.isInteger(part)) {
      current = current[part];
      continue;
    }
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function firstPathValue(value, paths) {
  for (const path of paths) {
    const candidate = pathValue(value, path);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function requiredResponseString(value, paths, label) {
  const candidate = firstPathValue(value, paths);
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new IncompleteWriteResult(`Mutation response is missing ${label}`);
  }
  return candidate;
}

function responseReplay(value) {
  if (value.replay === undefined) return false;
  if (typeof value.replay !== "boolean") {
    throw new IncompleteWriteResult("Mutation response replay must be a boolean");
  }
  return value.replay;
}

function receiptWithId(idKey, factKeys = [], authoritativeObjectKey = null) {
  return (data) => {
    const value = responseObject(data);
    const authoritative = authoritativeObjectKey
      ? value[authoritativeObjectKey]
      : null;
    if (authoritativeObjectKey && !isObject(authoritative)) {
      throw new IncompleteWriteResult(
        `Mutation response is missing ${authoritativeObjectKey}`,
      );
    }
    const id = requiredResponseString(
      value,
      [
        [idKey],
        ...(authoritativeObjectKey
          ? [[authoritativeObjectKey, idKey]]
          : []),
      ],
      idKey,
    );
    if (
      authoritativeObjectKey &&
      authoritative[idKey] !== undefined &&
      authoritative[idKey] !== id
    ) {
      throw new IncompleteWriteResult(
        `Mutation response has conflicting ${idKey} values`,
      );
    }
    return {
      entityIds: { [idKey]: id },
      facts: Object.fromEntries(
        factKeys.flatMap((key) => {
          const fact =
            value[key] === undefined ? authoritative?.[key] : value[key];
          return fact === undefined ? [] : [[key, fact]];
        }),
      ),
      replay: responseReplay(value),
    };
  };
}

function selectResponseFacts(value, keys) {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const fact = value[key];
      return fact === undefined ? [] : [[key, fact]];
    }),
  );
}

function workoutValidationReceipt(data) {
  const value = responseObject(data);
  if (typeof value.valid !== "boolean") {
    throw new IncompleteWriteResult("Validation response is missing valid");
  }
  const conflictSessionId = firstPathValue(value, [
    ["conflictSessionId"],
    ["conflict", "sessionId"],
  ]);
  return {
    entityIds:
      typeof conflictSessionId === "string" && conflictSessionId
        ? { conflictSessionId }
        : {},
    facts: {
      valid: value.valid,
      ...(typeof conflictSessionId === "string" && conflictSessionId
        ? { conflictSessionId }
        : {}),
    },
    replay: false,
  };
}

function bodyMeasurementEnrichReceipt(data) {
  const value = responseObject(data);
  const measurementId = requiredResponseString(
    value,
    [["measurementId"], ["measurement", "measurementId"]],
    "measurementId",
  );
  return {
    entityIds: { measurementId },
    facts: {},
    replay: responseReplay(value),
  };
}

function trainingSelectionReceipt(data) {
  const value = responseObject(data);
  if (isObject(value.selection)) {
    const selectionId = requiredResponseString(
      value,
      [["selection", "selectionId"]],
      "selection.selectionId",
    );
    return {
      entityIds: { selectionId },
      facts: selectResponseFacts(value.selection, [
        "phaseId",
        "slotId",
        "scope",
        "scopeValue",
        "exercise",
      ]),
      replay: responseReplay(value),
    };
  }
  if (isObject(value.profile) && value.scope === "template") {
    const profileId = requiredResponseString(
      value,
      [["profile", "profileId"]],
      "profile.profileId",
    );
    return {
      entityIds: { profileId },
      facts: selectResponseFacts(value, ["scope", "exercise"]),
      replay: responseReplay(value),
    };
  }
  throw new IncompleteWriteResult(
    "Mutation response is missing selection or template profile",
  );
}

function trainingCourseReceipt(data, body) {
  const value = responseObject(data);
  const overrideBatchId = requiredResponseString(
    value,
    [["overrideBatchId"]],
    "overrideBatchId",
  );
  if (!Array.isArray(value.recordIds) || value.recordIds.length === 0) {
    throw new IncompleteWriteResult("Mutation response is missing recordIds");
  }
  const recordIds = value.recordIds.map((id) => {
    if (typeof id !== "string" || !id.trim()) {
      throw new IncompleteWriteResult(
        "Mutation response recordIds must contain non-empty strings",
      );
    }
    return id;
  });
  if (new Set(recordIds).size !== recordIds.length) {
    throw new IncompleteWriteResult(
      "Mutation response recordIds must be unique",
    );
  }
  if (!Array.isArray(value.records) || value.records.length !== body.items.length) {
    throw new IncompleteWriteResult(
      "Mutation response is missing authoritative course records",
    );
  }
  return {
    entityIds: { overrideBatchId, recordIds },
    facts: {
      ...selectResponseFacts(value, [
        "scope",
        "planningDate",
        "phaseId",
        "planFingerprint",
        "sessionIntent",
        "progressionFingerprint",
      ]),
      recordCount: value.records.length,
      activeRecordCount: value.records.filter(
        (record) => isObject(record) && record.active === true,
      ).length,
      recordLifecycles: value.records.map((record) => record?.lifecycle),
    },
    replay: responseReplay(value),
  };
}

function trainingBlockReceipt(data) {
  const value = responseObject(data);
  const profileId = requiredResponseString(
    value,
    [["profile", "profileId"]],
    "profile.profileId",
  );
  const blockId = requiredResponseString(
    value,
    [["profile", "currentTrainingBlock", "blockId"]],
    "profile.currentTrainingBlock.blockId",
  );
  return {
    entityIds: { profileId, blockId },
    facts: {
      updatedAt: pathValue(value, ["profile", "updatedAt"]),
    },
    replay: responseReplay(value),
  };
}

function trainingTemplateReceipt(data) {
  const value = responseObject(data);
  const profileUpdatedAt = requiredResponseString(
    value,
    [["profileUpdatedAt"]],
    "profileUpdatedAt",
  );
  if (!isObject(value.template)) {
    throw new IncompleteWriteResult("Mutation response is missing template");
  }
  return {
    entityIds: {},
    facts: { profileUpdatedAt },
    replay: responseReplay(value),
  };
}

function nutritionTargetReceipt(data) {
  const value = responseObject(data);
  if (!isObject(value.target)) {
    throw new IncompleteWriteResult("Mutation response is missing target");
  }
  const settingsId = requiredResponseString(
    value,
    [["target", "settingsId"]],
    "target.settingsId",
  );
  return {
    entityIds: { settingsId },
    facts: selectResponseFacts(value.target, [
      "effectiveFrom",
      "mode",
      "calorieTargetKcal",
      "dailyDeficitKcal",
      "activeEnergyCreditRate",
      "proteinTargetG",
    ]),
    replay: responseReplay(value),
  };
}

function nutritionPlanReceipt(data, body) {
  const value = responseObject(data);
  const planId = requiredResponseString(value, [["planId"]], "planId");
  const planIds = Array.isArray(value.planIds)
    ? value.planIds.map((id) => {
        if (typeof id !== "string" || !id.trim()) {
          throw new IncompleteWriteResult(
            "Mutation response planIds must contain non-empty strings",
          );
        }
        return id;
      })
    : [planId];
  if (!isObject(value.plan)) {
    throw new IncompleteWriteResult("Mutation response is missing plan");
  }
  if (
    value.plan.planId !== planId ||
    new Set(planIds).size !== planIds.length ||
    !planIds.includes(planId)
  ) {
    throw new IncompleteWriteResult(
      "Mutation response contains conflicting plan IDs",
    );
  }
  const expectedCount = Array.isArray(body.scheduledDates)
    ? body.scheduledDates.length
    : 1;
  if (planIds.length !== expectedCount) {
    throw new IncompleteWriteResult(
      "Mutation response plan count does not match the request",
    );
  }
  const replay = responseReplay(value);
  if (!Array.isArray(value.plans)) {
    throw new IncompleteWriteResult(
      "Mutation response is missing authoritative plans",
    );
  }
  const hydratedIds = new Set(
    value.plans
      .filter(isObject)
      .map((plan) => plan.planId)
      .filter((id) => typeof id === "string" && id),
  );
  if (planIds.some((id) => !hydratedIds.has(id))) {
    throw new IncompleteWriteResult(
      "Mutation response is missing a created plan",
    );
  }
  const versionNo = value.versionNo ?? value.plan.versionNo;
  return {
    entityIds: { planId, planIds },
    facts: versionNo === undefined ? {} : { versionNo },
    replay,
  };
}

function nutritionPlanDeleteReceipt(data) {
  const value = responseObject(data);
  if (!isObject(value.plan)) {
    throw new IncompleteWriteResult(
      "Mutation response is missing cancelled plan",
    );
  }
  const planId = requiredResponseString(value, [["planId"]], "planId");
  if (value.plan.planId !== planId || value.plan.status !== "cancelled") {
    throw new IncompleteWriteResult(
      "Mutation response does not contain the cancelled plan",
    );
  }
  if (!Number.isInteger(value.plan.versionNo)) {
    throw new IncompleteWriteResult(
      "Mutation response cancelled plan is missing versionNo",
    );
  }
  return {
    entityIds: { planId },
    facts: {
      versionNo: value.plan.versionNo,
      status: value.plan.status,
    },
    replay: responseReplay(value),
  };
}

function verifyReceipt({ body, receipt }) {
  return Object.entries(receipt.entityIds).every(
    ([field, value]) =>
      !Object.prototype.hasOwnProperty.call(body, field) ||
      JSON.stringify(body[field]) === JSON.stringify(value),
  );
}

function verifyTrainingTemplate({ body, mutationData }) {
  return JSON.stringify(mutationData.template) === JSON.stringify(body.template);
}

function verifyTrainingSelection({ body, mutationData }) {
  if (isObject(mutationData.selection)) {
    const selection = mutationData.selection;
    if (
      selection.phaseId !== body.phaseId ||
      selection.slotId !== body.slotId ||
      selection.exercise !== body.exercise
    ) {
      return false;
    }
    if (body.scope !== undefined && selection.scope !== body.scope) return false;
    if (body.scope === "date" && selection.scopeValue !== body.date) return false;
    if (body.scope === "venue" && selection.scopeValue !== body.venue) {
      return false;
    }
    return true;
  }
  if (
    body.scope !== "template" ||
    mutationData.scope !== "template" ||
    mutationData.exercise !== body.exercise ||
    !isObject(mutationData.profile)
  ) {
    return false;
  }
  const phases = mutationData.profile.trainingCycleConfig?.phases;
  const slot = Array.isArray(phases)
    ? phases
        .find((phase) => isObject(phase) && phase.id === body.phaseId)
        ?.routine?.find(
          (candidate) => isObject(candidate) && candidate.id === body.slotId,
        )
    : null;
  return isObject(slot) && slot.preferredExercise === body.exercise;
}

function courseRecordId(record) {
  return firstPathValue(record, [["selectionId"], ["overrideId"], ["recordId"]]);
}

function courseRecordField(record, field) {
  const aliases = {
    prescription: ["prescription", "prescriptionOverride"],
    loadGuidance: ["loadGuidance", "loadGuidanceOverride"],
    effort: ["effort", "effortOverride"],
  };
  return firstPathValue(
    record,
    (aliases[field] ?? [field]).map((candidate) => [candidate]),
  );
}

function verifyTrainingCourse({ body, receipt, mutationData }) {
  if (!Array.isArray(mutationData.records)) return false;
  const expectedIds = new Set(receipt.entityIds.recordIds);
  const actualIds = mutationData.records.map(courseRecordId);
  if (
    mutationData.records.length !== body.items.length ||
    new Set(actualIds).size !== mutationData.records.length ||
    expectedIds.size !== mutationData.records.length ||
    mutationData.records.some(
      (record) => !isObject(record) || !expectedIds.has(courseRecordId(record)),
    )
  ) {
    return false;
  }
  const scope = body.scope;
  if (
    mutationData.scope !== scope ||
    (mutationData.phaseId !== undefined && mutationData.phaseId !== body.phaseId)
  ) {
    return false;
  }
  return body.items.every((expected) => {
    const actual = mutationData.records.find(
      (record) => isObject(record) && record.slotId === expected.slotId,
    );
    if (!actual || actual.overrideBatchId !== receipt.entityIds.overrideBatchId) {
      return false;
    }
    if (
      actual.scope !== scope ||
      !new Set(["active", "consumed", "voided", "superseded"]).has(
        actual.lifecycle,
      ) ||
      actual.active !== (actual.lifecycle === "active")
    ) {
      return false;
    }
    for (const field of [
      "phaseId",
      "exercise",
      "prescription",
      "loadGuidance",
      "effort",
    ]) {
      const expectedValue = field === "phaseId" ? body.phaseId : expected[field];
      if (!sameExpectedValue(courseRecordField(actual, field), expectedValue)) {
        return false;
      }
    }
    if (
      scope === "next_normal_occurrence" &&
      (actual.trainingBlockId !== body.trainingBlockId ||
        actual.sourceSessionId !== (body.sourceSessionId ?? null))
    ) {
      return false;
    }
    if (
      (scope === "date" || scope === "planned_session") &&
      actual.date !== body.date
    ) {
      return false;
    }
    if (
      scope === "planned_session" &&
      (actual.trainingBlockId !== body.trainingBlockId ||
        actual.sessionIntent !== body.sessionIntent)
    ) {
      return false;
    }
    return true;
  });
}

function verifyTrainingBlock({ body, mutationData }) {
  const profile = mutationData.profile;
  const block = profile?.currentTrainingBlock;
  return Boolean(
    isObject(profile) &&
      isObject(block) &&
      profile.goalType === body.goalType &&
      profile.primaryGoal === body.primaryGoal &&
      block.goalType === body.goalType &&
      block.primaryGoal === body.primaryGoal &&
      block.changeReason === body.trainingBlockChangeReason &&
      (body.trainingCycleConfig === undefined ||
        JSON.stringify(profile.trainingCycleConfig) ===
          JSON.stringify(body.trainingCycleConfig)) &&
      typeof profile.updatedAt === "string" &&
      profile.updatedAt !== body.expectedUpdatedAt,
  );
}

function normalisedOptionalText(value) {
  return typeof value === "string" ? value.trim() || null : value ?? null;
}

function normalisedFoodName(value) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-HK")
    .replace(/[\s\u3000]+/g, " ");
}

function verifyFoodItem({ body, receipt, mutationData }) {
  const item = mutationData.item;
  if (
    !verifyReceipt({ body, receipt }) ||
    !isObject(item) ||
    item.foodId !== mutationData.foodId
  ) {
    return false;
  }
  for (const required of [
    "category",
    "aliases",
    "originalLabel",
    "source",
    "sourceNote",
    "effectiveFrom",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(item, required)) return false;
  }
  if (
    !Array.isArray(item.aliases) ||
    typeof item.source !== "string" ||
    !item.source ||
    typeof item.effectiveFrom !== "string" ||
    !item.effectiveFrom ||
    typeof item.foodVersionId !== "string" ||
    !Number.isInteger(item.versionNo)
  ) {
    return false;
  }
  if (body.action === "deactivate") return item.isActive === false;
  if (body.action === "reactivate") return item.isActive === true;
  const textFields = ["displayName", "brand", "category", "sourceNote"];
  for (const field of textFields) {
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      item[field] !== normalisedOptionalText(body[field])
    ) {
      return false;
    }
  }
  if (
    body.baseUnit !== undefined &&
    item.defaultUnit !== body.baseUnit.trim()
  ) {
    return false;
  }
  if (
    body.baseQuantity !== undefined &&
    !sameExpectedValue(item.baseQuantity, body.baseQuantity)
  ) {
    return false;
  }
  if (body.alias !== undefined) {
    const alias = normalisedOptionalText(body.alias);
    const aliasStored =
      typeof alias === "string" &&
      item.aliases.some(
        (storedAlias) =>
          typeof storedAlias === "string" &&
          normalisedFoodName(storedAlias) === normalisedFoodName(alias),
      );
    if (
      alias !== null &&
      (!aliasStored ||
        (body.foodId === undefined && item.originalLabel !== alias))
    ) {
      return false;
    }
  }
  if (isObject(body.nutrients)) {
    if (!isObject(item.nutrients)) return false;
    for (const [field, expected] of Object.entries(body.nutrients)) {
      if (!sameExpectedValue(item.nutrients[field], expected)) return false;
    }
  }
  return true;
}

function verifyNutritionTarget({ body, mutationData }) {
  const target = mutationData.target;
  if (!isObject(target)) return false;
  const expectedMode = body.mode ?? "fixed";
  if (target.mode !== expectedMode) return false;
  for (const field of [
    "effectiveFrom",
    "calorieTargetKcal",
    "dailyDeficitKcal",
    "activeEnergyCreditRate",
    "proteinTargetG",
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      !sameExpectedValue(target[field], body[field])
    ) {
      return false;
    }
  }
  return true;
}

function verifyRequestedItems(expectedItems, actualItems, quantityField) {
  if (!Array.isArray(expectedItems)) return true;
  if (!Array.isArray(actualItems) || actualItems.length !== expectedItems.length) {
    return false;
  }
  return expectedItems.every((expected, index) => {
    const actual = actualItems[index];
    if (!isObject(expected) || !isObject(actual)) return false;
    for (const field of ["foodId", "name", "unit", "assumption", "confidence"]) {
      if (
        Object.prototype.hasOwnProperty.call(expected, field) &&
        !sameExpectedValue(actual[field], expected[field])
      ) {
        return false;
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(expected, "quantity") &&
      !sameExpectedValue(actual[quantityField], expected.quantity)
    ) {
      return false;
    }
    if (isObject(expected.nutrients)) {
      if (!isObject(actual.nutrients)) return false;
      for (const [field, value] of Object.entries(expected.nutrients)) {
        if (!sameExpectedValue(actual.nutrients[field], value)) return false;
      }
    }
    return true;
  });
}

function nutritionMutationMeal(mutationData, mealId) {
  if (!isObject(mutationData.nutrition)) return null;
  const meals = mutationData.nutrition.meals;
  if (!Array.isArray(meals)) return null;
  return meals.find(
    (meal) => isObject(meal) && meal.mealId === mealId,
  ) ?? null;
}

function verifyMealFields(body, meal) {
  for (const field of [
    "localDate",
    "eatenAt",
    "timePrecision",
    "mealType",
    "contextTag",
    "originalMealType",
    "source",
    "confidence",
    "originalText",
    "notes",
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      !sameExpectedValue(meal[field], body[field])
    ) {
      return false;
    }
  }
  return verifyRequestedItems(body.items, meal.items, "quantity");
}

function mealItemOrdinal(mealItemId) {
  const match =
    typeof mealItemId === "string"
      ? /\|ITEM\|(\d+)$/.exec(mealItemId)
      : null;
  return match?.[1] ?? null;
}

function verifyNutritionMeal({ body, operation, receipt, mutationData }) {
  if (!verifyReceipt({ body, receipt }) || !isObject(mutationData.nutrition)) {
    return false;
  }
  const mealId = receipt.entityIds.mealId;
  const responseRevisionNo = mutationData.revisionNo;
  if (!Number.isInteger(responseRevisionNo)) return false;
  const meal = nutritionMutationMeal(mutationData, mealId);

  if (operation === "meal_delete") {
    const deletedWholeMeal = body.deleteMeal === true;
    if (deletedWholeMeal || mutationData.deletedMeal === true) {
      return Boolean(
        meal === null && responseRevisionNo === body.expectedRevisionNo + 1,
      );
    }
    return Boolean(
      mutationData.deletedMeal === false &&
        isObject(meal) &&
        meal.revisionNo === responseRevisionNo &&
        responseRevisionNo === body.expectedRevisionNo + 1,
    );
  }

  if (
    !isObject(meal) ||
    meal.revisionNo !== responseRevisionNo ||
    !Array.isArray(meal.items) ||
    !verifyMealFields(body, meal)
  ) {
    return false;
  }

  if (operation === "meal_create" || isFullMealReplacement(body)) {
    const expectedRevisionNo = Number.isInteger(body.expectedRevisionNo)
      ? body.expectedRevisionNo + 1
      : 1;
    if (responseRevisionNo !== expectedRevisionNo) return false;
    if (isObject(body.combo)) {
      return (
        mutationData.comboId === body.combo.comboId &&
        mutationData.comboVersionNo === body.combo.expectedVersionNo &&
        Array.isArray(meal.items) &&
        meal.items.length > 0
      );
    }
    return true;
  }

  if (
    responseRevisionNo !== body.expectedRevisionNo &&
    responseRevisionNo !== body.expectedRevisionNo + 1
  ) {
    return false;
  }
  if (body.action === "classification") return true;
  if (body.action === "append_food") {
    return meal.items.some(
      (item) =>
        isObject(item) &&
        item.foodId === body.foodId &&
        sameExpectedValue(item.quantity, body.quantity) &&
        (!Object.prototype.hasOwnProperty.call(body, "unit") ||
          sameExpectedValue(item.unit, body.unit)),
    );
  }
  if (body.action === "quantity") {
    const ordinal = mealItemOrdinal(body.mealItemId);
    return Boolean(
      ordinal &&
        meal.items.some(
          (item) =>
            isObject(item) &&
            mealItemOrdinal(item.mealItemId) === ordinal &&
            sameExpectedValue(item.quantity, body.quantity) &&
            (!Object.prototype.hasOwnProperty.call(body, "unit") ||
              sameExpectedValue(item.unit, body.unit)),
        ),
    );
  }
  return false;
}

function verifyNutritionCombo({ body, receipt, mutationData }) {
  const combo = mutationData.combo;
  if (
    !verifyReceipt({ body, receipt }) ||
    !isObject(combo) ||
    combo.comboId !== receipt.entityIds.comboId ||
    !Number.isInteger(combo.versionNo)
  ) {
    return false;
  }
  const action = body.action ?? "revise";
  if (action === "deactivate") return combo.isActive === false;
  if (action === "reactivate") return combo.isActive === true;
  if (
    Number.isInteger(body.expectedVersionNo) &&
    combo.versionNo !== body.expectedVersionNo + 1
  ) {
    return false;
  }
  for (const field of ["displayName", "defaultMealType", "contextTag"]) {
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      !sameExpectedValue(combo[field], body[field])
    ) {
      return false;
    }
  }
  return (
    (body.comboId !== undefined || combo.isActive === true) &&
    verifyRequestedItems(body.items, combo.items, "defaultQuantity")
  );
}

function verifyPlanFields(body, plan) {
  for (const field of [
    "scheduledDate",
    "mealType",
    "contextTag",
    "originalMealType",
    "confidence",
    "originalText",
    "source",
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      !sameExpectedValue(plan[field], body[field])
    ) {
      return false;
    }
  }
  return verifyRequestedItems(body.items, plan.items, "quantity");
}

function verifyNutritionPlan({ body, receipt, mutationData }) {
  const plan = mutationData.plan;
  if (
    !verifyReceipt({ body, receipt }) ||
    !isObject(plan) ||
    plan.planId !== receipt.entityIds.planId ||
    !Number.isInteger(plan.versionNo)
  ) {
    return false;
  }
  if (Number.isInteger(body.expectedVersionNo)) {
    if (plan.versionNo !== body.expectedVersionNo + 1) return false;
    const action = body.action ?? "revise";
    if (action === "consume") {
      return (
        plan.status === "consumed" &&
        typeof plan.completedMealId === "string" &&
        plan.completedMealId === mutationData.mealId
      );
    }
    if (action === "undo_consume") {
      return plan.status === "pending" && plan.completedMealId === null;
    }
    return plan.status === "pending" && verifyPlanFields(body, plan);
  }
  if (plan.status !== "pending" || plan.versionNo !== 1) return false;
  const planIds = new Set(receipt.entityIds.planIds ?? [receipt.entityIds.planId]);
  const plans = mutationData.plans.filter(
    (candidate) => isObject(candidate) && planIds.has(candidate.planId),
  );
  if (plans.length !== planIds.size) return false;
  if (Array.isArray(body.scheduledDates)) {
    const returnedDates = new Set(plans.map((candidate) => candidate.scheduledDate));
    if (body.scheduledDates.some((date) => !returnedDates.has(date))) return false;
  }
  return plans.every(
    (candidate) =>
      candidate.status === "pending" &&
      candidate.versionNo === 1 &&
      verifyPlanFields(body, candidate),
  );
}

function verifyNutritionPlanDelete({ body, receipt, mutationData }) {
  return (
    receipt.entityIds.planId === body.planId &&
    mutationData.planId === body.planId &&
    mutationData.plan.planId === receipt.entityIds.planId &&
    mutationData.plan.status === "cancelled" &&
    Number.isInteger(mutationData.plan.versionNo) &&
    (!Number.isInteger(body.expectedVersionNo) ||
      mutationData.plan.versionNo === body.expectedVersionNo + 1)
  );
}

function exactAnalysisReadbackRequest(localDate) {
  const date = encodeURIComponent(localDate);
  return {
    method: "GET",
    path: `/api/fitness/analysis?from=${date}&to=${date}&view=full`,
  };
}

function correctionReadbackRequest({ body }) {
  return exactAnalysisReadbackRequest(body.effectiveDate);
}

function sessionNoteReadbackRequest({ body }) {
  return exactAnalysisReadbackRequest(body.noteDate);
}

function activeEnergyReadbackRequest({ body }) {
  return exactAnalysisReadbackRequest(body.localDate);
}

function sameNormalisedText(actual, expected) {
  const normalised =
    typeof expected === "string" ? expected.trim() || null : expected ?? null;
  return actual === normalised;
}

function analysisReadback(data) {
  return readbackContainers(data).find(
    (container) =>
      Array.isArray(container.sessionNotes) || isObject(container.nutrition),
  );
}

function correctionValueMatches(actual, expected) {
  if (expected === null) return actual === null;
  return typeof actual === "string" && actual === String(expected);
}

function verifyCorrectionCreate({ body, receipt, readbackData }) {
  const correction = analysisReadback(readbackData)?.corrections?.find(
    (candidate) =>
      isObject(candidate) &&
      candidate.correctionId === receipt.entityIds.correctionId,
  );
  if (!correction) return false;
  for (const field of [
    "targetScope",
    "targetKey",
    "fieldName",
    "effectiveDate",
    "reason",
    "source",
  ]) {
    if (correction[field] !== body[field]) return false;
  }
  if (
    !correctionValueMatches(correction.originalValue, body.originalValue) ||
    !correctionValueMatches(correction.correctedValue, body.correctedValue)
  ) {
    return false;
  }
  if (
    body.recordedAt !== undefined &&
    Date.parse(correction.recordedAt) !== Date.parse(body.recordedAt)
  ) {
    return false;
  }
  return (
    (body.correctionId === undefined ||
      body.correctionId === receipt.entityIds.correctionId) &&
    typeof correction.recordedAt === "string" &&
    Number.isFinite(Date.parse(correction.recordedAt))
  );
}

function verifySessionNoteCreate({ body, receipt, readbackData }) {
  const note = analysisReadback(readbackData)?.sessionNotes?.find(
    (candidate) =>
      isObject(candidate) &&
      candidate.noteId === receipt.entityIds.noteId,
  );
  if (!note) return false;
  for (const field of ["noteDate", "noteType", "note"]) {
    if (!sameNormalisedText(note[field], body[field])) return false;
  }
  for (const field of [
    "sessionId",
    "venue",
    "exerciseOrArea",
    "source",
  ]) {
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      !sameNormalisedText(note[field], body[field])
    ) {
      return false;
    }
  }
  return (
    (body.noteId === undefined || body.noteId === receipt.entityIds.noteId) &&
    (body.pain010 === undefined || sameExpectedValue(note.pain010, body.pain010))
  );
}

function verifyActiveEnergyCreate({ body, receipt, readbackData }) {
  const analysis = analysisReadback(readbackData);
  const observation = analysis?.nutrition?.energyObservations?.find(
    (candidate) =>
      isObject(candidate) &&
      candidate.energyObservationId === receipt.entityIds.energyObservationId,
  );
  if (!observation) return false;
  if (
    observation.localDate !== body.localDate ||
    !sameExpectedValue(observation.activeEnergyKcal, body.activeEnergyKcal)
  ) {
    return false;
  }
  for (const field of ["observedAt", "status", "source", "note"]) {
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      !sameNormalisedText(observation[field], body[field])
    ) {
      return false;
    }
  }
  return (
    (body.energyObservationId === undefined ||
      body.energyObservationId === receipt.entityIds.energyObservationId) &&
    (body.basalEnergyKcal === undefined ||
      sameExpectedValue(observation.basalEnergyKcal, body.basalEnergyKcal))
  );
}

function workoutReadbackRequest({ receipt }) {
  return {
    method: "GET",
    path: `/api/fitness/workout-sessions?sessionId=${encodeURIComponent(
      receipt.entityIds.sessionId,
    )}`,
  };
}

function bodyMeasurementReadbackRequest({ receipt }) {
  return {
    method: "GET",
    path: `/api/fitness/body-measurements?measurementId=${encodeURIComponent(
      receipt.entityIds.measurementId,
    )}`,
  };
}

function readbackContainers(data) {
  const containers = [data];
  if (isObject(data?.data)) containers.push(data.data);
  return containers.filter(isObject);
}

function workoutReadback(data) {
  for (const container of readbackContainers(data)) {
    const session = [
      container.session,
      container.workoutSession,
      Array.isArray(container.workoutSessions)
        ? container.workoutSessions[0]
        : null,
    ].find(isObject);
    if (!session) continue;
    const sets = [
      container.sets,
      container.workoutSets,
      session.sets,
    ].find(Array.isArray) ?? [];
    return { session, sets };
  }
  return null;
}

function workoutField(session, canonical) {
  const aliases = {
    title: ["title", "sessionTitle"],
    type: ["type", "sessionType"],
  };
  return firstPathValue(
    session,
    (aliases[canonical] ?? [canonical]).map((field) => [field]),
  );
}

function workoutSetField(set, canonical) {
  const aliases = {
    coachNote: ["coachNote", "notesManual"],
    setTypeManual: ["setTypeManual", "setType"],
    setNoExercise: ["setNoExercise", "setNumber"],
    weightKgReported: ["weightKgReported", "weightKg"],
  };
  return firstPathValue(
    set,
    (aliases[canonical] ?? [canonical]).map((field) => [field]),
  );
}

function sameExpectedValue(actual, expected) {
  if (typeof actual === "number" && typeof expected === "number") {
    return Math.abs(actual - expected) < 0.000001;
  }
  return Object.is(actual, expected);
}

function verifyWorkoutCreate({ body, receipt, readbackData }) {
  const readback = workoutReadback(readbackData);
  if (!verifyReceipt({ body, receipt }) || !readback) return false;
  if (readback.session.sessionId !== receipt.entityIds.sessionId) return false;
  for (const field of [
    "title",
    "type",
    "startedAt",
    "endedAt",
    "sessionIntent",
    "trainingPhaseId",
    "trainingBlockId",
    "timePrecision",
    "durationSeconds",
    "localDate",
    "venue",
    "notesManual",
    "totalSetsReported",
  ]) {
    const actual = workoutField(readback.session, field);
    const matches =
      field === "startedAt" || field === "endedAt"
        ? Number.isFinite(Date.parse(actual)) &&
          Date.parse(actual) === Date.parse(body[field])
        : sameExpectedValue(actual, body[field]);
    if (
      Object.prototype.hasOwnProperty.call(body, field) &&
      !matches
    ) {
      return false;
    }
  }
  if (!Array.isArray(body.sets) || readback.sets.length !== body.sets.length) {
    return false;
  }
  const checkedSetFields = [
    "exercise",
    "reps",
    "weightKgReported",
    "setNoExercise",
    "setNoSession",
    "effortRaw",
    "coachNote",
    "setTypeManual",
  ];
  return body.sets.every((expected, index) => {
    const actual = readback.sets[index];
    if (!isObject(expected) || !isObject(actual)) return false;
    return checkedSetFields.every(
      (field) =>
        !Object.prototype.hasOwnProperty.call(expected, field) ||
        sameExpectedValue(workoutSetField(actual, field), expected[field]),
    );
  });
}

function verifyWorkoutUpdate({ body, receipt, readbackData }) {
  const readback = workoutReadback(readbackData);
  if (
    !verifyReceipt({ body, receipt }) ||
    !readback ||
    readback.session.sessionId !== receipt.entityIds.sessionId
  ) {
    return false;
  }
  return body.action === "void"
    ? typeof readback.session.voidedAt === "string" &&
        Boolean(readback.session.voidedAt) &&
        readback.session.voidReason === body.reason
    : readback.session.voidedAt === null;
}

function bodyMeasurementReadback(data) {
  for (const container of readbackContainers(data)) {
    const measurement = [
      container.measurement,
      container.bodyMeasurement,
      Array.isArray(container.bodyMeasurements)
        ? container.bodyMeasurements[0]
        : null,
    ].find(isObject);
    if (measurement) return measurement;
  }
  return null;
}

function bodyMeasurementField(measurement, field) {
  if (field === "source" || field === "sourceFile") {
    return firstPathValue(measurement, [["source"], ["sourceFile"]]);
  }
  return measurement[field];
}

function bodyMeasurementFacts({ readbackData }) {
  const measurement = bodyMeasurementReadback(readbackData);
  const trend = readbackContainers(readbackData)
    .map((container) => container.trend)
    .find(isObject);
  if (!measurement) return {};
  return {
    measurement: selectResponseFacts(measurement, [
      "measuredAt",
      "localDate",
      "sourceDevice",
      "weightKg",
      "bmi",
      "bodyFatPct",
      "muscleMassKg",
      "bodyWaterPct",
      "visceralFatRating",
    ]),
    ...(trend ? { comparison: trend } : {}),
  };
}

function verifyBodyMeasurementCreate({ body, receipt, readbackData }) {
  const measurement = bodyMeasurementReadback(readbackData);
  if (
    !verifyReceipt({ body, receipt }) ||
    !measurement ||
    measurement.measurementId !== receipt.entityIds.measurementId
  ) {
    return false;
  }
  return Object.entries(body).every(([field, expected]) => {
    if (field === "measurementId" || expected === undefined) return true;
    if (typeof expected === "string") {
      return sameNormalisedText(
        bodyMeasurementField(measurement, field),
        expected,
      );
    }
    return sameExpectedValue(bodyMeasurementField(measurement, field), expected);
  });
}

function verifyBodyMeasurementEnrich({ body, receipt, readbackData }) {
  const measurement = bodyMeasurementReadback(readbackData);
  if (
    !verifyReceipt({ body, receipt }) ||
    !measurement ||
    measurement.measurementId !== receipt.entityIds.measurementId ||
    measurement.createdAt !== body.expectedCreatedAt
  ) {
    return false;
  }
  return Object.entries(body.values).every(([field, expected]) =>
    typeof expected === "string"
      ? sameNormalisedText(bodyMeasurementField(measurement, field), expected)
      : sameExpectedValue(bodyMeasurementField(measurement, field), expected),
  );
}

function readRequest(args) {
  if (!isObject(args)) throw new Error("fitness_read arguments must be an object");
  const resource = nonEmptyString(args.resource, "resource");
  const config = readResources[resource];
  if (!config) throw new Error("Unknown fitness read resource");
  rejectExtraKeys(
    args,
    new Set([
      "resource",
      ...config.query,
      ...(resource === "analysis" ? ["view"] : []),
    ]),
  );

  const view = resource === "analysis" ? (args.view ?? "default") : null;
  if (view !== null && !analysisViews.has(view)) {
    throw new Error("view must be default or full");
  }

  const search = new URLSearchParams();
  for (const name of config.query) {
    const value = args[name];
    if (value === undefined) continue;
    if (name === "includeInactive") {
      if (typeof value !== "boolean") {
        throw new Error("includeInactive must be a boolean");
      }
      search.set(name, String(value));
      continue;
    }
    search.set(name, nonEmptyString(value, name));
  }
  if (resource === "analysis") search.set("view", view);
  for (const name of config.required ?? []) {
    if (!search.has(name)) throw new Error(`${name} is required for ${resource}`);
  }
  const params = Object.fromEntries(search.entries());
  if (
    resource === "write_contract" &&
    !Object.prototype.hasOwnProperty.call(writeOperationDescriptors, params.operation)
  ) {
    throw new Error("Unknown fitness write operation");
  }
  const query = search.toString();
  return {
    label: resource,
    local: Boolean(config.local),
    method: "GET",
    path: config.path ? `${config.path}${query ? `?${query}` : ""}` : null,
    requestId: null,
    body: null,
    view,
    params,
  };
}

function readFailureFacts(args, error) {
  const resource = isObject(args) && typeof args.resource === "string"
    ? args.resource
    : null;
  const config = resource ? readResources[resource] : null;
  const allowedArguments = config
    ? [
        "resource",
        ...config.query,
        ...(resource === "analysis" ? ["view"] : []),
      ]
    : ["resource"];
  return {
    reason: error instanceof Error ? error.message : "Invalid tool call",
    allowedArguments,
  };
}

function shapeAnalysis(value, view) {
  if (Array.isArray(value)) {
    return value.map((item) => shapeAnalysis(item, view));
  }
  if (!isObject(value)) return value;

  const shaped = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          item !== null &&
          (view === "full" || !defaultAnalysisOmissions.has(key)),
      )
      .map(([key, item]) => [key, shapeAnalysis(item, view)]),
  );
  if (view !== "full" && Array.isArray(shaped.corrections)) {
    shaped.corrections = shaped.corrections.filter(
      (correction) => correction.targetScope !== "operating_constraint",
    );
  }
  if (view === "full" || !Array.isArray(shaped.exerciseAliases)) return shaped;

  const exercises = new Set([
    ...(Array.isArray(shaped.workoutSets)
      ? shaped.workoutSets.map((set) => set.exercise)
      : []),
    shaped.range?.exercise,
  ]);
  shaped.exerciseAliases = shaped.exerciseAliases.filter(
    (alias) =>
      exercises.has(alias.sourceExerciseName) ||
      exercises.has(alias.canonicalName),
  );
  return shaped;
}

class WritePreparationError extends Error {
  constructor(message, operation = null, requestId = null) {
    super(message);
    this.operation = operation;
    this.requestId = requestId;
  }
}

function writeRequest(args) {
  if (!isObject(args)) {
    throw new WritePreparationError(
      "fitness_write arguments must be an object",
    );
  }
  let operation = null;
  let requestId = null;
  try {
    rejectExtraKeys(args, new Set(["operation", "body", "requestId"]));
    operation = nonEmptyString(args.operation, "operation");
    requestId = args.requestId ?? `fitness-${randomUUID()}`;
    if (typeof requestId !== "string" || !requestKeyPattern.test(requestId)) {
      requestId = null;
      throw new Error("Invalid requestId");
    }
    const descriptor = writeOperationDescriptors[operation];
    if (!descriptor) throw new Error("Unknown fitness write operation");
    if (!isObject(args.body)) throw new Error("body must be an object");
    const body = descriptor.normalise(operation, args.body);
    descriptor.validate(operation, body);
    if (Buffer.byteLength(JSON.stringify(body)) > maxBodyBytes) {
      throw new Error("body is too large");
    }
    const route = descriptor.route
      ? descriptor.route(body)
      : [descriptor.method, descriptor.path];
    if (
      !Array.isArray(route) ||
      typeof route[0] !== "string" ||
      typeof route[1] !== "string"
    ) {
      throw new Error("Invalid write operation route");
    }
    return {
      kind: "write",
      label: operation,
      operation,
      method: route[0],
      path: route[1],
      requestId,
      body,
      descriptor,
    };
  } catch (error) {
    throw new WritePreparationError(
      error instanceof Error ? error.message : "Invalid fitness write",
      operation,
      requestId,
    );
  }
}

function boundedFactValue(value, depth = 0) {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 512);
  if (depth >= maxFactDepth) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, maxFactEntries)
      .map((item) => boundedFactValue(item, depth + 1));
  }
  if (!isObject(value)) return String(value).slice(0, 512);
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxFactEntries)
      .map(([key, item]) => [key, boundedFactValue(item, depth + 1)]),
  );
}

function boundedFacts(value) {
  const facts = isObject(value) ? boundedFactValue(value) : {};
  if (Buffer.byteLength(JSON.stringify(facts)) <= maxFactsBytes) return facts;
  return { truncated: true };
}

function boundedEntityIds(value) {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (typeof item === "string" && item) {
        return [[key, item.slice(0, 512)]];
      }
      if (Array.isArray(item)) {
        const ids = item
          .filter((id) => typeof id === "string" && id)
          .slice(0, maxEntityIds)
          .map((id) => id.slice(0, 512));
        return ids.length ? [[key, ids]] : [];
      }
      return [];
    }),
  );
}

function writeEnvelope({
  status,
  operation,
  requestId,
  writeAttempted,
  writeVerified,
  replay = false,
  entityIds = {},
  facts = {},
  errorCode = null,
  retryable = false,
}) {
  return {
    status,
    operation: operation ?? null,
    requestId: requestId ?? null,
    writeAttempted: Boolean(writeAttempted),
    writeVerified: Boolean(writeVerified),
    replay: Boolean(replay),
    entityIds: boundedEntityIds(entityIds),
    facts: boundedFacts(facts),
    errorCode: errorCode ?? null,
    retryable: Boolean(retryable),
  };
}

function writeToolResult(value) {
  return toolResult(
    value,
    !new Set(["validated", "succeeded"]).has(value.status),
  );
}

function writePreparationFailure(error, args) {
  const operation =
    error instanceof WritePreparationError
      ? error.operation
      : typeof args?.operation === "string"
        ? args.operation
        : null;
  const requestId =
    error instanceof WritePreparationError
      ? error.requestId
      : typeof args?.requestId === "string" &&
          requestKeyPattern.test(args.requestId)
        ? args.requestId
        : null;
  return writeToolResult(
    writeEnvelope({
      status: "failed",
      operation,
      requestId,
      writeAttempted: false,
      writeVerified: false,
      facts: {
        reason: error instanceof Error ? error.message : "Invalid tool call",
      },
      errorCode: "INVALID_TOOL_ARGUMENTS",
      retryable: false,
    }),
  );
}

async function fetchApiJson({ method, path, body, requestId }) {
  const target = new URL(path.slice(1), api.base);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${api.token}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-Idempotency-Key"] = requestId;
  }
  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { kind: "transport" };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return { kind: "response", response, json: false, data: null };
  }
  return { kind: "response", response, json: true, data };
}

function validApiError(data) {
  return (
    isObject(data) &&
    typeof data.errorCode === "string" &&
    apiErrorCodePattern.test(data.errorCode) &&
    isObject(data.facts)
  );
}

function writeHttpFailure(request, outcome, writeAttempted) {
  const statusCode = outcome.response.status;
  const conflict = statusCode === 409;
  const uncertain =
    statusCode >= 500 ||
    statusCode === 408 ||
    statusCode === 425 ||
    statusCode === 429;
  const stable = outcome.json && validApiError(outcome.data);
  return writeToolResult(
    writeEnvelope({
      status: conflict ? "conflict" : uncertain ? "uncertain" : "failed",
      operation: request.operation,
      requestId: request.requestId,
      writeAttempted,
      writeVerified: false,
      facts: {
        ...(stable ? outcome.data.facts : {}),
        httpStatus: statusCode,
      },
      errorCode: stable
        ? outcome.data.errorCode
        : outcome.json
          ? "UPSTREAM_API_ERROR"
          : "UPSTREAM_NON_JSON_RESPONSE",
      retryable: uncertain || statusCode === 429,
    }),
  );
}

function uncertainWriteResult(
  request,
  {
    writeAttempted,
    receipt = null,
    facts = {},
    errorCode,
    retryable = true,
  },
) {
  return writeToolResult(
    writeEnvelope({
      status: "uncertain",
      operation: request.operation,
      requestId: request.requestId,
      writeAttempted,
      writeVerified: false,
      replay: receipt?.replay ?? false,
      entityIds: receipt?.entityIds ?? {},
      facts: { ...(receipt?.facts ?? {}), ...facts },
      errorCode,
      retryable,
    }),
  );
}

async function runWritePreflight(request) {
  if (request.descriptor.preflight === noWritePreflight) return null;
  const preflight = await request.descriptor.preflight({
    body: request.body,
    operation: request.operation,
    requestId: request.requestId,
  });
  if (!preflight) return null;
  if (!new Set(["GET", "HEAD"]).has(preflight.method)) {
    throw new Error("Write preflight must be non-mutating");
  }
  return fetchApiJson({
    method: preflight.method,
    path: preflight.path,
    body: undefined,
    requestId: null,
  });
}

async function callWriteApi(request) {
  let preflight;
  try {
    preflight = await runWritePreflight(request);
  } catch (error) {
    return writeToolResult(
      writeEnvelope({
        status: "failed",
        operation: request.operation,
        requestId: request.requestId,
        writeAttempted: false,
        writeVerified: false,
        facts: {
          reason:
            error instanceof Error ? error.message : "Write preflight failed",
        },
        errorCode: "WRITE_PREFLIGHT_FAILED",
        retryable: false,
      }),
    );
  }
  if (preflight?.kind === "transport") {
    return writeToolResult(
      writeEnvelope({
        status: "failed",
        operation: request.operation,
        requestId: request.requestId,
        writeAttempted: false,
        writeVerified: false,
        errorCode: "WRITE_PREFLIGHT_UNAVAILABLE",
        retryable: true,
      }),
    );
  }
  if (preflight?.kind === "response" && !preflight.response.ok) {
    return writeHttpFailure(request, preflight, false);
  }

  const writeAttempted = request.descriptor.mutating;
  const mutation = await fetchApiJson({
    method: request.method,
    path: request.path,
    body: request.body,
    requestId: request.requestId,
  });
  if (mutation.kind === "transport") {
    return uncertainWriteResult(request, {
      writeAttempted,
      errorCode: "FITNESS_API_UNAVAILABLE",
      retryable: true,
    });
  }
  if (!mutation.response.ok) {
    return writeHttpFailure(request, mutation, writeAttempted);
  }
  if (!mutation.json) {
    return uncertainWriteResult(request, {
      writeAttempted,
      facts: { httpStatus: mutation.response.status },
      errorCode: "UPSTREAM_NON_JSON_RESPONSE",
      retryable: true,
    });
  }
  if (
    isObject(mutation.data) &&
    mutation.data.requestId !== undefined &&
    mutation.data.requestId !== request.requestId
  ) {
    return uncertainWriteResult(request, {
      writeAttempted,
      errorCode: "MUTATION_REQUEST_ID_MISMATCH",
      retryable: false,
    });
  }
  if (
    request.descriptor.mutating &&
    (!isObject(mutation.data) || mutation.data.requestId === undefined)
  ) {
    return uncertainWriteResult(request, {
      writeAttempted,
      facts: { reason: "Mutation response is missing requestId" },
      errorCode: "MUTATION_RESPONSE_INCOMPLETE",
      retryable: true,
    });
  }

  let receipt;
  try {
    receipt = request.descriptor.receipt(mutation.data, request.body);
  } catch (error) {
    return uncertainWriteResult(request, {
      writeAttempted,
      facts: {
        reason:
          error instanceof Error
            ? error.message
            : "Mutation response is incomplete",
      },
      errorCode: "MUTATION_RESPONSE_INCOMPLETE",
      retryable: true,
    });
  }

  let readbackData = null;
  if (request.descriptor.readback) {
    const readbackRequest = request.descriptor.readback({
      body: request.body,
      receipt,
      mutationData: mutation.data,
    });
    if (!new Set(["GET", "HEAD"]).has(readbackRequest.method)) {
      return uncertainWriteResult(request, {
        writeAttempted,
        receipt,
        errorCode: "INVALID_READBACK_METHOD",
        retryable: false,
      });
    }
    const readback = await fetchApiJson({
      method: readbackRequest.method,
      path: readbackRequest.path,
      body: undefined,
      requestId: null,
    });
    if (readback.kind === "transport") {
      return uncertainWriteResult(request, {
        writeAttempted,
        receipt,
        errorCode: "WRITE_READBACK_UNAVAILABLE",
        retryable: true,
      });
    }
    if (!readback.response.ok || !readback.json) {
      const statusCode = readback.response.status;
      const stable = readback.json && validApiError(readback.data);
      const retryable =
        statusCode >= 500 ||
        statusCode === 408 ||
        statusCode === 425 ||
        statusCode === 429;
      return uncertainWriteResult(request, {
        writeAttempted,
        receipt,
        facts: {
          ...(stable ? readback.data.facts : {}),
          httpStatus: statusCode,
        },
        errorCode: stable
          ? readback.data.errorCode
          : !readback.json
            ? "WRITE_READBACK_NON_JSON"
            : "WRITE_READBACK_FAILED",
        retryable,
      });
    }
    readbackData = readback.data;
  }

  let verified = false;
  try {
    verified = Boolean(
      await request.descriptor.verify({
        body: request.body,
        operation: request.operation,
        receipt,
        mutationData: mutation.data,
        readbackData,
      }),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    return uncertainWriteResult(request, {
      writeAttempted,
      receipt,
      errorCode: "WRITE_VERIFICATION_FAILED",
      retryable: false,
    });
  }

  let verifiedFacts = {};
  if (request.descriptor.facts) {
    try {
      verifiedFacts = await request.descriptor.facts({
        body: request.body,
        operation: request.operation,
        receipt,
        mutationData: mutation.data,
        readbackData,
      });
    } catch {
      verifiedFacts = {};
    }
  }

  return writeToolResult(
    writeEnvelope({
      status: request.descriptor.mutating ? "succeeded" : "validated",
      operation: request.operation,
      requestId: request.requestId,
      writeAttempted,
      writeVerified: request.descriptor.mutating,
      replay: receipt.replay,
      entityIds: receipt.entityIds,
      facts: { ...receipt.facts, ...verifiedFacts },
      errorCode: null,
      retryable: false,
    }),
  );
}

async function callApi(request) {
  if (request.kind === "write") {
    return callWriteApi(request);
  }
  if (request.local) {
    if (request.label === "instructions") {
      return toolResult({
        ok: true,
        action: request.label,
        data: coreInstructions,
      });
    }
    if (request.label === "write_contract") {
      const operation = request.params.operation;
      const contract = writeContractCards[operation];
      if (!contract) {
        return failureResult({
          errorCode: "UNKNOWN_WRITE_OPERATION",
          action: request.label,
        });
      }
      return toolResult({
        ok: true,
        action: request.label,
        data: { operation, ...contract },
      });
    }
    if (request.label === "evidence_reference") {
      try {
        const evidence = await readFile(
          new URL("../references/evidence.md", import.meta.url),
          "utf8",
        );
        return toolResult({
          ok: true,
          action: request.label,
          data: { evidence },
        });
      } catch {
        return failureResult({
          errorCode: "EVIDENCE_REFERENCE_UNAVAILABLE",
          action: request.label,
        });
      }
    }
    return failureResult({
      errorCode: "UNKNOWN_LOCAL_RESOURCE",
      action: request.label,
    });
  }

  const target = new URL(request.path.slice(1), api.base);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${api.token}`,
  };
  if (request.body) {
    headers["Content-Type"] = "application/json";
    headers["X-Idempotency-Key"] = request.requestId;
  }

  let response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return failureResult({
      errorCode: "FITNESS_API_UNAVAILABLE",
      action: request.label,
      requestId: request.requestId,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return failureResult({
      errorCode: "UPSTREAM_NON_JSON_RESPONSE",
      status: response.status,
      action: request.label,
      requestId: request.requestId,
    });
  }

  if (!response.ok) {
    const validEnvelope =
      isObject(data) &&
      typeof data.errorCode === "string" &&
      apiErrorCodePattern.test(data.errorCode) &&
      isObject(data.facts) &&
      Buffer.byteLength(JSON.stringify(data.facts)) <= maxBodyBytes;
    return failureResult({
      errorCode: validEnvelope ? data.errorCode : "UPSTREAM_API_ERROR",
      facts: validEnvelope ? data.facts : {},
      status: response.status,
      action: request.label,
      requestId: request.requestId,
    });
  }

  if (request.label === "analysis") {
    data = shapeAnalysis(data, request.view);
  }

  return toolResult(
    {
      ok: response.ok,
      status: response.status,
      action: request.label,
      requestId: request.requestId,
      data,
    },
    false,
  );
}

function failureResult({
  errorCode,
  facts = {},
  status,
  action,
  requestId,
}) {
  return toolResult(
    {
      ok: false,
      errorCode,
      facts,
      ...(status === undefined ? {} : { status }),
      ...(action === undefined ? {} : { action }),
      ...(requestId == null ? {} : { requestId }),
    },
    true,
  );
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id, code, message) {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handle(message) {
  if (!isObject(message) || message.jsonrpc !== "2.0") {
    rpcError(message?.id, -32600, "Invalid Request");
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return;

  if (method === "initialize") {
    result(id, {
      protocolVersion:
        typeof params?.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "open-fitness", version: "1.0.0" },
    });
    return;
  }
  if (method === "ping") {
    result(id, {});
    return;
  }
  if (method === "tools/list") {
    result(id, { tools });
    return;
  }
  if (method === "resources/list" || method === "prompts/list") {
    const key = method.startsWith("resources") ? "resources" : "prompts";
    result(id, { [key]: [] });
    return;
  }
  if (method === "tools/call") {
    try {
      if (!isObject(params)) throw new Error("Missing tool call parameters");
      const request =
        params.name === "fitness_read"
          ? readRequest(params.arguments)
          : params.name === "fitness_write"
            ? writeRequest(params.arguments)
            : null;
      if (!request) throw new Error("Unknown tool");
      result(id, await callApi(request));
    } catch (error) {
      if (isObject(params) && params.name === "fitness_write") {
        result(id, writePreparationFailure(error, params.arguments));
        return;
      }
      result(
        id,
        failureResult({
          errorCode: "INVALID_TOOL_ARGUMENTS",
          facts: readFailureFacts(params.arguments, error),
          action: isObject(params) ? params.name : undefined,
        }),
      );
    }
    return;
  }
  rpcError(id, -32601, "Method not found");
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
lines.on("line", (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > maxMessageBytes) {
    rpcError(null, -32600, "Message too large");
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    rpcError(null, -32700, "Parse error");
    return;
  }
  queue = queue.then(() => handle(message)).catch(() => {
    rpcError(message?.id, -32603, "Internal error");
  });
});
