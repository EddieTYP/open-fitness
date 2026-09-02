import { messageText, sourceText, type UiText } from "./ui-text.ts";

const canonicalWorkoutTypeMessages: Record<string, string> = {
  strength: "log.form.workout.typeStrength",
  cardio: "log.form.workout.typeCardio",
  "cardio - walk": "log.record.workoutType.walking",
  "cardio - walking": "log.record.workoutType.walking",
  "cardio - stair": "log.record.workoutType.stairs",
  mobility: "log.form.workout.typeMobility",
  sport: "log.form.workout.typeSport",
  other: "log.form.workout.typeOther",
  "other / unclassified": "log.form.workout.typeOther",
};

export function workoutTypeText(value: string): UiText {
  const key = canonicalWorkoutTypeMessages[
    value.trim().replace(/\s+/g, " ").toLowerCase()
  ];
  return key ? messageText(key) : sourceText(value);
}
