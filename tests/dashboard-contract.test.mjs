import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("nutrition chart keeps intake separate from activity settlement", async () => {
  const [trend, nutrition] = await Promise.all([
    source("components/NutritionTrend.tsx"),
    source("lib/nutrition.ts"),
  ]);

  assert.match(trend, /nutrition\.trend\.energyLegend/);
  assert.match(trend, /nutrition\.trend\.proteinLegend/);
  assert.doesNotMatch(trend, /nutrition-trend-bar is-provisional/);
  assert.match(trend, /activityLabel\(day\.activityState, t\)/);
  assert.match(nutrition, /activityState:\s*[\s\S]*"missing"/);
});

test("course generation preserves repeated work-set counts without inventing venue", async () => {
  const [fitness, workoutRoute, workoutNormaliser] = await Promise.all([
    source("lib/fitness.ts"),
    source("app/api/fitness/workout-sessions/route.ts"),
    source("lib/workout-records.ts"),
  ]);

  assert.match(fitness, /Math\.min\(\s*5,/);
  assert.doesNotMatch(fitness, /Math\.min\(\s*3,/);
  assert.match(fitness, /setTypeManual/);
  assert.match(workoutRoute, /normaliseWorkoutPayload/);
  assert.match(workoutNormaliser, /setTypeManual: optionalText\(set\.setTypeManual/);
  assert.match(fitness, /venue: string \| null/);
  assert.match(fitness, /const currentVenue = options\.planningVenue/);
  assert.match(fitness, /return \{ kind: "unknown", label: null \}/);
  assert.match(
    fitness,
    /const directVenue = resolveVenueLabels\(\[\s*session\.venueManual,\s*\.\.\.sets\.map\(\(set\) => set\.venueManual\),\s*\]\)/,
  );
  assert.match(fitness, /if \(directVenue\.kind !== "unknown"\) return directVenue/);
  assert.match(
    fitness,
    /return resolveVenueLabels\(sessionNotes\.map\(\(note\) => note\.venue\)\)/,
  );
  assert.match(fitness, /left\.kind === "conflict"/);
  assert.doesNotMatch(fitness, /Current single-owner rule/);
  assert.doesNotMatch(fitness, /usualVenueAsOf/);
  assert.match(fitness, /fitness\.review\.compare\.missingReps/);
  assert.match(fitness, /session\.sessionIntent === "normal"/);
  assert.match(fitness, /session\.trainingBlockId === currentTrainingBlock\.blockId/);
  assert.match(fitness, /trainingNextCourseOverrides/);
  assert.match(fitness, /source: "next" as const/);
  assert.match(fitness, /overrideStatus: "confirmed_next_normal"/);
});

test("normal workouts consume confirmed next-course overrides exactly once", async () => {
  const route = await source("app/api/fitness/workout-sessions/route.ts");

  assert.match(route, /workout\.sessionIntent === "normal"/);
  assert.match(route, /workout\.trainingPhaseId !== null/);
  assert.match(route, /consumedBySessionId: workout\.sessionId/);
  assert.match(route, /isNull\(trainingNextCourseOverrides\.consumedAt\)/);
  assert.match(route, /isNull\(trainingNextCourseOverrides\.voidedAt\)/);
});

test("planned deload or test is exact-date, exact-phase and consumed only by a matching workout", async () => {
  const [fitness, courseRoute, workoutRoute, app] = await Promise.all([
    source("lib/fitness.ts"),
    source("app/api/fitness/training-course/route.ts"),
    source("app/api/fitness/workout-sessions/route.ts"),
    source("components/FitnessApp.tsx"),
  ]);

  assert.match(courseRoute, /mutation\.scope === "planned_session"/);
  assert.match(courseRoute, /trainingPlannedSessions\.localDate, mutation\.date/);
  assert.match(courseRoute, /trainingPlannedSessions\.phaseId, mutation\.phaseId/);
  assert.match(courseRoute, /trainingPlannedSessions\.trainingBlockId/);
  assert.match(fitness, /candidate\.localDate === planningDate/);
  assert.match(fitness, /candidate\.phaseId === inferredNextPhase\.id/);
  assert.match(fitness, /plannedSession\?\.sessionIntent \?\? "normal"/);
  assert.match(fitness, /selection\.overrideBatchId === plannedSession\?\.overrideBatchId/);
  assert.match(workoutRoute, /workout\.sessionIntent !== "normal"/);
  assert.match(workoutRoute, /trainingPlannedSessions\.localDate, workout\.localDate/);
  assert.match(workoutRoute, /trainingPlannedSessions\.sessionIntent, workout\.sessionIntent/);
  assert.match(app, /fitness\.intent\.\$\{plan\.sessionIntent\}/);
  assert.match(app, /function standardPhaseMessageKey\(label: string\)/);
  assert.match(app, /fitness\.phase\.lowerBody/);
  assert.match(app, /className="decision-status-row"/);
  assert.match(app, /className="decision-session-mode"/);
  assert.doesNotMatch(app, /className=\{`log-intent-badge is-\$\{plan\.sessionIntent\}`\}/);
});

test("configured and history-derived routines expose a low-noise one-workout exercise picker", async () => {
  const [fitness, app, route] = await Promise.all([
    source("lib/fitness.ts"),
    source("components/FitnessApp.tsx"),
    source("app/api/fitness/training-selections/route.ts"),
  ]);

  assert.match(fitness, /buildConfiguredCourseItems/);
  assert.match(fitness, /buildHistoryCourseItems/);
  assert.match(fitness, /historyExerciseSlotId/);
  assert.match(fitness, /effectiveExerciseSelection/);
  assert.match(fitness, /selectionSource/);
  assert.match(fitness, /const planningRows = planningSetRows\(sourceSets\)/);
  assert.match(
    fitness,
    /!usesSourceHistory[\s\S]*fitness\.plan\.load\.testSetFirst/,
  );
  assert.match(
    fitness,
    /historyCourseGroups\(sets\)[\s\S]*fallbackSource: "history"/,
  );
  assert.match(
    fitness,
    /buildHistoryCourseItems[\s\S]*phaseId: phase\.id,[\s\S]*slotId: slot\.id/,
  );
  assert.match(app, /fitness\.exercise\.change/);
  assert.match(app, /fitness\.exercise\.searchLabel/);
  assert.match(app, /fitness\.exercise\.applyOnce/);
  assert.match(app, /scope: "date"/);
  assert.doesNotMatch(app, /fitness\.exercise\.venueDefault/);
  assert.doesNotMatch(app, /fitness\.exercise\.permanent/);
  assert.match(route, /export async function GET/);
  assert.match(route, /mutation\.scope === "date"/);
  assert.match(route, /isCurrentDateSelectionTarget/);
  assert.match(route, /The selected training phase no longer exists/);
  assert.match(
    route,
    /mutation\.scope === "date"[\s\S]*phase\.routine\?\.find/,
  );
});

test("training constraints stay on affected exercise rows", async () => {
  const [fitness, app, css, messages] = await Promise.all([
    source("lib/fitness.ts"),
    source("components/FitnessApp.tsx"),
    source("app/globals.css"),
    source("lib/i18n/messages/fitness.ts"),
  ]);
  const historyCourse = fitness.slice(
    fitness.indexOf("function buildHistoryCourseItems"),
    fitness.indexOf("function buildConfiguredCourseItems"),
  );

  assert.doesNotMatch(fitness, /review_constraints/);
  assert.doesNotMatch(app, /review_constraints/);
  assert.doesNotMatch(messages, /fitness\.briefing\.constraints/);
  assert.doesNotMatch(messages, /fitness\.decision\.review_constraints/);
  assert.doesNotMatch(
    historyCourse,
    /\.filter\([\s\S]*?exerciseConstraintStateForSets[\s\S]*?\.paused/,
  );
  assert.match(
    historyCourse,
    /prescription: selection\.prescriptionOverride[\s\S]*?: paused[\s\S]*?sourceText\("-"\)/,
  );
  assert.match(
    historyCourse,
    /loadGuidance: selection\.loadGuidanceOverride[\s\S]*?: paused[\s\S]*?fitness\.plan\.load\.paused/,
  );
  assert.match(historyCourse, /notice,[\s\S]*?caution: paused \|\| conditional/);
  assert.match(app, /className="course-notice" role="note"/);
  assert.match(app, /fitness\.course\.attention/);
  assert.match(css, /\.course-notice[\s\S]*?grid-area: notice/);
  assert.match(css, /"phase notice notice notice notice caret"/);
});

test("dashboard refresh uses no-store revision checks", async () => {
  const [app, nutritionView, revisionRoute, snapshotRoute] = await Promise.all([
    source("components/FitnessApp.tsx"),
    source("components/NutritionView.tsx"),
    source("app/api/fitness/revisions/route.ts"),
    source("app/api/fitness/snapshot/route.ts"),
  ]);

  assert.match(app, /\/api\/fitness\/revisions/);
  assert.match(app, /\/api\/fitness\/snapshot/);
  assert.match(revisionRoute, /MAX\(CASE/);
  assert.match(revisionRoute, /dateInTimeZone\(new Date\(\), timezone\)/);
  assert.match(revisionRoute, /MAX\(observed_at\)/);
  assert.match(revisionRoute, /nutritionEnergyRevision/);
  assert.match(snapshotRoute, /cache-control.*no-store/s);
  assert.match(snapshotRoute, /SNAPSHOT_CONTRACT_VERSION = 6/);
  assert.match(snapshotRoute, /getDashboardData\(\{ planningVenue: venue \}\)/);
  assert.match(app, /dashboardStatusRef\.current !== "unavailable"/);
  assert.match(nutritionView, /nutritionNeedsRetryRef\.current/);
  assert.match(nutritionView, /checkNutritionRevision,[\s\S]*10_000/);
  assert.match(nutritionView, /addEventListener\("pageshow", handlePageShow\)/);
});

test("greeting and health date follow the profile timezone", async () => {
  const app = await source("components/FitnessApp.tsx");

  assert.match(app, /useState<Date \| null>\(null\)/);
  assert.match(app, /useI18n\(\)/);
  assert.match(app, /function greetingKeyForDevice[\s\S]*timeZone: timezone/);
  assert.match(app, /greetingKeyForDevice\(deviceNow, timezone\)/);
  assert.match(app, /formatDate\(recordNow,[\s\S]*?timeZone: timezone/);
  assert.match(app, /rangeAnchorTime - \(range - 1\) \* 86_400_000/);
  assert.match(app, /formatDate\(activePoint\.date,[\s\S]*?year: "numeric"/);
  assert.doesNotMatch(app, /DateTimeFormat\("zh-HK"/);
});

test("mobile day and nutrition transitions stay stable", async () => {
  const [nutritionView, styles] = await Promise.all([
    source("components/NutritionView.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(nutritionView, /if \(loading && !data\)/);
  assert.match(nutritionView, /const NUTRITION_LOAD_TIMEOUT_MS = 10_000/);
  assert.match(nutritionView, /const controller = new AbortController\(\)/);
  assert.match(nutritionView, /signal: controller\.signal/);
  assert.match(nutritionView, /controller\.abort\(\)/);
  assert.match(nutritionView, /nutrition-view\$\{loading \? " is-refreshing" : ""\}/);
  assert.match(styles, /\.decision-title-row \{[\s\S]*?display: grid/);
  assert.match(
    styles,
    /\.decision-status-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto/,
  );
  assert.match(styles, /\.decision-session-mode \{[\s\S]*?border-radius: 6px/);
  assert.match(styles, /\.decision-session-mode \{[\s\S]*?font-size: 11px/);
  assert.doesNotMatch(
    styles,
    /@media \(min-width: 680px\) \{[\s\S]*?\.decision-title-row \{[\s\S]*?display: flex/,
  );
  assert.match(
    styles,
    /\.nutrition-date-nav \{[\s\S]*?grid-template-columns: 44px minmax\(0, 1fr\) 44px 80px/,
  );
  assert.match(styles, /\.nutrition-view\.is-refreshing \.nutrition-date-nav::after/);
});

test("food library keeps mobile search results usable and resets nested scroll", async () => {
  const [nutritionView, styles] = await Promise.all([
    source("components/NutritionView.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(nutritionView, /const libraryListRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(nutritionView, /const foodEditorRef = useRef<HTMLFormElement \| null>\(null\)/);
  assert.match(
    nutritionView,
    /const resetLibraryListScroll = useCallback\(\(\) => \{[\s\S]*?libraryListRef\.current\.scrollTop = 0/,
  );
  assert.match(
    nutritionView,
    /const resetFoodEditorScroll = useCallback\(\(\) => \{[\s\S]*?foodEditorRef\.current\.scrollTop = 0/,
  );
  assert.match(nutritionView, /ref=\{libraryListRef\} className="library-list"/);
  assert.match(
    nutritionView,
    /ref=\{foodEditorRef\}[\s\S]*?className="food-editor"/,
  );
  assert.ok(
    nutritionView.match(/resetLibraryListScroll\(\)/g)?.length >= 4,
    "open, search, save, and status changes must restore the result list to its top",
  );
  assert.ok(
    nutritionView.match(/resetFoodEditorScroll\(\)/g)?.length >= 5,
    "open, select, create, save, and status changes must restore the editor to its top",
  );

  const desktopStart = styles.indexOf("@media (min-width: 680px)");
  const desktopEnd = styles.indexOf("@media (min-width: 800px)", desktopStart);
  const mobile = styles.slice(0, desktopStart);
  const desktop = styles.slice(desktopStart, desktopEnd);
  assert.match(
    mobile,
    /\.library-body\s*\{[^}]*grid-template-rows:\s*clamp\(260px, 38dvh, 320px\) minmax\(0, 1fr\)/,
  );
  for (const selector of ["library-list", "food-editor"]) {
    assert.match(
      mobile,
      new RegExp(
        `\\.${selector}\\s*\\{[^}]*min-height:\\s*0[^}]*overflow-x:\\s*hidden[^}]*overflow-y:\\s*auto[^}]*overscroll-behavior:\\s*contain[^}]*touch-action:\\s*pan-y`,
      ),
    );
  }
  assert.match(
    desktop,
    /\.library-body\s*\{[^}]*grid-template-columns:\s*220px minmax\(0, 1fr\)[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/,
  );
});

test("primary tab navigation keeps loaded views stable and places log last", async () => {
  const [app, logView, nutritionView, styles] = await Promise.all([
    source("components/FitnessApp.tsx"),
    source("components/LogView.tsx"),
    source("components/NutritionView.tsx"),
    source("app/globals.css"),
  ]);
  const navigation = app.match(/const navigation = \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(navigation);

  const order = ["today", "nutrition", "progress", "log"].map((tab) =>
    navigation.indexOf(`id: "${tab}"`),
  );
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));

  for (const tab of ["today", "nutrition", "progress", "log"]) {
    assert.match(
      app,
      new RegExp(`<Activity mode=\\{activeTab === "${tab}" \\? "visible" : "hidden"\\}`),
    );
  }
  assert.match(app, /pendingScrollTop\.current = scrollPositions\.current\[nextTab\]/);
  assert.match(app, /useLayoutEffect\(\(\) => \{[\s\S]*?window\.scrollTo\(\{ top \}\)/);
  assert.match(app, /window\.history\.scrollRestoration = "manual"/);
  assert.doesNotMatch(app, /key=\{nutritionEpoch\}/);
  assert.match(logView, /active && syncedExternalDate !== requestedExternalDate/);
  assert.match(
    logView,
    /return \(\) => \{[\s\S]*?window\.clearTimeout\(timer\);[\s\S]*?requestSequence\.current \+= 1/,
  );
  assert.match(nutritionView, /active && syncedExternalDate !== requestedExternalDate/);
  assert.match(styles, /\.tab-stage \{[\s\S]*?min-width: 0/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\.tab-panel\.is-active[\s\S]*?animation: tab-panel-in/,
  );
  assert.match(
    styles,
    /@keyframes tab-panel-in \{[\s\S]*?opacity:[\s\S]*?transform: translateY/,
  );
});

test("course rows group phases on mobile without shrinking desktop columns", async () => {
  const [app, styles] = await Promise.all([
    source("components/FitnessApp.tsx"),
    source("app/globals.css"),
  ]);
  const desktopStart = styles.indexOf("@media (min-width: 680px)");
  const desktopEnd = styles.indexOf("@media (min-width: 800px)", desktopStart);
  assert.notEqual(desktopStart, -1);
  assert.notEqual(desktopEnd, -1);
  const mobile = styles.slice(0, desktopStart);
  const desktop = styles.slice(desktopStart, desktopEnd);

  assert.match(
    app,
    /<h3 className="course-phase-group">[\s\S]*?coursePhaseMessageKeys\[item\.phase\]/,
  );
  assert.match(app, /plan\.items\[index - 1\]\?\.phase !== item\.phase/);
  assert.match(
    app,
    /<span className="course-metrics">[\s\S]*?className="course-prescription"[\s\S]*?className="course-load"[\s\S]*?className="course-effort"/,
  );
  assert.match(
    app,
    /item\.overrideStatus === "confirmed_next_normal"[\s\S]*?fitness\.plan\.status\.confirmed/,
  );
  assert.match(
    mobile,
    /\.course-name\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/,
  );
  assert.match(mobile, /\.course-confirmed-status\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(
    mobile,
    /\.course-phase-group\s*\{[^}]*display:\s*flex/,
  );
  assert.match(mobile, /\.course-phase\s*\{[^}]*display:\s*none/);
  assert.match(
    mobile,
    /\.course-metrics\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*justify-content:\s*flex-start[^}]*column-gap:\s*14px[^}]*row-gap:\s*2px/,
  );
  assert.match(
    mobile,
    /\.course-metrics > span\s*\{[^}]*max-width:\s*100%[^}]*flex:\s*0 1 auto/,
  );
  assert.match(
    mobile,
    /\.course-prescription\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/,
  );
  assert.match(
    mobile,
    /\.course-load\s*\{[^}]*min-width:\s*0[^}]*text-align:\s*left[^}]*text-overflow:\s*ellipsis/,
  );
  assert.match(
    mobile,
    /\.course-effort\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis/,
  );
  assert.doesNotMatch(mobile, /\.course-metrics\s*\{[^}]*grid-template-columns/);
  assert.match(
    mobile,
    /\.course-row summary\s*\{[^}]*grid-template-areas:\s*"name caret"\s*"metrics caret"[^}]*align-content:\s*center/,
  );
  assert.match(
    mobile,
    /\.course-row summary\.course-row-summary-with-notice\s*\{[^}]*grid-template-areas:\s*"name caret"\s*"metrics caret"\s*"notice notice"/,
  );
  assert.match(
    mobile,
    /\.course-row summary\s*\{[^}]*min-height:\s*52px[^}]*row-gap:\s*2px[^}]*padding:\s*6px 12px/,
  );
  assert.match(
    mobile,
    /\.course-name-text\s*\{[^}]*line-height:\s*1\.25[^}]*-webkit-line-clamp:\s*2/,
  );
  assert.match(
    mobile,
    /\.course-phase-group\s*\{[^}]*min-height:\s*28px[^}]*padding:\s*4px 12px/,
  );
  assert.match(
    desktop,
    /\.course-phase-group\s*\{[^}]*display:\s*none/,
  );
  assert.match(desktop, /\.course-phase\s*\{[^}]*display:\s*grid/);
  assert.match(desktop, /\.course-metrics\s*\{[^}]*display:\s*contents/);
  assert.match(desktop, /\.course-column-labels\s*\{[^}]*display:\s*grid/);
  assert.match(
    desktop,
    /\.course-row summary\s*\{[^}]*grid-template-areas:\s*"phase name prescription load effort caret"/,
  );
  assert.match(
    desktop,
    /\.course-row summary\.course-row-summary-with-notice\s*\{[^}]*grid-template-areas:\s*"phase name prescription load effort caret"\s*"phase notice notice notice notice caret"/,
  );
});

test("workout review keeps summary factual and compact", async () => {
  const [fitness, app, styles] = await Promise.all([
    source("lib/fitness.ts"),
    source("components/FitnessApp.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(fitness, /fitness\.review\.summary\.unknownVenue/);
  assert.match(fitness, /fitness\.review\.volume\.value/);
  assert.match(fitness, /fitness\.review\.summary\.multiSession/);
  assert.match(app, /const isMultiSession = review\.segments\.length > 1/);
  assert.match(app, /className="review-segment-section"/);
  assert.match(app, /className="review-segment-label"/);
  assert.match(app, /className="review-segment-content"/);
  assert.match(
    app,
    /review\.segment\.number[\s\S]*review-segment-content[\s\S]*<time/,
  );
  assert.match(styles, /\.review-segment-section\s*\{/);
  assert.match(
    styles,
    /\.review-segment-section li\s*\{[\s\S]*grid-template-columns:\s*52px minmax\(0, 1fr\)[\s\S]*align-items:\s*baseline/,
  );
  assert.doesNotMatch(
    styles,
    /\.review-segment-section li\s*\{[\s\S]*grid-template-columns:\s*48px minmax\(0, 1fr\) auto/,
  );
  assert.doesNotMatch(fitness, /Motra|TANITA/);
  assert.doesNotMatch(
    fitness,
    /場館差異已分開處理|只作課堂摘要|不會單靠呢個數值判斷加重/,
  );
});

test("progress follows the configured goal and a comparable recorded exercise", async () => {
  const fitness = await source("lib/fitness.ts");

  assert.match(fitness, /selectStrengthExercise/);
  assert.match(fitness, /currentProfile\?\.strengthProgressExercise/);
  assert.match(fitness, /goalType === "fat_loss"/);
  assert.match(fitness, /goalType === "strength"/);
  assert.doesNotMatch(
    fitness,
    /eq\(workoutSets\.exercise, "Barbell Back Squat"\)/,
  );
  assert.doesNotMatch(fitness, /深蹲 e1RM 趨勢指標/);
  assert.match(fitness, /venueComparableStrengthRows/);
  assert.match(fitness, /candidateVenue\.kind === "known"/);
  assert.match(
    fitness,
    /selectStrengthExercise\([\s\S]*?currentProfile\?\.strengthProgressExercise,[\s\S]*?venueNotes/,
  );
  assert.match(fitness, /sessionVenue: workoutSessions\.venueManual/);
  assert.match(fitness, /setVenue: workoutSets\.venueManual/);
  assert.match(
    fitness,
    /eq\(workoutSessions\.sessionType, "Strength"\)/,
  );
});

test("next-session planning consumes an explicit scheduled recovery day", async () => {
  const fitness = await source("lib/fitness.ts");

  assert.match(fitness, /inferNextCyclePhase/);
  assert.match(fitness, /"Explicit non-event"/);
  assert.match(fitness, /cycleCompletionRows/);
});

test("cycle progression uses any reliably configured workout while Strength display stays separate", async () => {
  const fitness = await source("lib/fitness.ts");

  assert.match(fitness, /const latestStrengthRow = strengthSessionRows\[0\]/);
  assert.match(fitness, /cycleSessionRows\.find\(\(session\) =>/);
  assert.match(fitness, /matchedCompletedTrainingPhase\(\{/);
  assert.match(fitness, /latestCompletedTitle: latestCycleCompletionRow/);
  assert.match(fitness, /reviewSessionGroup\(strengthSessionRows, latestStrengthRow\)/);
  assert.match(fitness, /aggregateReviewSession\(/);
  assert.match(fitness, /sessionLocalDate\(session\) !==[\s\S]*sessionLocalDate\(latestStrengthRow\)/);
  assert.match(fitness, /latestStrength = toDashboardSession\(latestReviewSession\)/);
});

test("unknown custom phases stay modality-neutral until a baseline exists", async () => {
  const [fitness, trainingCycle] = await Promise.all([
    source("lib/fitness.ts"),
    source("lib/training-cycle.ts"),
  ]);

  assert.match(trainingCycle, /if \(pain010 >= 2\) return "reduce"/);
  assert.doesNotMatch(fitness, /nextTitle\.includes/);
  assert.match(fitness, /decisionCode/);
  assert.match(fitness, /fitness\.plan\.exercise\.activityWarmup/);
  assert.match(fitness, /fitness\.plan\.exercise\.followOriginalPlan/);
  assert.match(fitness, /category === "training" && !planningReferenceSession/);
  assert.match(fitness, /phaseLabel: string/);
  assert.match(fitness, /durationMinutes: \{ minimum: number; maximum: number \} \| null/);
  assert.match(fitness, /function displayEffort/);
  assert.match(fitness, /displayEffort\(latestCardio\.effort\)/);
  assert.doesNotMatch(fitness, /function displaySessionTitle/);
  assert.doesNotMatch(fitness, /latestRecovery\.note\.includes/);
  assert.doesNotMatch(fitness, /Bench 及上斜推暫停/);
  assert.match(fitness, /cycleSessionRows\.find/);
  assert.match(fitness, /matchedPhaseSession\.totalSetsReported > 0/);
  assert.match(fitness, /effectiveOperatingConstraints/);
  assert.match(
    fitness,
    /prescription: selection\.prescriptionOverride[\s\S]*?: paused[\s\S]*?"-"/,
  );
  assert.match(fitness, /exerciseConstraintState/);
  assert.match(fitness, /recoveryRelevantToPhase/);
  assert.match(fitness, /latestCompletedSession \?\? latestStrength/);
  assert.doesNotMatch(fitness, /planningReference \?\? latestStrength/);
  assert.match(
    fitness,
    /matchedPhaseSession\.sessionType === "Strength"/,
  );
  assert.match(fitness, /durationBaselineSession/);
  assert.match(fitness, /currentVenue = options\.planningVenue/);
});

test("nutrition quick record uses versioned combos and atomic meal undo", async () => {
  const [quickRecord, preview, comboRoute, mealRoute, revisionRoute] =
    await Promise.all([
      source("components/nutrition/NutritionQuickRecord.tsx"),
      source("components/nutrition/NutritionPreview.tsx"),
      source("app/api/nutrition/combos/route.ts"),
      source("app/api/nutrition/meals/route.ts"),
      source("app/api/fitness/revisions/route.ts"),
    ]);

  assert.match(quickRecord, /\/api\/nutrition\/combos/);
  assert.match(quickRecord, /expectedVersionNo/);
  assert.match(quickRecord, /quantityOverrides/);
  assert.match(quickRecord, /calculateNutrientPreview/);
  assert.match(quickRecord, /NutritionMacroStrip/);
  assert.match(quickRecord, /NutritionDetailPreview/);
  assert.match(quickRecord, /selectedComboPreview/);
  assert.match(quickRecord, /comboEditorPreview/);
  assert.match(preview, /energyKcal/);
  assert.match(preview, /proteinG/);
  assert.match(preview, /carbsG/);
  assert.match(preview, /totalFatG/);
  assert.match(preview, /nutrition\.preview\.currentQuantity/);
  assert.match(preview, /nutrition\.preview\.more/);
  assert.match(preview, /nutrition\.preview\.partial/);
  assert.match(comboRoute, /"revise" \| "deactivate" \| "reactivate"/);
  assert.match(mealRoute, /nutritionMealComboSources/);
  assert.match(revisionRoute, /'nutrition_combo'/);

  assert.match(quickRecord, /method: "DELETE"/);
  assert.match(quickRecord, /deleteMeal: true/);
  assert.match(quickRecord, /expectedRevisionNo: undo\.expectedRevisionNo/);
  assert.match(mealRoute, /payload\.deleteMeal === true/);
  assert.match(mealRoute, /operation: deleteWholeMeal \? "void"/);

  assert.match(quickRecord, /mealType: "other" as const/);
  assert.match(quickRecord, /contextTag: "post_workout"/);
  assert.match(quickRecord, /originalMealType: null/);
  assert.doesNotMatch(quickRecord, /originalMealType: "運動後"/);
  assert.doesNotMatch(quickRecord, /mealType: "post_workout"/);
  assert.match(quickRecord, /quickMealTiming\(nutrition\.localDate, timezone, now\)/);
});

test("past nutrition dates remain editable without inventing an exact meal time", async () => {
  const [nutritionView, quickRecord] = await Promise.all([
    source("components/NutritionView.tsx"),
    source("components/nutrition/NutritionQuickRecord.tsx"),
  ]);

  assert.match(nutritionView, /const canLogSelectedDate = localDate <= todayDate/);
  assert.match(nutritionView, /showMealAction=\{canLogSelectedDate\}/);
  assert.match(nutritionView, /showEnergyAction=\{isToday\}/);
  assert.match(quickRecord, /\.\.\.quickMealTiming\(nutrition\.localDate, timezone, now\)/);
  assert.doesNotMatch(quickRecord, /eatenAt: now\.toISOString\(\),\s*timePrecision: "exact"/);
});

test("registered foods default to their label serving rather than one unit", async () => {
  const [quickRecord, mealRoute, nutritionView] = await Promise.all([
    source("components/nutrition/NutritionQuickRecord.tsx"),
    source("app/api/nutrition/meals/route.ts"),
    source("components/NutritionView.tsx"),
  ]);

  assert.match(quickRecord, /displayMeasure\(food\.baseQuantity, food\.defaultUnit\)/);
  assert.match(mealRoute, /item\.quantity \?\? food\.baseQuantity/);
  assert.doesNotMatch(mealRoute, /item\.quantity \?\? 1/);
  assert.doesNotMatch(nutritionView, /setQuantity\("1"\)/);
});

test("meal rows can correct classification without changing item snapshots", async () => {
  const [nutritionView, mealRoute] = await Promise.all([
    source("components/NutritionView.tsx"),
    source("app/api/nutrition/meals/route.ts"),
  ]);

  assert.match(nutritionView, /action: "classification"/);
  assert.match(nutritionView, /contextTag: isPostWorkout \? "post_workout"/);
  assert.match(nutritionView, /nutrition\.action\.edit/);
  assert.match(nutritionView, /nutrition\.view\.mealType/);
  assert.match(mealRoute, /action\?: "quantity" \| "classification" \| "append_food"/);
  assert.match(mealRoute, /operation: "revise_classification"/);
  assert.match(mealRoute, /quantity: item\.quantity/);
  assert.match(mealRoute, /foodVersionId: item\.foodVersionId/);
});

test("meal rows can append a registered food without rebuilding existing snapshots", async () => {
  const [nutritionView, mealRoute] = await Promise.all([
    source("components/NutritionView.tsx"),
    source("app/api/nutrition/meals/route.ts"),
  ]);

  assert.match(nutritionView, /action: "append_food"/);
  assert.match(nutritionView, /foodId: selectedFood\.foodId/);
  assert.match(nutritionView, /expectedRevisionNo: meal\.revisionNo/);
  assert.match(nutritionView, /displayMeasure\(food\.baseQuantity, food\.defaultUnit\)/);
  assert.match(nutritionView, /nutrition\.view\.addFood/);
  assert.match(mealRoute, /if \(!food \|\| !food\.isActive\)/);
  assert.match(mealRoute, /foodVersionId: item\.foodVersionId/);
  assert.match(mealRoute, /foodVersionId: food\.foodVersionId/);
  assert.match(mealRoute, /scaleNutrients\([\s\S]*?food\.nutrients/);
  assert.match(mealRoute, /const totals = sumNutrients/);
  assert.match(mealRoute, /operation: "append_food"/);
});

test("nutrition summaries keep only useful metadata and natural missing-data copy", async () => {
  const [nutritionView, nutritionTrend, styles] = await Promise.all([
    source("components/NutritionView.tsx"),
    source("components/NutritionTrend.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(nutritionView, /meal\.timePrecision === "exact"/);
  assert.match(nutritionView, /meal\.revisionNo > 1 \? t\("nutrition\.view\.edited"\)/);
  assert.doesNotMatch(nutritionView, /對話記錄|網站補記|匯入紀錄/);
  assert.match(nutritionTrend, /nutrition\.trend\.blank/);
  assert.doesNotMatch(nutritionTrend, /每格一日|空位代表無紀錄/);
  assert.match(styles, /\.meal-details li \{[\s\S]*?align-items: center/);
  assert.match(styles, /\.meal-item-actions > strong \{[\s\S]*?tabular-nums/);
  assert.match(nutritionView, /function dailyNutrientLabel/);
  assert.match(nutritionView, /value: `≥\$\{numberLabel\(knownTotal/);
  assert.match(nutritionView, /nutrition\.view\.partial/);
  assert.match(nutritionView, /knownValues\.length === 0[\s\S]*missingLabel/);
  assert.match(nutritionView, /data\.activeEnergy\.kcal === null[\s\S]*nutrition\.view\.notEntered/);
  assert.match(
    nutritionView,
    /data\.activeEnergy\.source === "Apple Health Shortcut"[\s\S]*nutrition\.view\.appleHealthSynced/,
  );
});

test("planned meals stay outside intake until they are confirmed", async () => {
  const [
    nutritionView,
    plans,
    preview,
    planRoute,
    nutrition,
    revisionRoute,
    styles,
    quickRecord,
  ] =
    await Promise.all([
      source("components/NutritionView.tsx"),
      source("components/nutrition/NutritionPlans.tsx"),
      source("components/nutrition/NutritionPreview.tsx"),
      source("app/api/nutrition/plans/route.ts"),
      source("lib/nutrition.ts"),
      source("app/api/fitness/revisions/route.ts"),
      source("app/globals.css"),
      source("components/nutrition/NutritionQuickRecord.tsx"),
    ]);

  assert.match(nutritionView, /nutritionPane/);
  assert.match(nutritionView, /nutrition\.view\.record/);
  assert.match(nutritionView, /nutrition\.view\.prep/);
  assert.match(nutritionView, /mode=\{nutritionPane\}/);
  assert.match(plans, /plan\.scheduledDate === today/);
  assert.match(plans, /plan\.scheduledDate < today/);
  assert.match(plans, /nutrition\.plan\.date\.unscheduled/);
  assert.match(plans, /nutrition\.plan\.pending/);
  assert.match(plans, /nutrition\.plan\.empty/);
  assert.match(plans, /nutrition\.plan\.prep/);
  assert.match(plans, /nutrition\.plan\.consumedAction/);
  assert.match(plans, /nutrition\.plan\.deleteAction/);
  assert.match(plans, /nutrition\.plan\.undo/);
  assert.match(plans, /displayMeasure[\s\S]*100g/);
  assert.match(plans, /rawMeasure[\s\S]*100g/);
  assert.match(plans, /calculateNutrientPreview/);
  assert.match(plans, /previewFromPlan/);
  assert.match(plans, /NutritionMacroStrip/);
  assert.match(plans, /NutritionDetailPreview/);
  assert.match(plans, /contextLabel=\{t\("nutrition\.plan\.thisMeal"\)\}/);
  assert.match(plans, /nutrientQuantity/);
  assert.match(plans, /enteredQuantity \/ item\.nutrientQuantity/);
  assert.match(
    plans,
    /function NutritionDialogPortal[\s\S]*createPortal\(children, document\.body\)/,
  );
  assert.match(
    plans,
    /\{draft \? \([\s\S]*<NutritionDialogPortal>[\s\S]*nutrition-plan-editor-actions[\s\S]*<\/NutritionDialogPortal>/,
  );
  assert.match(
    plans,
    /\{deletePlan \? \([\s\S]*<NutritionDialogPortal>[\s\S]*nutrition-plan-delete-dialog[\s\S]*<\/NutritionDialogPortal>/,
  );
  assert.match(plans, /const dialogMode = draft \? "editor" : deletePlan \? "delete" : null/);
  assert.match(plans, /\}, \[dialogMode\]\);/);
  assert.doesNotMatch(plans, /\}, \[deletePlan, draft\]\);/);
  assert.match(preview, /nutrition\.preview\.more/);
  assert.match(preview, /partial \? "≥"/);
  assert.match(plans, /x-idempotency-key/);
  assert.match(planRoute, /nutritionMealPlans/);
  assert.match(planRoute, /nutritionMealPlanItems/);
  assert.match(planRoute, /scheduledDates must contain between 1 and 14 dates/);
  assert.match(planRoute, /scheduledDates\.map/);
  assert.match(
    planRoute,
    /db\.transaction\(async \(tx\) => \{[\s\S]*for \(const rows of planChunks\)[\s\S]*tx\.insert\(nutritionMealPlans\)[\s\S]*for \(const rows of itemChunks\)[\s\S]*tx\.insert\(nutritionMealPlanItems\)[\s\S]*for \(const rows of auditChunks\)[\s\S]*tx\.insert\(auditLog\)/,
  );
  assert.match(planRoute, /plan\.scheduledDate > today/);
  assert.match(planRoute, /tx\.insert\(nutritionMeals\)/);
  assert.match(planRoute, /operation: "void_from_plan"/);
  assert.doesNotMatch(nutrition, /nutritionMealPlans|nutritionMealPlanItems/);
  assert.match(revisionRoute, /'nutrition_plan'/);
  assert.match(styles, /\.nutrition-plan-consume \{[\s\S]*?min-height: 44px/);
  assert.match(styles, /\.nutrition-pane-switch button \{[\s\S]*?min-height: 44px/);
  assert.match(styles, /\.nutrition-plan-editor-meta \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(min-width: 520px\) \{[\s\S]*?\.nutrition-plan-editor-meta/);
  assert.match(
    styles,
    /\.nutrition-plan-editor-meta input\[type="date"\] \{[\s\S]*?inline-size: 100%;[\s\S]*?min-inline-size: 0;[\s\S]*?max-inline-size: 100%;[\s\S]*?line-height: 42px;[\s\S]*?-webkit-appearance: none;/,
  );
  assert.match(
    styles,
    /\.nutrition-plan-editor-meta input\[type="date"\]::-webkit-date-and-time-value \{[\s\S]*?height: 100%;[\s\S]*?min-width: 0;[\s\S]*?line-height: inherit;[\s\S]*?text-align: left;/,
  );
  assert.match(
    styles,
    /\.nutrition-sheet-body \{[\s\S]*?min-height: 0;[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;[\s\S]*?touch-action: pan-y;[\s\S]*?-webkit-overflow-scrolling: touch;/,
  );
  assert.match(
    quickRecord,
    /\{open \? \([\s\S]*?<NutritionDialogPortal>[\s\S]*?nutrition-dialog-backdrop[\s\S]*?<\/NutritionDialogPortal>/,
  );
  assert.match(quickRecord, /sheetBodyRef\.current\.scrollTop = 0/);
  assert.match(quickRecord, /<div ref=\{sheetBodyRef\} className="nutrition-sheet-body">/);
  assert.match(
    styles,
    /\.nutrition-plan-editor \{[\s\S]*?min-width: 0;[\s\S]*?max-width: 100%;/,
  );
  assert.doesNotMatch(plans, /正式入帳|待確認狀態|確認前不計入/);
});
