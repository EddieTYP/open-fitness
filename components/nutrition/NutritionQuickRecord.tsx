"use client";

import {
  ArrowDown,
  ArrowUp,
  CaretLeft,
  Check,
  ForkKnife,
  Lightning,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import {
  useEffect,
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
  NutritionMealView,
} from "@/lib/nutrition";
import { clientUuid } from "@/lib/client-id";
import { MealLogForm } from "@/components/log/LogForms";
import { quickMealTiming } from "@/lib/nutrition-meal-timing";
import { timeInTimeZone } from "@/lib/timezone.mjs";
import {
  calculateNutrientPreview,
} from "@/lib/nutrition-preview";
import {
  NutritionDetailPreview,
  NutritionMacroStrip,
} from "@/components/nutrition/NutritionPreview";

type MealType = NutritionMealView["mealType"];
type MealSlot = Exclude<MealType, "other"> | "post_workout";
type SheetView =
  | "record"
  | "manual"
  | "food"
  | "combo"
  | "energy"
  | "combo-list"
  | "combo-editor";

type ComboIssue = {
  code: "inactive_food" | "missing_food" | "unit_changed";
  comboItemId: string;
  foodId: string;
  message: string;
};

type ComboItem = {
  comboItemId: string;
  itemOrdinal: number;
  foodId: string;
  displayName: string;
  defaultQuantity: number;
  unit: string;
  unitAtSave: string;
  baseQuantity: number | null;
  isActive: boolean;
  nutrients: Nutrients;
};

function NutritionDialogPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

type NutritionCombo = {
  comboId: string;
  displayName: string;
  isActive: boolean;
  versionNo: number;
  defaultMealType: MealType | null;
  contextTag: "post_workout" | null;
  items: ComboItem[];
  nutrients: Nutrients;
  isUsable: boolean;
  foodUpdated: boolean;
  issues: ComboIssue[];
};

type EditorItem = {
  key: string;
  foodId: string;
  displayName: string;
  quantity: string;
  unit: string;
  nutrientQuantity: number;
  nutrients: Nutrients;
};

type ComboEditor = {
  comboId: string | null;
  versionNo: number | null;
  displayName: string;
  slot: MealSlot;
  isActive: boolean;
  items: EditorItem[];
};

type UndoRecord = {
  mealId: string;
  expectedRevisionNo: number;
  label: string;
};

const slotValues: MealSlot[] = [
  "breakfast",
  "lunch",
  "snack",
  "post_workout",
  "dinner",
  "late_night",
];

function inferredSlot(timezone: string, now = new Date()): MealSlot {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 17 && hour < 22) return "dinner";
  if (hour >= 22 || hour < 5) return "late_night";
  return "snack";
}

function mealSlotPayload(slot: MealSlot) {
  if (slot === "post_workout") {
    return {
      mealType: "other" as const,
      contextTag: "post_workout",
      originalMealType: null,
    };
  }
  return {
    mealType: slot,
    contextTag: null,
    originalMealType: null,
  };
}

function slotFromMeal(meal: NutritionMealView): MealSlot {
  if (meal.contextTag === "post_workout") return "post_workout";
  return meal.mealType === "other" ? "snack" : meal.mealType;
}

function slotFromCombo(combo: NutritionCombo, fallback: MealSlot) {
  if (combo.contextTag === "post_workout") return "post_workout";
  if (combo.defaultMealType && combo.defaultMealType !== "other") {
    return combo.defaultMealType;
  }
  return fallback;
}

function displayMeasure(quantity: number, unit: string) {
  if (unit.toLowerCase() === "100g") {
    return { quantity: quantity * 100, unit: "g" };
  }
  return { quantity, unit };
}

function rawMeasure(quantity: string, unit: string) {
  const value = Number(quantity);
  return unit.toLowerCase() === "100g" ? value / 100 : value;
}

function quantityText(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function numberLabel(
  value: number | null,
  unit: string,
  formatNumber: ReturnType<typeof useI18n>["formatNumber"],
  noData: string,
  digits = 0,
) {
  if (value === null) return noData;
  return `${formatNumber(value, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })} ${unit}`;
}

function defaultComboPreview(combo: NutritionCombo) {
  return calculateNutrientPreview(
    combo.items.map((item) => ({ nutrients: item.nutrients, multiplier: 1 })),
  );
}

class NutritionQuickRequestError extends Error {}

async function readJson(response: Response) {
  const result = (await response.json()) as {
    [key: string]: unknown;
  };
  if (!response.ok) {
    throw new NutritionQuickRequestError();
  }
  return result;
}

function requestError(_error: unknown, fallback: string) {
  return fallback;
}

function emptyComboEditor(slot: MealSlot): ComboEditor {
  return {
    comboId: null,
    versionNo: null,
    displayName: "",
    slot,
    isActive: true,
    items: [],
  };
}

function editorFromCombo(combo: NutritionCombo, timezone: string): ComboEditor {
  return {
    comboId: combo.comboId,
    versionNo: combo.versionNo,
    displayName: combo.displayName,
    slot: slotFromCombo(combo, inferredSlot(timezone)),
    isActive: combo.isActive,
    items: combo.items.map((item) => {
      const rawQuantity =
        item.unitAtSave !== item.unit && item.baseQuantity !== null
          ? item.baseQuantity
          : item.defaultQuantity;
      const measure = displayMeasure(rawQuantity, item.unit);
      return {
        key: item.comboItemId,
        foodId: item.foodId,
        displayName: item.displayName,
        quantity: quantityText(measure.quantity),
        unit: item.unit,
        nutrientQuantity: rawQuantity,
        nutrients: item.nutrients,
      };
    }),
  };
}

export function NutritionQuickRecord({
  nutrition,
  timezone,
  showMealAction,
  showEnergyAction,
  draftMeal,
  onDraftConsumed,
  onUpdated,
  onOpenFoodLibrary,
  onError,
}: {
  nutrition: NutritionDayData;
  timezone: string;
  showMealAction: boolean;
  showEnergyAction: boolean;
  draftMeal: NutritionMealView | null;
  onDraftConsumed: () => void;
  onUpdated: (nutrition: NutritionDayData) => void;
  onOpenFoodLibrary: () => void;
  onError: (message: string | null) => void;
}) {
  const { t, formatNumber } = useI18n();
  const slotLabel = (value: MealSlot) => t(`nutrition.meal.${value}`);
  const comboIssueLabel = (issue: ComboIssue | undefined) =>
    issue
      ? t(`nutrition.quick.issue.${issue.code}`)
      : t("nutrition.quick.needsReview");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SheetView>("record");
  const [slot, setSlot] = useState<MealSlot>(() => inferredSlot(timezone));
  const [query, setQuery] = useState("");
  const [foodResults, setFoodResults] = useState<NutritionFood[]>([]);
  const [selectedFood, setSelectedFood] = useState<NutritionFood | null>(
    null,
  );
  const [foodQuantity, setFoodQuantity] = useState("");
  const [combos, setCombos] = useState<NutritionCombo[]>([]);
  const [selectedCombo, setSelectedCombo] =
    useState<NutritionCombo | null>(null);
  const [comboQuantities, setComboQuantities] = useState<
    Record<string, string>
  >({});
  const [comboEditor, setComboEditor] = useState<ComboEditor>(() =>
    emptyComboEditor(inferredSlot(timezone)),
  );
  const [editorFoodQuery, setEditorFoodQuery] = useState("");
  const [editorFoodResults, setEditorFoodResults] = useState<
    NutritionFood[]
  >([]);
  const [activeEnergy, setActiveEnergy] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoRecord | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const sheetBodyRef = useRef<HTMLDivElement | null>(null);
  const searchSequence = useRef(0);
  const editorSearchSequence = useRef(0);
  const undoTimer = useRef<number | null>(null);

  async function loadCombos(includeInactive = false) {
    const response = await fetch(
      `/api/nutrition/combos?includeInactive=${includeInactive}`,
      { cache: "no-store" },
    );
    const result = await readJson(response);
    const nextCombos = result.combos as NutritionCombo[];
    setCombos(nextCombos);
    return nextCombos;
  }

  function showToast(message: string, undoRecord: UndoRecord | null) {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    setToastMessage(message);
    setUndo(undoRecord);
    undoTimer.current = window.setTimeout(() => {
      setToastMessage(null);
      setUndo(null);
      undoTimer.current = null;
    }, 8000);
  }

  function openSheet(nextView: SheetView) {
    onError(null);
    setInlineError(null);
    setView(nextView);
    setOpen(true);
    if (nextView === "record") {
      setSlot(inferredSlot(timezone));
      setQuery("");
      setFoodResults([]);
      void loadCombos(false).catch(() => setCombos([]));
    } else if (nextView === "combo-list") {
      void loadCombos(true).catch((error: unknown) =>
        setInlineError(
          requestError(error, t("nutrition.quick.error.loadCombos")),
        ),
      );
    }
  }

  function closeSheet() {
    setOpen(false);
    setInlineError(null);
  }

  useEffect(() => {
    return () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!draftMeal) return;
    const timer = window.setTimeout(() => {
      if (
        draftMeal.items.length === 0 ||
        draftMeal.items.some(
          (item) =>
            !item.foodId ||
            item.quantity === null ||
            item.quantity <= 0 ||
            !item.unit,
        )
      ) {
        onError(t("nutrition.quick.error.libraryOnly"));
        onDraftConsumed();
        return;
      }
      const draftSlot = slotFromMeal(draftMeal);
      setComboEditor({
        comboId: null,
        versionNo: null,
        displayName: draftMeal.items.map((item) => item.name).join("＋"),
        slot: draftSlot,
        isActive: true,
        items: draftMeal.items.map((item) => {
          const measure = displayMeasure(item.quantity!, item.unit!);
          return {
            key: item.mealItemId,
            foodId: item.foodId!,
            displayName: item.name,
            quantity: quantityText(measure.quantity),
            unit: item.unit!,
            nutrientQuantity: item.quantity!,
            nutrients: item.nutrients,
          };
        }),
      });
      setEditorFoodQuery("");
      setEditorFoodResults([]);
      setInlineError(null);
      setView("combo-editor");
      setOpen(true);
      onDraftConsumed();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftMeal, onDraftConsumed, onError, t]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => headingRef.current?.focus(), 0);

    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSheet();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      ];
      if (focusable.length === 0) return;
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

    document.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleDialogKeys);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !sheetBodyRef.current) return;
    sheetBodyRef.current.scrollTop = 0;
  }, [open, view]);

  useEffect(() => {
    if (!open || view !== "record") return;
    const sequence = ++searchSequence.current;
    const trimmed = query.trim();
    if (!trimmed) return;
    const timeout = window.setTimeout(() => {
      void fetch(
        `/api/nutrition/items?q=${encodeURIComponent(trimmed)}&includeInactive=false`,
        { cache: "no-store" },
      )
        .then(readJson)
        .then((result) => {
          if (searchSequence.current === sequence) {
            setFoodResults(result.items as NutritionFood[]);
          }
        })
        .catch(() => {
          if (searchSequence.current === sequence) setFoodResults([]);
        });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [open, query, view]);

  useEffect(() => {
    if (!open || view !== "combo-editor") return;
    const sequence = ++editorSearchSequence.current;
    const trimmed = editorFoodQuery.trim();
    if (!trimmed) return;
    const timeout = window.setTimeout(() => {
      void fetch(
        `/api/nutrition/items?q=${encodeURIComponent(trimmed)}&includeInactive=false`,
        { cache: "no-store" },
      )
        .then(readJson)
        .then((result) => {
          if (editorSearchSequence.current === sequence) {
            setEditorFoodResults(result.items as NutritionFood[]);
          }
        })
        .catch(() => {
          if (editorSearchSequence.current === sequence) {
            setEditorFoodResults([]);
          }
        });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [editorFoodQuery, open, view]);

  function chooseFood(food: NutritionFood) {
    const measure = displayMeasure(food.baseQuantity, food.defaultUnit);
    setSelectedFood(food);
    setFoodQuantity(quantityText(measure.quantity));
    setInlineError(null);
    setView("food");
  }

  function chooseCombo(combo: NutritionCombo) {
    setSelectedCombo(combo);
    setSlot((current) => slotFromCombo(combo, current));
    setComboQuantities(
      Object.fromEntries(
        combo.items.map((item) => {
          const measure = displayMeasure(item.defaultQuantity, item.unit);
          return [item.comboItemId, quantityText(measure.quantity)];
        }),
      ),
    );
    setInlineError(null);
    setView("combo");
  }

  async function submitFood(event: FormEvent) {
    event.preventDefault();
    if (!selectedFood) return;
    const rawQuantity = rawMeasure(foodQuantity, selectedFood.defaultUnit);
    if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
      setInlineError(t("nutrition.error.invalidQuantity"));
      return;
    }
    setBusy("food-add");
    setInlineError(null);
    try {
      const now = new Date();
      const response = await fetch("/api/nutrition/meals", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          localDate: nutrition.localDate,
          ...quickMealTiming(nutrition.localDate, timezone, now),
          ...mealSlotPayload(slot),
          source: "site_quick_add",
          confidence: "high",
          items: [{ foodId: selectedFood.foodId, quantity: rawQuantity }],
        }),
      });
      const result = await readJson(response);
      onUpdated(result.nutrition as NutritionDayData);
      closeSheet();
      showToast(
        t("nutrition.quick.added", {
          slot: slotLabel(slot),
          name: selectedFood.displayName,
        }),
        {
          mealId: result.mealId as string,
          expectedRevisionNo: result.revisionNo as number,
          label: selectedFood.displayName,
        },
      );
    } catch (error) {
      setInlineError(requestError(error, t("nutrition.quick.error.addFood")));
    } finally {
      setBusy(null);
    }
  }

  async function submitCombo(event: FormEvent) {
    event.preventDefault();
    if (!selectedCombo) return;
    const overrides = selectedCombo.items.map((item) => ({
      comboItemId: item.comboItemId,
      quantity: rawMeasure(comboQuantities[item.comboItemId] || "", item.unit),
    }));
    if (
      overrides.some(
        (override) =>
          !Number.isFinite(override.quantity) || override.quantity <= 0,
      )
    ) {
      setInlineError(t("nutrition.plan.error.quantity"));
      return;
    }
    setBusy("combo-add");
    setInlineError(null);
    try {
      const now = new Date();
      const response = await fetch("/api/nutrition/meals", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          localDate: nutrition.localDate,
          ...quickMealTiming(nutrition.localDate, timezone, now),
          ...mealSlotPayload(slot),
          source: "site_combo",
          confidence: "high",
          combo: {
            comboId: selectedCombo.comboId,
            expectedVersionNo: selectedCombo.versionNo,
            quantityOverrides: overrides,
          },
        }),
      });
      const result = await readJson(response);
      onUpdated(result.nutrition as NutritionDayData);
      closeSheet();
      showToast(
        t("nutrition.quick.added", {
          slot: slotLabel(slot),
          name: selectedCombo.displayName,
        }),
        {
          mealId: result.mealId as string,
          expectedRevisionNo: result.revisionNo as number,
          label: selectedCombo.displayName,
        },
      );
    } catch (error) {
      setInlineError(requestError(error, t("nutrition.quick.error.addCombo")));
    } finally {
      setBusy(null);
    }
  }

  async function saveEnergy(event: FormEvent) {
    event.preventDefault();
    const value = Number(activeEnergy);
    if (!Number.isFinite(value) || value < 0) {
      setInlineError(t("nutrition.quick.error.energyRequired"));
      return;
    }
    setBusy("energy");
    setInlineError(null);
    try {
      const response = await fetch("/api/nutrition/energy", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          localDate: nutrition.localDate,
          observedAt: new Date().toISOString(),
          activeEnergyKcal: value,
          status: "provisional",
          source: "Open Fitness WebApp manual",
        }),
      });
      const result = await readJson(response);
      onUpdated(result.nutrition as NutritionDayData);
      setActiveEnergy("");
      closeSheet();
      showToast(
        t("nutrition.quick.energyUpdated", {
          value: formatNumber(value),
        }),
        null,
      );
    } catch (error) {
      setInlineError(requestError(error, t("nutrition.quick.error.energy")));
    } finally {
      setBusy(null);
    }
  }

  async function undoMeal() {
    if (!undo) return;
    setBusy("undo");
    try {
      const response = await fetch("/api/nutrition/meals", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          mealId: undo.mealId,
          deleteMeal: true,
          expectedRevisionNo: undo.expectedRevisionNo,
          revisionReason: "Quick Add undo",
        }),
      });
      const result = await readJson(response);
      onUpdated(result.nutrition as NutritionDayData);
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
      setUndo(null);
      setToastMessage(t("nutrition.quick.restored", { name: undo.label }));
      undoTimer.current = window.setTimeout(() => {
        setToastMessage(null);
        undoTimer.current = null;
      }, 3500);
    } catch (error) {
      setToastMessage(null);
      setUndo(null);
      onError(requestError(error, t("nutrition.quick.error.undo")));
    } finally {
      setBusy(null);
    }
  }

  function openComboEditor(combo?: NutritionCombo) {
    setComboEditor(
      combo ? editorFromCombo(combo, timezone) : emptyComboEditor(slot),
    );
    setEditorFoodQuery("");
    setEditorFoodResults([]);
    setInlineError(
      combo?.issues[0] ? comboIssueLabel(combo.issues[0]) : null,
    );
    setView("combo-editor");
  }

  function addEditorFood(food: NutritionFood) {
    if (comboEditor.items.some((item) => item.foodId === food.foodId)) {
      setInlineError(t("nutrition.quick.error.duplicateFood"));
      return;
    }
    const measure = displayMeasure(food.baseQuantity, food.defaultUnit);
    setComboEditor((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          key: `${food.foodId}|${clientUuid()}`,
          foodId: food.foodId,
          displayName: food.displayName,
          quantity: quantityText(measure.quantity),
          unit: food.defaultUnit,
          nutrientQuantity: food.baseQuantity,
          nutrients: food.nutrients,
        },
      ],
    }));
    setEditorFoodQuery("");
    setEditorFoodResults([]);
    setInlineError(null);
  }

  function moveEditorItem(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= comboEditor.items.length) return;
    setComboEditor((current) => {
      const items = [...current.items];
      [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
      return { ...current, items };
    });
  }

  async function saveCombo(event: FormEvent) {
    event.preventDefault();
    const displayName = comboEditor.displayName.trim();
    if (!displayName) {
      setInlineError(t("nutrition.quick.error.comboName"));
      return;
    }
    if (comboEditor.items.length === 0) {
      setInlineError(t("nutrition.quick.error.comboItems"));
      return;
    }
    const items = comboEditor.items.map((item) => ({
      foodId: item.foodId,
      quantity: rawMeasure(item.quantity, item.unit),
    }));
    if (
      items.some(
        (item) => !Number.isFinite(item.quantity) || item.quantity <= 0,
      )
    ) {
      setInlineError(t("nutrition.plan.error.quantity"));
      return;
    }
    setBusy("combo-save");
    setInlineError(null);
    try {
      const slotPayload = mealSlotPayload(comboEditor.slot);
      const response = await fetch("/api/nutrition/combos", {
        method: comboEditor.comboId ? "PATCH" : "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          ...(comboEditor.comboId
            ? {
                comboId: comboEditor.comboId,
                action: "revise",
                expectedVersionNo: comboEditor.versionNo,
              }
            : {}),
          displayName,
          defaultMealType: slotPayload.mealType,
          contextTag: slotPayload.contextTag,
          revisionReason: comboEditor.comboId
            ? "Site combo revision"
            : "Initial combo",
          items,
        }),
      });
      await readJson(response);
      await loadCombos(true);
      setView("combo-list");
      setToastMessage(t("nutrition.quick.comboSaved", { name: displayName }));
      setUndo(null);
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => {
        setToastMessage(null);
        undoTimer.current = null;
      }, 3500);
    } catch (error) {
      setInlineError(requestError(error, t("nutrition.quick.error.comboSave")));
    } finally {
      setBusy(null);
    }
  }

  async function toggleComboActive() {
    if (!comboEditor.comboId) return;
    setBusy("combo-status");
    setInlineError(null);
    try {
      const response = await fetch("/api/nutrition/combos", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          comboId: comboEditor.comboId,
          action: comboEditor.isActive ? "deactivate" : "reactivate",
        }),
      });
      const result = await readJson(response);
      const saved = result.combo as NutritionCombo;
      setComboEditor(editorFromCombo(saved, timezone));
      await loadCombos(true);
    } catch (error) {
      setInlineError(requestError(error, t("nutrition.quick.error.comboState")));
    } finally {
      setBusy(null);
    }
  }

  function sheetTitle() {
    if (view === "energy") return t("nutrition.quick.title.energy");
    if (view === "manual") return t("nutrition.quick.title.manual");
    if (view === "food") return t("nutrition.quick.title.food");
    if (view === "combo") return t("nutrition.quick.title.combo");
    if (view === "combo-list") return t("nutrition.quick.title.comboList");
    if (view === "combo-editor") {
      return comboEditor.comboId
        ? t("nutrition.quick.title.comboEdit")
        : t("nutrition.quick.title.comboNew");
    }
    return t("nutrition.quick.title.record");
  }

  function goBack() {
    setInlineError(null);
    if (
      view === "food" ||
      view === "combo" ||
      view === "combo-list" ||
      view === "manual"
    ) {
      setView("record");
      void loadCombos(false).catch(() => setCombos([]));
      return;
    }
    if (view === "combo-editor") {
      setView("combo-list");
      void loadCombos(true).catch(() => setCombos([]));
      return;
    }
    closeSheet();
  }

  const filteredCombos = combos.filter((combo) => {
    if (view === "combo-list") return true;
    const term = query.trim().normalize("NFKC").toLowerCase();
    return (
      combo.isActive &&
      (!term ||
        combo.displayName.normalize("NFKC").toLowerCase().includes(term))
    );
  });

  const selectedComboPreview = selectedCombo
    ? calculateNutrientPreview(
        selectedCombo.items.map((item) => {
          const enteredQuantity = rawMeasure(
            comboQuantities[item.comboItemId] ?? "",
            item.unit,
          );
          return {
            nutrients: item.nutrients,
            multiplier:
              Number.isFinite(enteredQuantity) &&
              enteredQuantity > 0 &&
              item.defaultQuantity > 0
                ? enteredQuantity / item.defaultQuantity
                : null,
          };
        }),
      )
    : calculateNutrientPreview([]);
  const comboEditorPreview = calculateNutrientPreview(
    comboEditor.items.map((item) => {
      const enteredQuantity = rawMeasure(item.quantity, item.unit);
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
  );

  return (
    <>
      {showMealAction || showEnergyAction ? (
      <div
        className="nutrition-command-bar"
        aria-label={t("nutrition.quick.barLabel")}
      >
        {showMealAction ? (
        <button
          type="button"
          className="primary-button"
          onClick={() => openSheet("record")}
        >
          <Plus size={17} weight="bold" aria-hidden="true" />
          {t("nutrition.quick.record")}
        </button>
        ) : null}
        {showEnergyAction ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setActiveEnergy(
              nutrition.activeEnergy.kcal === null
                ? ""
                : String(nutrition.activeEnergy.kcal),
            );
            openSheet("energy");
          }}
        >
          <Lightning size={17} weight="fill" aria-hidden="true" />
          {t("nutrition.quick.title.energy")}
        </button>
        ) : null}
      </div>
      ) : null}

      {toastMessage ? (
        <div className="nutrition-undo-toast" role="status" aria-live="polite">
          <Check size={17} weight="bold" aria-hidden="true" />
          <span>{toastMessage}</span>
          {undo ? (
            <button
              type="button"
              onClick={() => void undoMeal()}
              disabled={busy === "undo"}
            >
              {busy === "undo"
                ? t("nutrition.quick.undoing")
                : t("nutrition.quick.undo")}
            </button>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <NutritionDialogPortal>
        <div
          className="nutrition-dialog-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeSheet();
          }}
        >
          <section
            ref={dialogRef}
            className="nutrition-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nutrition-sheet-title"
            aria-describedby="nutrition-sheet-description"
          >
            <header className="nutrition-sheet-header">
              {view === "record" ? <span className="sheet-header-spacer" /> : (
                <button
                  type="button"
                  aria-label={t("nutrition.action.back")}
                  onClick={goBack}
                >
                  <CaretLeft size={20} weight="bold" aria-hidden="true" />
                </button>
              )}
              <div>
                <h2 id="nutrition-sheet-title" ref={headingRef} tabIndex={-1}>
                  {sheetTitle()}
                </h2>
                <span id="nutrition-sheet-description">
                  {view === "combo-editor"
                    ? t("nutrition.quick.subtitle.edit")
                    : view === "record"
                      ? t("nutrition.quick.subtitle.calculated")
                      : t("nutrition.quick.subtitle.confirm")}
                </span>
              </div>
              <button
                type="button"
                aria-label={t("nutrition.action.close")}
                onClick={closeSheet}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            <div ref={sheetBodyRef} className="nutrition-sheet-body">
              {inlineError ? (
                <div className="library-inline-error" role="alert">
                  {inlineError}
                </div>
              ) : null}

              {view === "record" ? (
                <div className="quick-record-browser">
                  <label className="field-block quick-record-slot">
                    <span>{t("nutrition.quick.addTo")}</span>
                    <select
                      value={slot}
                      onChange={(event) => setSlot(event.target.value as MealSlot)}
                    >
                      {slotValues.map((value) => (
                        <option key={value} value={value}>
                          {slotLabel(value)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field-block">
                    <span>{t("nutrition.action.search")}</span>
                    <span className="search-input-wrap">
                      <MagnifyingGlass size={17} aria-hidden="true" />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("nutrition.quick.searchPlaceholder")}
                        autoComplete="off"
                      />
                    </span>
                  </label>

                  {filteredCombos.length ? (
                    <section className="quick-record-section">
                      <header>
                        <h3>{t("nutrition.quick.savedCombos")}</h3>
                        <span>
                          {t("nutrition.count.items", {
                            count: filteredCombos.length,
                          })}
                        </span>
                      </header>
                      <div className="quick-record-list">
                        {filteredCombos.map((combo) => (
                          <button
                            type="button"
                            className="quick-record-row"
                            key={combo.comboId}
                            onClick={() => chooseCombo(combo)}
                            disabled={!combo.isUsable}
                          >
                            <span>
                              <strong>{combo.displayName}</strong>
                              {combo.isUsable ? (
                                <NutritionMacroStrip
                                  preview={defaultComboPreview(combo)}
                                />
                              ) : (
                                <small>{comboIssueLabel(combo.issues[0])}</small>
                              )}
                            </span>
                            <Plus size={17} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {query.trim() ? (
                    <section className="quick-record-section">
                      <header>
                        <h3>{t("nutrition.quick.foodLibrary")}</h3>
                        <span>
                          {foodResults.length
                            ? t("nutrition.count.items", {
                                count: foodResults.length,
                              })
                            : ""}
                        </span>
                      </header>
                      {foodResults.length ? (
                        <div className="quick-record-list">
                          {foodResults.slice(0, 30).map((food) => {
                            const measure = displayMeasure(food.baseQuantity, food.defaultUnit);
                            return (
                              <button
                                type="button"
                                className="quick-record-row"
                                key={food.foodId}
                                onClick={() => chooseFood(food)}
                              >
                                <span>
                                  <strong>{food.displayName}</strong>
                                  <small>
                                    {numberLabel(
                                      food.nutrients.energyKcal,
                                      "kcal",
                                      formatNumber,
                                      t("nutrition.value.noRecord"),
                                    )}{" "}
                                    / {quantityText(measure.quantity)} {measure.unit}
                                  </small>
                                </span>
                                <Plus size={17} aria-hidden="true" />
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="quick-record-empty">
                          {t("nutrition.quick.noFood")}
                        </p>
                      )}
                    </section>
                  ) : (
                    <p className="quick-record-hint">
                      {t("nutrition.quick.searchHint")}
                    </p>
                  )}

                  <div className="quick-record-links">
                    <button type="button" onClick={() => openSheet("manual")}>
                      {t("nutrition.quick.title.manual")}
                    </button>
                    <button type="button" onClick={() => openSheet("combo-list")}>
                      {t("nutrition.quick.manageCombos")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        closeSheet();
                        window.setTimeout(onOpenFoodLibrary, 0);
                      }}
                    >
                      {t("nutrition.quick.foodLibrary")}
                    </button>
                  </div>
                </div>
              ) : null}

              {view === "manual" ? (
                <MealLogForm
                  date={nutrition.localDate}
                  timezone={timezone}
                  defaultTime={timeInTimeZone(new Date(), timezone)}
                  onDirtyChange={() => {}}
                  onSaved={async (message) => {
                    const response = await fetch(
                      `/api/nutrition/today?date=${encodeURIComponent(nutrition.localDate)}`,
                      { cache: "no-store" },
                    );
                    const result = await readJson(response);
                    onUpdated(result.nutrition as NutritionDayData);
                    closeSheet();
                    showToast(message, null);
                  }}
                />
              ) : null}

              {view === "food" && selectedFood ? (
                <form className="quick-record-confirm" onSubmit={submitFood}>
                  <div className="quick-record-selection">
                    <ForkKnife size={20} aria-hidden="true" />
                    <span>
                      <strong>{selectedFood.displayName}</strong>
                      <small>
                        {t("nutrition.quick.labelBasis", {
                          quantity: quantityText(
                            displayMeasure(
                              selectedFood.baseQuantity,
                              selectedFood.defaultUnit,
                            ).quantity,
                          ),
                          unit: displayMeasure(
                            selectedFood.baseQuantity,
                            selectedFood.defaultUnit,
                          ).unit,
                        })}
                      </small>
                    </span>
                  </div>
                  <label className="field-block">
                    <span>
                      {t("nutrition.quick.quantityUnit", {
                        unit: displayMeasure(
                          selectedFood.baseQuantity,
                          selectedFood.defaultUnit,
                        ).unit,
                      })}
                    </span>
                    <input
                      type="number"
                      min="0.001"
                      max="100000"
                      step="any"
                      inputMode="decimal"
                      value={foodQuantity}
                      onChange={(event) => setFoodQuantity(event.target.value)}
                      required
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("nutrition.quick.mealSlot")}</span>
                    <select value={slot} onChange={(event) => setSlot(event.target.value as MealSlot)}>
                      {slotValues.map((value) => (
                        <option key={value} value={value}>{slotLabel(value)}</option>
                      ))}
                    </select>
                  </label>
                  <button className="primary-button sheet-primary-action" type="submit" disabled={busy === "food-add"}>
                    {busy === "food-add"
                      ? t("nutrition.action.adding")
                      : t("nutrition.quick.addToSlot", {
                          slot: slotLabel(slot),
                        })}
                  </button>
                </form>
              ) : null}

              {view === "combo" && selectedCombo ? (
                <form className="quick-record-confirm" onSubmit={submitCombo}>
                  <div className="quick-record-selection">
                    <ForkKnife size={20} aria-hidden="true" />
                    <span>
                      <strong>{selectedCombo.displayName}</strong>
                      <small>
                        {t("nutrition.quick.comboDetail", {
                          count: selectedCombo.items.length,
                        })}
                      </small>
                    </span>
                  </div>
                  {!selectedCombo.isUsable ? (
                    <div className="library-inline-error" role="alert">
                      {selectedCombo.issues[0]
                        ? comboIssueLabel(selectedCombo.issues[0])
                        : t("nutrition.quick.comboNeedsReview")}
                    </div>
                  ) : null}
                  <div className="combo-quantity-list">
                    {selectedCombo.items.map((item) => {
                      const measure = displayMeasure(item.defaultQuantity, item.unit);
                      return (
                        <label className="combo-quantity-row" key={item.comboItemId}>
                          <span>{item.displayName}</span>
                          <span>
                            <input
                              type="number"
                              min="0.001"
                              max="100000"
                              step="any"
                              inputMode="decimal"
                              value={comboQuantities[item.comboItemId] ?? quantityText(measure.quantity)}
                              onChange={(event) => setComboQuantities((current) => ({ ...current, [item.comboItemId]: event.target.value }))}
                              required
                            />
                            <small>{measure.unit}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  <NutritionDetailPreview preview={selectedComboPreview} />
                  <label className="field-block">
                    <span>{t("nutrition.quick.mealSlot")}</span>
                    <select value={slot} onChange={(event) => setSlot(event.target.value as MealSlot)}>
                      {slotValues.map((value) => (
                        <option key={value} value={value}>{slotLabel(value)}</option>
                      ))}
                    </select>
                  </label>
                  <button className="primary-button sheet-primary-action" type="submit" disabled={!selectedCombo.isUsable || busy === "combo-add"}>
                    {busy === "combo-add"
                      ? t("nutrition.action.adding")
                      : t("nutrition.quick.addToSlot", {
                          slot: slotLabel(slot),
                        })}
                  </button>
                </form>
              ) : null}

              {view === "energy" ? (
                <form className="quick-record-confirm" onSubmit={saveEnergy}>
                  <div className="quick-record-selection energy-selection">
                    <Lightning size={21} weight="fill" aria-hidden="true" />
                    <span>
                      <strong>{t("nutrition.quick.title.energy")}</strong>
                      <small>{t("nutrition.quick.energyHint")}</small>
                    </span>
                  </div>
                  <label className="field-block">
                    <span>{t("nutrition.quick.currentEnergy")}</span>
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      step="1"
                      inputMode="numeric"
                      value={activeEnergy}
                      onChange={(event) => setActiveEnergy(event.target.value)}
                      placeholder={t("nutrition.quick.energyPlaceholder")}
                      required
                    />
                  </label>
                  <button className="primary-button sheet-primary-action" type="submit" disabled={busy === "energy"}>
                    {busy === "energy"
                      ? t("nutrition.action.updating")
                      : t("nutrition.quick.updateEnergy")}
                  </button>
                </form>
              ) : null}

              {view === "combo-list" ? (
                <div className="combo-manager">
                  <button type="button" className="library-new-button" onClick={() => openComboEditor()}>
                    <Plus size={16} weight="bold" aria-hidden="true" />
                    {t("nutrition.quick.addCombo")}
                  </button>
                  <div className="combo-manager-list">
                    {combos.length ? combos.map((combo) => (
                      <button type="button" key={combo.comboId} onClick={() => openComboEditor(combo)}>
                        <span>
                          <strong>{combo.displayName}</strong>
                          {!combo.isActive ? (
                            <small>{t("nutrition.quick.inactive")}</small>
                          ) : combo.isUsable ? (
                            <NutritionMacroStrip
                              preview={defaultComboPreview(combo)}
                            />
                          ) : (
                            <small>{t("nutrition.quick.needsReview")}</small>
                          )}
                        </span>
                        <PencilSimple size={17} aria-hidden="true" />
                      </button>
                    )) : (
                      <p className="quick-record-empty">
                        {t("nutrition.quick.emptyCombos")}
                      </p>
                    )}
                  </div>
                  <p className="combo-history-note">
                    {t("nutrition.quick.comboHistory")}
                  </p>
                </div>
              ) : null}

              {view === "combo-editor" ? (
                <form className="combo-editor" onSubmit={saveCombo}>
                  <label className="field-block">
                    <span>{t("nutrition.quick.comboName")}</span>
                    <input
                      value={comboEditor.displayName}
                      onChange={(event) => setComboEditor((current) => ({ ...current, displayName: event.target.value }))}
                      placeholder={t("nutrition.quick.comboNamePlaceholder")}
                      required
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("nutrition.quick.defaultMeal")}</span>
                    <select
                      value={comboEditor.slot}
                      onChange={(event) => setComboEditor((current) => ({ ...current, slot: event.target.value as MealSlot }))}
                    >
                      {slotValues.map((value) => (
                        <option key={value} value={value}>{slotLabel(value)}</option>
                      ))}
                    </select>
                  </label>

                  <section className="combo-editor-items">
                    <header>
                      <h3>{t("nutrition.quick.contents")}</h3>
                      <span>
                        {t("nutrition.count.items", {
                          count: comboEditor.items.length,
                        })}
                      </span>
                    </header>
                    {comboEditor.items.map((item, index) => (
                      <div className="combo-editor-item" key={item.key}>
                        <span className="combo-editor-item-name">{item.displayName}</span>
                        <label>
                          <span className="sr-only">
                            {t("nutrition.field.quantityNamed", {
                              name: item.displayName,
                            })}
                          </span>
                          <input
                            type="number"
                            min="0.001"
                            max="100000"
                            step="any"
                            inputMode="decimal"
                            value={item.quantity}
                            onChange={(event) => setComboEditor((current) => ({
                              ...current,
                              items: current.items.map((candidate) => candidate.key === item.key ? { ...candidate, quantity: event.target.value } : candidate),
                            }))}
                            required
                          />
                          <small>{displayMeasure(1, item.unit).unit}</small>
                        </label>
                        <div className="combo-item-actions">
                          <button type="button" aria-label={t("nutrition.quick.moveUp", { name: item.displayName })} onClick={() => moveEditorItem(index, -1)} disabled={index === 0}>
                            <ArrowUp size={15} aria-hidden="true" />
                          </button>
                          <button type="button" aria-label={t("nutrition.quick.moveDown", { name: item.displayName })} onClick={() => moveEditorItem(index, 1)} disabled={index === comboEditor.items.length - 1}>
                            <ArrowDown size={15} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="combo-remove-item"
                            aria-label={t("nutrition.quick.removeFromCombo", {
                              name: item.displayName,
                            })}
                            onClick={() => setComboEditor((current) => ({ ...current, items: current.items.filter((candidate) => candidate.key !== item.key) }))}
                          >
                            <Trash size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </section>

                  <NutritionDetailPreview preview={comboEditorPreview} />

                  <label className="field-block combo-food-search">
                    <span>{t("nutrition.quick.addFood")}</span>
                    <span className="search-input-wrap">
                      <MagnifyingGlass size={17} aria-hidden="true" />
                      <input
                        value={editorFoodQuery}
                        onChange={(event) => setEditorFoodQuery(event.target.value)}
                        placeholder={t("nutrition.quick.searchRegistered")}
                        autoComplete="off"
                      />
                    </span>
                  </label>
                  {editorFoodQuery.trim() && editorFoodResults.length ? (
                    <div className="combo-food-results">
                      {editorFoodResults.slice(0, 20).map((food) => (
                        <button type="button" key={food.foodId} onClick={() => addEditorFood(food)} disabled={comboEditor.items.some((item) => item.foodId === food.foodId)}>
                          <span>{food.displayName}</span>
                          <Plus size={15} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <footer className="combo-editor-footer">
                    {comboEditor.comboId ? (
                      <button type="button" className="danger-text-button" onClick={() => void toggleComboActive()} disabled={busy === "combo-status"}>
                        {comboEditor.isActive
                          ? t("nutrition.quick.disableCombo")
                          : t("nutrition.quick.enableCombo")}
                      </button>
                    ) : <span />}
                    <button className="primary-button" type="submit" disabled={busy === "combo-save"}>
                      {busy === "combo-save"
                        ? t("common.saving")
                        : comboEditor.comboId
                          ? t("nutrition.quick.saveVersion")
                          : t("nutrition.quick.addCombo")}
                    </button>
                  </footer>
                </form>
              ) : null}
            </div>
          </section>
        </div>
        </NutritionDialogPortal>
      ) : null}
    </>
  );
}
