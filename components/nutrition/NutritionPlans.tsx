"use client";

import {
  CalendarBlank,
  Check,
  DotsThree,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/components/i18n/I18nProvider";
import type {
  Nutrients,
  NutritionDayData,
  NutritionFood,
} from "@/lib/nutrition";
import type {
  NutritionMealPlanItemView,
  NutritionMealPlanView,
} from "@/lib/nutrition-plans";
import { clientUuid } from "@/lib/client-id";
import { calculateNutrientPreview } from "@/lib/nutrition-preview";
import {
  NutritionDetailPreview,
  NutritionMacroStrip,
} from "@/components/nutrition/NutritionPreview";

type MealType = NutritionMealPlanView["mealType"];
type MealSlot = MealType | "post_workout";

const slotValues: MealSlot[] = [
  "breakfast",
  "lunch",
  "snack",
  "post_workout",
  "dinner",
  "late_night",
  "other",
];

type DraftItem = {
  key: string;
  planItemId: string | null;
  foodId: string | null;
  name: string;
  quantity: string;
  rawUnit: string;
  nutrientQuantity: number;
  nutrients: Nutrients;
  approximate: boolean;
};

type PlanDraft = {
  kind: "create" | "edit";
  planId: string | null;
  versionNo: number | null;
  scheduledDate: string;
  portions: string;
  slot: MealSlot;
  items: DraftItem[];
};

type PlanCounts = {
  today: number;
  prep: number;
};

type UndoRecord = {
  planId: string;
  expectedVersionNo: number;
};

function slotFromPlan(plan: NutritionMealPlanView): MealSlot {
  return plan.contextTag === "post_workout" ? "post_workout" : plan.mealType;
}

function mealSlotPayload(slot: MealSlot) {
  if (slot === "post_workout") {
    return {
      mealType: "other" as const,
      contextTag: "post_workout",
      originalMealType: null,
    };
  }
  return { mealType: slot, contextTag: null, originalMealType: null };
}

function displayMeasure(quantity: number, unit: string) {
  if (unit.toLocaleLowerCase("en") === "100g") {
    return { quantity: quantity * 100, unit: "g" };
  }
  return { quantity, unit };
}

function rawMeasure(quantity: string, unit: string) {
  const value = Number(quantity);
  return unit.toLocaleLowerCase("en") === "100g" ? value / 100 : value;
}

function quantityText(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateLabel(
  value: string | null,
  today: string,
  formatDate: ReturnType<typeof useI18n>["formatDate"],
  t: ReturnType<typeof useI18n>["t"],
) {
  if (!value) return t("nutrition.plan.date.unscheduled");
  if (value === today) return t("nutrition.plan.date.today");
  if (value === shiftDate(today, 1)) {
    return t("nutrition.plan.date.tomorrow");
  }
  const showYear = value.slice(0, 4) !== today.slice(0, 4);
  return formatDate(value, {
    ...(showYear ? { year: "numeric" as const } : {}),
    month: "numeric",
    day: "numeric",
  });
}

function planIsEstimated(plan: NutritionMealPlanView) {
  return (
    plan.confidence !== "high" ||
    plan.items.some(
      (item) =>
        item.confidence !== "high" || item.dataQualityFlags?.includes("estimated"),
    )
  );
}

function previewFromPlan(plan: NutritionMealPlanView) {
  return calculateNutrientPreview(
    plan.items.map((item) => ({ nutrients: item.nutrients, multiplier: 1 })),
  );
}

function draftFromPlan(plan: NutritionMealPlanView): PlanDraft {
  return {
    kind: "edit",
    planId: plan.planId,
    versionNo: plan.versionNo,
    scheduledDate: plan.scheduledDate ?? "",
    portions: "1",
    slot: slotFromPlan(plan),
    items: plan.items.map((item) => {
      const measure = displayMeasure(item.quantity, item.unit);
      return {
        key: item.planItemId,
        planItemId: item.planItemId,
        foodId: item.foodId,
        name: item.name,
        quantity: quantityText(measure.quantity),
        rawUnit: item.unit,
        nutrientQuantity: item.quantity,
        nutrients: item.nutrients,
        approximate:
          plan.confidence !== "high" ||
          item.confidence !== "high" ||
          item.dataQualityFlags?.includes("estimated") === true,
      };
    }),
  };
}

function newPlanDraft(today: string): PlanDraft {
  return {
    kind: "create",
    planId: null,
    versionNo: null,
    scheduledDate: shiftDate(today, 1),
    portions: "1",
    slot: "lunch",
    items: [],
  };
}

function planSummary(plan: NutritionMealPlanView) {
  return plan.items
    .map((item) => {
      const measure = displayMeasure(item.quantity, item.unit);
      return `${item.name} ${quantityText(measure.quantity)}${measure.unit}`;
    })
    .join(" · ");
}

class NutritionPlanRequestError extends Error {}

function NutritionDialogPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

async function readJson(response: Response) {
  const result = (await response.json()) as {
    [key: string]: unknown;
  };
  if (!response.ok) throw new NutritionPlanRequestError();
  return result;
}

function requestError(_error: unknown, fallback: string) {
  return fallback;
}

export function NutritionPlans({
  mode,
  showToday,
  today,
  refreshKey,
  onCountsChange,
  onNutritionUpdated,
  onRefresh,
  onError,
}: {
  mode: "record" | "prep";
  showToday: boolean;
  today: string;
  refreshKey: number;
  onCountsChange: (counts: PlanCounts) => void;
  onNutritionUpdated: (nutrition: NutritionDayData) => void;
  onRefresh: () => void;
  onError: (message: string | null) => void;
}) {
  const { t, formatDate } = useI18n();
  const slotLabel = (slot: MealSlot) => t(`nutrition.meal.${slot}`);
  const [plans, setPlans] = useState<NutritionMealPlanView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [menuPlanId, setMenuPlanId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [deletePlan, setDeletePlan] = useState<NutritionMealPlanView | null>(
    null,
  );
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [foodQuery, setFoodQuery] = useState("");
  const [foodResults, setFoodResults] = useState<NutritionFood[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoRecord | null>(null);
  const modalRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const menuButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const foodSearchSequence = useRef(0);
  const toastTimer = useRef<number | null>(null);

  const groupedPlans = useMemo(() => {
    const todayPlans: NutritionMealPlanView[] = [];
    const overduePlans: NutritionMealPlanView[] = [];
    const futurePlans: NutritionMealPlanView[] = [];
    const undatedPlans: NutritionMealPlanView[] = [];

    for (const plan of plans) {
      if (plan.scheduledDate === today) todayPlans.push(plan);
      else if (plan.scheduledDate === null) undatedPlans.push(plan);
      else if (plan.scheduledDate < today) overduePlans.push(plan);
      else futurePlans.push(plan);
    }
    overduePlans.sort((left, right) =>
      (right.scheduledDate ?? "").localeCompare(left.scheduledDate ?? ""),
    );
    return { todayPlans, overduePlans, futurePlans, undatedPlans };
  }, [plans, today]);

  const draftPreview = useMemo(
    () =>
      calculateNutrientPreview(
        (draft?.items ?? []).map((item) => {
          const enteredQuantity = rawMeasure(item.quantity, item.rawUnit);
          return {
            nutrients: item.nutrients,
            multiplier:
              Number.isFinite(enteredQuantity) &&
              enteredQuantity > 0 &&
              item.nutrientQuantity > 0
                ? enteredQuantity / item.nutrientQuantity
                : null,
          };
        }),
      ),
    [draft],
  );

  const draftIsEstimated =
    draft?.items.some((item) => item.approximate) ?? false;
  const dialogMode = draft ? "editor" : deletePlan ? "delete" : null;

  useEffect(() => {
    onCountsChange({
      today: groupedPlans.todayPlans.length,
      prep:
        groupedPlans.overduePlans.length +
        groupedPlans.futurePlans.length +
        groupedPlans.undatedPlans.length,
    });
  }, [groupedPlans, onCountsChange]);

  useEffect(() => {
    let active = true;
    void fetch("/api/nutrition/plans", { cache: "no-store" })
      .then(readJson)
      .then((result) => {
        if (active) setPlans(result.plans as NutritionMealPlanView[]);
      })
      .catch((error: unknown) => {
        if (!active) return;
        onError(requestError(error, t("nutrition.plan.error.load")));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onError, refreshKey, t]);

  useEffect(() => {
    if (!menuPlanId) return;
    const activeMenuPlanId = menuPlanId;
    function closeMenu(event: PointerEvent) {
      const target = event.target as Node;
      const button = menuButtonRefs.current.get(activeMenuPlanId);
      const popover = document.getElementById(
        `plan-menu-${activeMenuPlanId}`,
      );
      if (!button?.contains(target) && !popover?.contains(target)) {
        setMenuPlanId(null);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuPlanId(null);
      menuButtonRefs.current.get(activeMenuPlanId)?.focus();
    }
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuPlanId]);

  useEffect(() => {
    if (!draft) return;
    const sequence = ++foodSearchSequence.current;
    const query = foodQuery.trim();
    if (!query) return;
    const timer = window.setTimeout(() => {
      void fetch(
        `/api/nutrition/items?q=${encodeURIComponent(query)}&includeInactive=false`,
        { cache: "no-store" },
      )
        .then(readJson)
        .then((result) => {
          if (foodSearchSequence.current === sequence) {
            setFoodResults(result.items as NutritionFood[]);
          }
        })
        .catch(() => {
          if (foodSearchSequence.current === sequence) setFoodResults([]);
        });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draft, foodQuery]);

  useEffect(() => {
    if (!dialogMode) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => headingRef.current?.focus(), 0);

    function handleKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDraft(null);
        setDeletePlan(null);
        setInlineError(null);
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = [
        ...modalRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeys);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeys);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [dialogMode]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(message: string, undoRecord: UndoRecord | null) {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToastMessage(message);
    setUndo(undoRecord);
    toastTimer.current = window.setTimeout(
      () => {
        setToastMessage(null);
        setUndo(null);
        toastTimer.current = null;
      },
      undoRecord ? 8000 : 3500,
    );
  }

  function openEditor(plan: NutritionMealPlanView) {
    setMenuPlanId(null);
    setDraft(draftFromPlan(plan));
    setFoodQuery("");
    setFoodResults([]);
    setInlineError(null);
  }

  function openCreator() {
    setMenuPlanId(null);
    setDraft(newPlanDraft(today));
    setFoodQuery("");
    setFoodResults([]);
    setInlineError(null);
  }

  function addFood(food: NutritionFood) {
    if (!draft || draft.items.some((item) => item.foodId === food.foodId)) return;
    const measure = displayMeasure(food.baseQuantity, food.defaultUnit);
    setDraft({
      ...draft,
      items: [
        ...draft.items,
        {
          key: `${food.foodId}|${clientUuid()}`,
          planItemId: null,
          foodId: food.foodId,
          name: food.displayName,
          quantity: quantityText(measure.quantity),
          rawUnit: food.defaultUnit,
          nutrientQuantity: food.baseQuantity,
          nutrients: food.nutrients,
          approximate: false,
        },
      ],
    });
    setFoodQuery("");
    setFoodResults([]);
  }

  async function savePlan(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!draft.scheduledDate) {
      setInlineError(t("nutrition.plan.error.date"));
      return;
    }
    if (!draft.items.length) {
      setInlineError(t("nutrition.plan.error.items"));
      return;
    }
    const portionCount = Number(draft.portions);
    if (
      draft.kind === "create" &&
      (!Number.isInteger(portionCount) || portionCount < 1 || portionCount > 14)
    ) {
      setInlineError(t("nutrition.plan.error.portions"));
      return;
    }
    const items = draft.items.map((item) => ({
      ...(item.planItemId
        ? { planItemId: item.planItemId }
        : { foodId: item.foodId }),
      quantity: rawMeasure(item.quantity, item.rawUnit),
    }));
    if (
      items.some(
        (item) =>
          !Number.isFinite(item.quantity) || item.quantity <= 0,
      )
    ) {
      setInlineError(t("nutrition.plan.error.quantity"));
      return;
    }

    const busyKey = draft.kind === "create" ? "create" : `save:${draft.planId}`;
    setBusy(busyKey);
    setInlineError(null);
    try {
      const creating = draft.kind === "create";
      const response = await fetch("/api/nutrition/plans", {
        method: creating ? "POST" : "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          ...(creating
            ? {
                scheduledDates: Array.from(
                  { length: portionCount },
                  (_, index) => shiftDate(draft.scheduledDate, index),
                ),
                source: "site_batch_plan",
              }
            : {
                action: "revise",
                planId: draft.planId,
                expectedVersionNo: draft.versionNo,
                scheduledDate: draft.scheduledDate,
              }),
          ...mealSlotPayload(draft.slot),
          items,
        }),
      });
      const result = await readJson(response);
      setPlans(result.plans as NutritionMealPlanView[]);
      setDraft(null);
      showToast(
        creating
          ? t("nutrition.plan.created", { count: portionCount })
          : t("nutrition.plan.updated"),
        null,
      );
      onRefresh();
    } catch (error) {
      setInlineError(requestError(error, t("nutrition.error.save")));
    } finally {
      setBusy(null);
    }
  }

  async function consumePlan(plan: NutritionMealPlanView) {
    setBusy(`consume:${plan.planId}`);
    onError(null);
    try {
      const response = await fetch("/api/nutrition/plans", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          action: "consume",
          planId: plan.planId,
          expectedVersionNo: plan.versionNo,
        }),
      });
      const result = await readJson(response);
      setPlans(result.plans as NutritionMealPlanView[]);
      const nutrition = result.nutrition as NutritionDayData | null;
      if (nutrition?.localDate === today) onNutritionUpdated(nutrition);
      showToast(t("nutrition.plan.consumed", {
        slot: slotLabel(slotFromPlan(plan)),
      }), {
        planId: plan.planId,
        expectedVersionNo: result.versionNo as number,
      });
      onRefresh();
    } catch (error) {
      onError(requestError(error, t("nutrition.plan.error.consume")));
    } finally {
      setBusy(null);
    }
  }

  async function undoConsume() {
    if (!undo) return;
    setBusy(`undo:${undo.planId}`);
    try {
      const response = await fetch("/api/nutrition/plans", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          action: "undo_consume",
          planId: undo.planId,
          expectedVersionNo: undo.expectedVersionNo,
        }),
      });
      const result = await readJson(response);
      setPlans(result.plans as NutritionMealPlanView[]);
      const nutrition = result.nutrition as NutritionDayData | null;
      if (nutrition?.localDate === today) onNutritionUpdated(nutrition);
      showToast(t("nutrition.plan.undone"), null);
      onRefresh();
    } catch (error) {
      setToastMessage(null);
      setUndo(null);
      onError(requestError(error, t("nutrition.plan.error.undo")));
    } finally {
      setBusy(null);
    }
  }

  async function removePlan() {
    if (!deletePlan) return;
    setBusy(`delete:${deletePlan.planId}`);
    setInlineError(null);
    try {
      const response = await fetch("/api/nutrition/plans", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          planId: deletePlan.planId,
          expectedVersionNo: deletePlan.versionNo,
        }),
      });
      const result = await readJson(response);
      setPlans(result.plans as NutritionMealPlanView[]);
      setDeletePlan(null);
      showToast(t("nutrition.plan.deleted"), null);
      onRefresh();
    } catch (error) {
      setInlineError(requestError(error, t("nutrition.error.delete")));
    } finally {
      setBusy(null);
    }
  }

  function renderPlan(plan: NutritionMealPlanView, compact: boolean) {
    const slot = slotFromPlan(plan);
    return (
      <article
        className={`nutrition-plan-row${compact ? " is-compact" : " is-today"}`}
        key={plan.planId}
        aria-busy={busy?.endsWith(plan.planId) || undefined}
      >
        <header>
          <div className="nutrition-plan-title">
            <strong>
              {compact
                ? dateLabel(plan.scheduledDate, today, formatDate, t)
                : slotLabel(slot)}
            </strong>
            {compact ? <span>{slotLabel(slot)}</span> : null}
          </div>
          <div className="nutrition-plan-menu-wrap">
            <button
              ref={(node) => {
                if (node) menuButtonRefs.current.set(plan.planId, node);
                else menuButtonRefs.current.delete(plan.planId);
              }}
              type="button"
              className="nutrition-plan-menu-trigger"
              aria-label={t("nutrition.plan.moreActions", {
                date: dateLabel(plan.scheduledDate, today, formatDate, t),
                slot: slotLabel(slot),
              })}
              aria-expanded={menuPlanId === plan.planId}
              aria-controls={`plan-menu-${plan.planId}`}
              onClick={() =>
                setMenuPlanId((current) =>
                  current === plan.planId ? null : plan.planId,
                )
              }
            >
              <DotsThree size={22} weight="bold" aria-hidden="true" />
            </button>
            {menuPlanId === plan.planId ? (
              <div
                className="nutrition-plan-menu"
                id={`plan-menu-${plan.planId}`}
              >
                {compact ? (
                  <button type="button" onClick={() => openEditor(plan)}>
                    <PencilSimple size={15} aria-hidden="true" />
                    {t("nutrition.action.edit")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => {
                    setMenuPlanId(null);
                    setInlineError(null);
                    setDeletePlan(plan);
                  }}
                >
                  <Trash size={15} aria-hidden="true" />
                  {t("nutrition.plan.deleteAction")}
                </button>
              </div>
            ) : null}
          </div>
        </header>
        {compact ? (
          <p className="nutrition-plan-summary">{planSummary(plan)}</p>
        ) : (
          <div className="nutrition-plan-items">
            {plan.items.map((item: NutritionMealPlanItemView) => {
              const measure = displayMeasure(item.quantity, item.unit);
              return (
                <div key={item.planItemId}>
                  <span>{item.name}</span>
                  <strong>
                    {quantityText(measure.quantity)} {measure.unit}
                  </strong>
                </div>
              );
            })}
          </div>
        )}
        <NutritionMacroStrip
          preview={previewFromPlan(plan)}
          approximate={planIsEstimated(plan)}
        />
        {!compact ? (
          <footer>
            <button
              type="button"
              className="nutrition-plan-edit"
              onClick={() => openEditor(plan)}
            >
              <PencilSimple size={15} aria-hidden="true" />
              {t("nutrition.action.edit")}
            </button>
            <button
              type="button"
              className="nutrition-plan-consume"
              disabled={busy === `consume:${plan.planId}`}
              onClick={() => void consumePlan(plan)}
            >
              <Check size={16} weight="bold" aria-hidden="true" />
              {busy === `consume:${plan.planId}`
                ? t("nutrition.plan.logging")
                : t("nutrition.plan.consumedAction")}
            </button>
          </footer>
        ) : null}
      </article>
    );
  }

  if (loading) return <div className="skeleton nutrition-plans-skeleton" />;

  const prepGroups = [
    {
      key: "overdue",
      label: t("nutrition.plan.group.overdue"),
      plans: groupedPlans.overduePlans,
    },
    {
      key: "future",
      label: t("nutrition.plan.group.future"),
      plans: groupedPlans.futurePlans,
    },
    {
      key: "undated",
      label: t("nutrition.plan.date.unscheduled"),
      plans: groupedPlans.undatedPlans,
    },
  ].filter((group) => group.plans.length > 0);
  const visibleTodayPlans = showToday ? groupedPlans.todayPlans : [];

  return (
    <>
      {mode === "record" && visibleTodayPlans.length ? (
        <section className="nutrition-plans" aria-labelledby="nutrition-plans-title">
          <header className="nutrition-section-heading">
            <div>
              <h2 id="nutrition-plans-title">
                {t("nutrition.plan.pending")}
              </h2>
              <span>
                {t("nutrition.count.meals", {
                  count: visibleTodayPlans.length,
                })}
              </span>
            </div>
          </header>
          <div className="nutrition-plan-list">
            {visibleTodayPlans.map((plan) => renderPlan(plan, false))}
          </div>
        </section>
      ) : null}

      {mode === "prep" ? (
        <section className="nutrition-prep" aria-labelledby="nutrition-prep-title">
          <header className="nutrition-prep-header">
            <div>
              <h2 id="nutrition-prep-title">{t("nutrition.plan.prep")}</h2>
              <span>
                {t("nutrition.count.meals", {
                  count: prepGroups.reduce(
                    (total, group) => total + group.plans.length,
                    0,
                  ),
                })}
              </span>
            </div>
            <button type="button" onClick={openCreator}>
              <Plus size={16} weight="bold" aria-hidden="true" />
              {t("nutrition.action.add")}
            </button>
          </header>
          {prepGroups.length ? (
            <div className="nutrition-prep-groups">
              {prepGroups.map((group) => (
                <section className="nutrition-plan-group" key={group.key}>
                  <header className="nutrition-plan-group-heading">
                    <h3>{group.label}</h3>
                    <span>{group.plans.length}</span>
                  </header>
                  <div className="nutrition-plan-list">
                    {group.plans.map((plan) => renderPlan(plan, true))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="nutrition-prep-empty">
              <CalendarBlank size={24} aria-hidden="true" />
              <p>{t("nutrition.plan.empty")}</p>
            </div>
          )}
        </section>
      ) : null}

      {toastMessage ? (
        <div className="nutrition-undo-toast" role="status" aria-live="polite">
          <Check size={17} weight="bold" aria-hidden="true" />
          <span>{toastMessage}</span>
          {undo ? (
            <button
              type="button"
              onClick={() => void undoConsume()}
              disabled={busy === `undo:${undo.planId}`}
            >
              {busy === `undo:${undo.planId}`
                ? t("nutrition.plan.undoing")
                : t("nutrition.plan.undo")}
            </button>
          ) : null}
        </div>
      ) : null}

      {draft ? (
        <NutritionDialogPortal>
        <div
          className="nutrition-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setDraft(null);
          }}
        >
          <section
            ref={modalRef}
            className="nutrition-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-editor-title"
          >
            <header className="nutrition-sheet-header">
              <span className="sheet-header-spacer" />
              <div>
                <h2 id="plan-editor-title" ref={headingRef} tabIndex={-1}>
                  {draft.kind === "create"
                    ? t("nutrition.plan.createTitle")
                    : t("nutrition.plan.editTitle")}
                </h2>
              </div>
              <button
                type="button"
                aria-label={t("nutrition.action.close")}
                onClick={() => setDraft(null)}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>
            <div className="nutrition-sheet-body">
              <form className="nutrition-plan-editor" onSubmit={savePlan}>
                {inlineError ? (
                  <div className="library-inline-error" role="alert">
                    {inlineError}
                  </div>
                ) : null}
                <div className="nutrition-plan-editor-meta">
                  <label className="field-block">
                    <span>
                      {draft.kind === "create"
                        ? t("nutrition.plan.firstDate")
                        : t("nutrition.plan.date")}
                    </span>
                    <input
                      type="date"
                      value={draft.scheduledDate}
                      onChange={(event) =>
                        setDraft({ ...draft, scheduledDate: event.target.value })
                      }
                      required
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("nutrition.plan.mealSlot")}</span>
                    <select
                      value={draft.slot}
                      onChange={(event) =>
                        setDraft({ ...draft, slot: event.target.value as MealSlot })
                      }
                    >
                      {slotValues.map((value) => (
                        <option key={value} value={value}>
                          {slotLabel(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {draft.kind === "create" ? (
                  <label className="field-block nutrition-plan-portions">
                    <span>{t("nutrition.plan.consecutiveDays")}</span>
                    <span>
                      <input
                        type="number"
                        min="1"
                        max="14"
                        step="1"
                        inputMode="numeric"
                        value={draft.portions}
                        onChange={(event) =>
                          setDraft({ ...draft, portions: event.target.value })
                        }
                        required
                      />
                      <small>{t("nutrition.plan.consecutiveHint")}</small>
                    </span>
                  </label>
                ) : null}

                <section className="nutrition-plan-editor-items">
                  <header>
                    <h3>{t("nutrition.plan.contents")}</h3>
                    <span>
                      {t("nutrition.count.items", {
                        count: draft.items.length,
                      })}
                    </span>
                  </header>
                  {draft.items.map((item) => {
                    const displayUnit = displayMeasure(1, item.rawUnit).unit;
                    return (
                      <div className="nutrition-plan-editor-item" key={item.key}>
                        <span>{item.name}</span>
                        <label>
                          <span className="sr-only">
                            {t("nutrition.field.quantityNamed", {
                              name: item.name,
                            })}
                          </span>
                          <input
                            type="number"
                            min="0.001"
                            max="100000"
                            step="any"
                            inputMode="decimal"
                            value={item.quantity}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                items: draft.items.map((candidate) =>
                                  candidate.key === item.key
                                    ? { ...candidate, quantity: event.target.value }
                                    : candidate,
                                ),
                              })
                            }
                            required
                          />
                          <small>{displayUnit}</small>
                        </label>
                        <button
                          type="button"
                          aria-label={t("nutrition.action.removeNamed", {
                            name: item.name,
                          })}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              items: draft.items.filter(
                                (candidate) => candidate.key !== item.key,
                              ),
                            })
                          }
                        >
                          <Trash size={15} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </section>

                <NutritionDetailPreview
                  preview={draftPreview}
                  contextLabel={t("nutrition.plan.thisMeal")}
                  approximate={draftIsEstimated}
                />

                <label className="field-block">
                  <span>{t("nutrition.plan.addFood")}</span>
                  <span className="search-input-wrap">
                    <MagnifyingGlass size={17} aria-hidden="true" />
                    <input
                      value={foodQuery}
                      onChange={(event) => setFoodQuery(event.target.value)}
                      placeholder={t("nutrition.plan.searchFood")}
                      autoComplete="off"
                    />
                  </span>
                </label>
                {foodQuery.trim() && foodResults.length ? (
                  <div className="nutrition-plan-food-results">
                    {foodResults.slice(0, 20).map((food) => {
                      const selected = draft.items.some(
                        (item) => item.foodId === food.foodId,
                      );
                      return (
                        <button
                          type="button"
                          key={food.foodId}
                          disabled={selected}
                          onClick={() => addFood(food)}
                        >
                          <span>{food.displayName}</span>
                          <Plus size={15} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <footer className="nutrition-plan-editor-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setDraft(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={
                      busy ===
                      (draft.kind === "create" ? "create" : `save:${draft.planId}`)
                    }
                  >
                    {busy ===
                    (draft.kind === "create" ? "create" : `save:${draft.planId}`)
                      ? t("nutrition.plan.saving")
                      : draft.kind === "create"
                        ? t("nutrition.action.add")
                        : t("common.save")}
                  </button>
                </footer>
              </form>
            </div>
          </section>
        </div>
        </NutritionDialogPortal>
      ) : null}

      {deletePlan ? (
        <NutritionDialogPortal>
        <div
          className="nutrition-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setDeletePlan(null);
          }}
        >
          <section
            ref={modalRef}
            className="nutrition-plan-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plan-delete-title"
          >
            <h2 id="plan-delete-title" ref={headingRef} tabIndex={-1}>
              {t("nutrition.plan.deleteTitle")}
            </h2>
            {inlineError ? (
              <div className="library-inline-error" role="alert">
                {inlineError}
              </div>
            ) : null}
            <div>
              <button type="button" onClick={() => setDeletePlan(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="is-danger"
                disabled={busy === `delete:${deletePlan.planId}`}
                onClick={() => void removePlan()}
              >
                {busy === `delete:${deletePlan.planId}`
                  ? t("nutrition.action.deleting")
                  : t("nutrition.action.delete")}
              </button>
            </div>
          </section>
        </div>
        </NutritionDialogPortal>
      ) : null}
    </>
  );
}
