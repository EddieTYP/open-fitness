import { exerciseMessages } from "./i18n/messages/exercises.ts";
import { messageText, sourceText, type UiText } from "./i18n/ui-text.ts";

type ExerciseMessageKey = keyof typeof exerciseMessages.en;

const exerciseKeys = {
  "barbell back squat": "exercise.name.barbellBackSquat",
  "barbell bench press": "exercise.name.barbellBenchPress",
  "barbell overhead press": "exercise.name.barbellOverheadPress",
  "barbell overhead press / military press":
    "exercise.name.barbellOverheadMilitaryPress",
  "barbell romanian deadlift": "exercise.name.barbellRomanianDeadlift",
  "bodyweight calf raise": "exercise.name.bodyweightCalfRaise",
  "cable bar straight arm pull down":
    "exercise.name.cableStraightArmPulldown",
  "cable bar straight-arm pulldown":
    "exercise.name.cableStraightArmPulldown",
  "cable chop": "exercise.name.cableChop",
  "cable crunch": "exercise.name.cableCrunch",
  "cable face pull": "exercise.name.cableFacePull",
  "cable fly high": "exercise.name.cableFlyHigh",
  "high cable fly": "exercise.name.cableFlyHigh",
  "cable lat pull down single-arm":
    "exercise.name.cableSingleArmLatPulldown",
  "single-arm cable lat pulldown":
    "exercise.name.cableSingleArmLatPulldown",
  "cable lat pull down wide-grip":
    "exercise.name.cableWideGripLatPulldown",
  "wide-grip cable lat pulldown":
    "exercise.name.cableWideGripLatPulldown",
  "cable rope bicep curl": "exercise.name.cableRopeBicepCurl",
  "cable rope overhead tricep extension low":
    "exercise.name.cableRopeOverheadTricepExtension",
  "low cable rope overhead tricep extension":
    "exercise.name.cableRopeOverheadTricepExtension",
  "cable rope tricep pushdown / extension":
    "exercise.name.cableRopeTricepPushdown",
  "cable single-arm bicep curl":
    "exercise.name.cableSingleArmBicepCurl",
  "single-arm cable bicep curl":
    "exercise.name.cableSingleArmBicepCurl",
  "cable standing russian twist":
    "exercise.name.cableStandingRussianTwist",
  "standing cable russian twist":
    "exercise.name.cableStandingRussianTwist",
  "cable v-handle seated row": "exercise.name.cableVHandleSeatedRow",
  "cable seated row v grip": "exercise.name.cableVHandleSeatedRow",
  "v-handle seated cable row": "exercise.name.cableVHandleSeatedRow",
  "captain's chair leg raise": "exercise.name.captainsChairLegRaise",
  "dumbbell bench press": "exercise.name.dumbbellBenchPress",
  "dumbbell bicep curl": "exercise.name.dumbbellBicepCurl",
  "dumbbell bulgarian split squat":
    "exercise.name.dumbbellBulgarianSplitSquat",
  "dumbbell curl": "exercise.name.dumbbellCurl",
  "dumbbell hammer curl": "exercise.name.dumbbellHammerCurl",
  "dumbbell lateral raise": "exercise.name.dumbbellLateralRaise",
  "dumbbell shoulder press": "exercise.name.dumbbellShoulderPress",
  "ez-bar bicep curl": "exercise.name.ezBarBicepCurl",
  "ez-bar biceps curl": "exercise.name.ezBarBicepCurl",
  "ez-bar reverse-grip bicep curls":
    "exercise.name.ezBarReverseGripBicepCurl",
  "ez-bar reverse-grip bicep curl":
    "exercise.name.ezBarReverseGripBicepCurl",
  "hanging leg raise": "exercise.name.hangingLegRaise",
  "leg / hamstring curl seated": "exercise.name.seatedHamstringCurl",
  "seated hamstring curl": "exercise.name.seatedHamstringCurl",
  "machine fly (pec dec)": "exercise.name.machineFlyPecDec",
  "machine fly (pec deck)": "exercise.name.machineFlyPecDec",
  "器械飛鳥（胸飛鳥）": "exercise.name.machineFlyPecDec",
  "器械飞鸟（胸飞鸟）": "exercise.name.machineFlyPecDec",
  "machine hip adduction": "exercise.name.machineHipAdduction",
  "machine incline bench press":
    "exercise.name.machineInclineBenchPress",
  "machine leg extension": "exercise.name.machineLegExtension",
  "machine seated chest press":
    "exercise.name.machineSeatedChestPress",
  "machine shoulder press": "exercise.name.machineShoulderPress",
  "pull-up": "exercise.name.pullUp",
  "滑輪繩索三頭下壓": "exercise.name.cableRopeTricepPushdown",
  "滑轮绳索三头下压": "exercise.name.cableRopeTricepPushdown",
  "器械腿伸展": "exercise.name.machineLegExtension",
  "體重小腿肌抬舉": "exercise.name.bodyweightCalfRaise",
  "体重小腿肌抬举": "exercise.name.bodyweightCalfRaise",
} as const satisfies Record<string, ExerciseMessageKey>;

function normaliseExerciseIdentity(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en");
}

const exerciseKeyByIdentity = new Map<string, ExerciseMessageKey>();
for (const [value, key] of Object.entries(exerciseKeys)) {
  exerciseKeyByIdentity.set(normaliseExerciseIdentity(value), key);
}
for (const messages of Object.values(exerciseMessages)) {
  for (const [key, value] of Object.entries(messages)) {
    exerciseKeyByIdentity.set(
      normaliseExerciseIdentity(value),
      key as ExerciseMessageKey,
    );
  }
}

export function exerciseMessageKey(value: string): ExerciseMessageKey | null {
  return exerciseKeyByIdentity.get(normaliseExerciseIdentity(value)) ?? null;
}

export function canonicalExerciseIdentity(value: string) {
  const key = exerciseMessageKey(value);
  return key
    ? `message:${key}`
    : `source:${normaliseExerciseIdentity(value)}`;
}

export function exerciseText(value: string): UiText {
  const key = exerciseMessageKey(value);
  return key ? messageText(key) : sourceText(value);
}
