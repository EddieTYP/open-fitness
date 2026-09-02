"use client";

import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  ForkKnife,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { NutritionTrend } from "@/components/NutritionTrend";
import { NutritionPlans } from "@/components/nutrition/NutritionPlans";
import { NutritionMacroStrip } from "@/components/nutrition/NutritionPreview";
import { NutritionQuickRecord } from "@/components/nutrition/NutritionQuickRecord";
import { clientUuid } from "@/lib/client-id";
import type {
  NutrientKey,
  NutritionDayData,
  NutritionFood,
  NutritionMealItemView,
  NutritionMealView,
} from "@/lib/nutrition";
import { calculateNutrientPreview } from "@/lib/nutrition-preview";
import { dateInTimeZone } from "@/lib/timezone.mjs";

type MealType = NutritionMealView["mealType"];

type MealGroupKey = MealType | "post_workout";

const NUTRITION_LOAD_TIMEOUT_MS = 10_000;

const mealGroupOrder: MealGroupKey[] = [
  "breakfast",
  "lunch",
  "snack",
  "post_workout",
  "dinner",
  "late_night",
  "other",
];

function mealGroupKey(meal: NutritionMealView): MealGroupKey {
  return meal.contextTag === "post_workout"
    ? "post_workout"
    : meal.mealType;
}

const nutrientFields: Array<{
  key: NutrientKey;
  unit: string;
  digits?: number;
}> = [
  { key: "energyKcal", unit: "kcal", digits: 0 },
  { key: "proteinG", unit: "g" },
  { key: "carbsG", unit: "g" },
  { key: "totalFatG", unit: "g" },
  { key: "saturatedFatG", unit: "g" },
  { key: "transFatG", unit: "g" },
  { key: "sugarG", unit: "g" },
  { key: "fibreG", unit: "g" },
  { key: "sodiumMg", unit: "mg", digits: 0 },
];

type FoodEditor = {
  foodId: string | null;
  displayName: string;
  brand: string;
  baseQuantity: string;
  baseUnit: string;
  isActive: boolean;
  nutrients: Record<NutrientKey, string>;
};

function emptyFoodEditor(): FoodEditor {
  return {
    foodId: null,
    displayName: "",
    brand: "",
    baseQuantity: "100",
    baseUnit: "g",
    isActive: true,
    nutrients: {
      energyKcal: "",
      proteinG: "",
      totalFatG: "",
      saturatedFatG: "",
      transFatG: "",
      carbsG: "",
      sugarG: "",
      fibreG: "",
      sodiumMg: "",
      cholesterolMg: "",
    },
  };
}

function editorFromFood(food: NutritionFood): FoodEditor {
  return {
    foodId: food.foodId,
    displayName: food.displayName,
    brand: food.brand ?? "",
    baseQuantity: String(food.baseQuantity),
    baseUnit: food.defaultUnit,
    isActive: food.isActive,
    nutrients: Object.fromEntries(
      Object.entries(food.nutrients).map(([key, value]) => [
        key,
        value === null ? "" : String(value),
      ]),
    ) as Record<NutrientKey, string>,
  };
}

function isIsoDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function numberLabel(
  value: number | null,
  formatNumber: ReturnType<typeof useI18n>["formatNumber"],
  missingLabel: string,
  unit = "",
  digits = 0,
) {
  if (value === null) return missingLabel;
  return `${formatNumber(value, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}${unit ? ` ${unit}` : ""}`;
}

function dailyNutrientLabel(
  data: NutritionDayData | null,
  key: NutrientKey,
  unit: string,
  digits: number,
  formatNumber: ReturnType<typeof useI18n>["formatNumber"],
  missingLabel: string,
) {
  const exactValue = data?.nutrients[key] ?? null;
  if (exactValue !== null) {
    return {
      value: numberLabel(exactValue, formatNumber, missingLabel, unit, digits),
      partial: false,
    };
  }

  const recordedValues =
    data?.meals.flatMap((meal) =>
      meal.items.length > 0
        ? meal.items.map((item) => item.nutrients[key])
        : [meal.nutrients[key]],
    ) ?? [];
  const knownValues = recordedValues.filter(
    (value): value is number => value !== null,
  );

  if (knownValues.length === 0) {
    return { value: missingLabel, partial: false };
  }

  const knownTotal = knownValues.reduce((total, value) => total + value, 0);
  return {
    value: `≥${numberLabel(knownTotal, formatNumber, missingLabel, unit, digits)}`,
    partial: true,
  };
}

function timeLabel(
  value: string | null,
  timezone: string,
  formatTime: ReturnType<typeof useI18n>["formatTime"],
  missingLabel: string,
) {
  if (!value) return missingLabel;
  return formatTime(value, {
    timeZone: timezone,
    hourCycle: "h23",
  });
}

function nullableNumber(value: string) {
  if (value.trim() === "") return null;
  return Number(value);
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

class NutritionViewRequestError extends Error {}

async function readJson(response: Response) {
  const result = (await response.json()) as { [key: string]: unknown };
  if (!response.ok) throw new NutritionViewRequestError();
  return result;
}

function requestErrorMessage(_error: unknown, fallback: string) {
  return fallback;
}

function MealRow({
  meal,
  timezone,
  onUpdated,
  onRefresh,
  onSuccess,
  onSaveAsCombo,
  onSearchFoods,
}: {
  meal: NutritionMealView;
  timezone: string;
  onUpdated: (nutrition: NutritionDayData) => void;
  onRefresh: () => void;
  onSuccess: (message: string) => void;
  onSaveAsCombo: (meal: NutritionMealView) => void;
  onSearchFoods: (query: string) => Promise<NutritionFood[]>;
}) {
  const { t, formatNumber, formatTime } = useI18n();
  const mealLabel = (group: MealGroupKey) => t(`nutrition.meal.${group}`);
  const missingValue = t("nutrition.value.noRecord");
  const valueLabel = (value: number | null, unit = "", digits = 0) =>
    numberLabel(value, formatNumber, missingValue, unit, digits);
  const [editingItemId, setEditingItemId] = useState<string | null>(
    null,
  );
  const [draftQuantity, setDraftQuantity] = useState("");
  const [confirmingDeleteItemId, setConfirmingDeleteItemId] =
    useState<string | null>(null);
  const [editingClassification, setEditingClassification] =
    useState(false);
  const [addingFood, setAddingFood] = useState(false);
  const [addFoodQuery, setAddFoodQuery] = useState("");
  const [addFoodResults, setAddFoodResults] = useState<NutritionFood[]>([]);
  const [addFoodSearching, setAddFoodSearching] = useState(false);
  const [selectedFood, setSelectedFood] = useState<NutritionFood | null>(null);
  const [addFoodQuantity, setAddFoodQuantity] = useState("");
  const [draftMealGroup, setDraftMealGroup] = useState<MealGroupKey>(
    () => mealGroupKey(meal),
  );
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const addFoodSearchSequence = useRef(0);
  const itemPreview = meal.items.length
    ? meal.items.length > 2
      ? t("nutrition.view.moreItems", {
          names: meal.items
            .slice(0, 2)
            .map((item) => item.name)
            .join(" · "),
          count: meal.items.length - 2,
        })
      : meal.items.map((item) => item.name).join(" · ")
    : t("nutrition.view.noItemName");
  const mealMeta = [
    meal.eatenAt && meal.timePrecision === "exact"
      ? timeLabel(
          meal.eatenAt,
          timezone,
          formatTime,
          t("nutrition.time.notRecorded"),
        )
      : null,
    meal.revisionNo > 1 ? t("nutrition.view.edited") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const canSaveAsCombo =
    meal.items.length > 0 &&
    meal.items.every(
      (item) => item.foodId && item.quantity !== null && item.quantity > 0,
    );
  const selectedFoodRawQuantity = selectedFood
    ? rawMeasure(addFoodQuantity, selectedFood.defaultUnit)
    : Number.NaN;
  const selectedFoodPreview = calculateNutrientPreview(
    selectedFood
      ? [
          {
            nutrients: selectedFood.nutrients,
            multiplier:
              Number.isFinite(selectedFoodRawQuantity) &&
              selectedFoodRawQuantity > 0
                ? selectedFoodRawQuantity / selectedFood.baseQuantity
                : null,
          },
        ]
      : [],
  );

  useEffect(() => {
    if (!addingFood || selectedFood || !addFoodQuery.trim()) {
      return;
    }

    const sequence = addFoodSearchSequence.current + 1;
    addFoodSearchSequence.current = sequence;
    const timer = window.setTimeout(() => {
      setAddFoodSearching(true);
      void onSearchFoods(addFoodQuery.trim())
        .then((foods) => {
          if (addFoodSearchSequence.current === sequence) {
            setAddFoodResults(foods);
          }
        })
        .catch(() => {
          if (addFoodSearchSequence.current !== sequence) return;
          setAddFoodResults([]);
          setEditError(t("nutrition.view.error.searchFood"));
        })
        .finally(() => {
          if (addFoodSearchSequence.current === sequence) {
            setAddFoodSearching(false);
          }
        });
    }, 180);

    return () => window.clearTimeout(timer);
  }, [addingFood, addFoodQuery, onSearchFoods, selectedFood, t]);

  function resetFoodAddition() {
    addFoodSearchSequence.current += 1;
    setAddingFood(false);
    setAddFoodQuery("");
    setAddFoodResults([]);
    setAddFoodSearching(false);
    setSelectedFood(null);
    setAddFoodQuantity("");
  }

  function beginFoodAddition() {
    setEditingItemId(null);
    setConfirmingDeleteItemId(null);
    setEditingClassification(false);
    setEditError(null);
    resetFoodAddition();
    setAddingFood(true);
  }

  function chooseFood(food: NutritionFood) {
    if (meal.items.some((item) => item.foodId === food.foodId)) return;
    addFoodSearchSequence.current += 1;
    const measure = displayMeasure(food.baseQuantity, food.defaultUnit);
    setSelectedFood(food);
    setAddFoodQuantity(quantityText(measure.quantity));
    setAddFoodQuery("");
    setAddFoodResults([]);
    setEditError(null);
  }

  async function appendFood(event: FormEvent) {
    event.preventDefault();
    if (!selectedFood) return;
    if (
      !Number.isFinite(selectedFoodRawQuantity) ||
      selectedFoodRawQuantity <= 0
    ) {
      setEditError(t("nutrition.error.invalidQuantity"));
      return;
    }

    setSaving(true);
    setEditError(null);
    try {
      const response = await fetch("/api/nutrition/meals", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          mealId: meal.mealId,
          expectedRevisionNo: meal.revisionNo,
          action: "append_food",
          foodId: selectedFood.foodId,
          quantity: selectedFoodRawQuantity,
          revisionReason: "Site food addition",
        }),
      });
      if (response.status === 409) onRefresh();
      const result = await readJson(response);
      onUpdated(result.nutrition as NutritionDayData);
      const foodName = selectedFood.displayName;
      resetFoodAddition();
      onSuccess(
        t("nutrition.view.success.foodAdded", {
          name: foodName,
          slot: mealLabel(mealGroupKey(meal)),
        }),
      );
    } catch {
      setEditError(t("nutrition.view.error.addFood"));
    } finally {
      setSaving(false);
    }
  }

  function beginClassificationEdit() {
    setEditingItemId(null);
    setConfirmingDeleteItemId(null);
    setDraftMealGroup(mealGroupKey(meal));
    setEditingClassification(true);
    setEditError(null);
  }

  async function saveClassification(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setEditError(null);
    const isPostWorkout = draftMealGroup === "post_workout";
    try {
      const response = await fetch("/api/nutrition/meals", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          mealId: meal.mealId,
          expectedRevisionNo: meal.revisionNo,
          action: "classification",
          mealType: isPostWorkout ? "other" : draftMealGroup,
          contextTag: isPostWorkout ? "post_workout" : null,
          originalMealType: null,
          revisionReason: "Site meal classification correction",
        }),
      });
      if (response.status === 409) onRefresh();
      const result = await readJson(response);
      onUpdated(result.nutrition as NutritionDayData);
      setEditingClassification(false);
      onSuccess(
        t("nutrition.view.success.classification", {
          slot: mealLabel(draftMealGroup),
        }),
      );
    } catch (requestError) {
      setEditError(
        requestErrorMessage(
          requestError,
          t("nutrition.view.error.classification"),
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(item: NutritionMealItemView) {
    if (item.quantity === null || item.quantity <= 0) return;
    setConfirmingDeleteItemId(null);
    setEditingItemId(item.mealItemId);
    setDraftQuantity(String(item.quantity));
    setEditError(null);
  }

  async function deleteItem(item: NutritionMealItemView) {
    setSaving(true);
    setEditError(null);
    try {
      const response = await fetch("/api/nutrition/meals", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          mealId: meal.mealId,
          mealItemId: item.mealItemId,
          expectedRevisionNo: meal.revisionNo,
          revisionReason: "Site item deletion",
        }),
      });
      if (response.status === 409) onRefresh();
      const result = await readJson(response);
      onUpdated(result.nutrition as NutritionDayData);
      setConfirmingDeleteItemId(null);
      onSuccess(t("nutrition.view.success.deletedItem", { name: item.name }));
    } catch (requestError) {
      setEditError(
        requestErrorMessage(
          requestError,
          t("nutrition.view.error.deleteItem"),
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveQuantity(
    event: FormEvent,
    item: NutritionMealItemView,
  ) {
    event.preventDefault();
    setSaving(true);
    setEditError(null);
    try {
      const response = await fetch("/api/nutrition/meals", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          mealId: meal.mealId,
          mealItemId: item.mealItemId,
          expectedRevisionNo: meal.revisionNo,
          quantity: Number(draftQuantity),
          revisionReason: "Site quantity correction",
        }),
      });
      if (response.status === 409) onRefresh();
      const result = await readJson(response);
      onUpdated(result.nutrition as NutritionDayData);
      setEditingItemId(null);
      setDraftQuantity("");
      onSuccess(t("nutrition.view.success.quantity", { name: item.name }));
    } catch (requestError) {
      setEditError(
        requestErrorMessage(
          requestError,
          t("nutrition.view.error.updateQuantity"),
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="nutrition-meal-row">
      <summary>
        <span>
          <strong>{itemPreview}</strong>
          {mealMeta ? <small>{mealMeta}</small> : null}
        </span>
        <span className="meal-macros">
          <strong>
            {valueLabel(meal.nutrients.energyKcal, "kcal", 0)}
          </strong>
          <small>
            {t("nutrition.view.proteinShort")} {valueLabel(meal.nutrients.proteinG, "g", 1)}
          </small>
          <CaretDown
            size={15}
            className="meal-row-caret"
            aria-hidden="true"
          />
        </span>
      </summary>
      <div className="meal-details">
        <div className="meal-classification-row">
          {editingClassification ? (
            <form
              className="meal-classification-editor"
              onSubmit={(event) => void saveClassification(event)}
            >
              <label>
                <span>{t("nutrition.view.mealType")}</span>
                <select
                  value={draftMealGroup}
                  onChange={(event) =>
                    setDraftMealGroup(event.target.value as MealGroupKey)
                  }
                  autoFocus
                >
                  {mealGroupOrder.map((group) => (
                    <option key={group} value={group}>
                      {mealLabel(group)}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <button
                  type="button"
                  className="meal-edit-cancel"
                  onClick={() => {
                    setEditingClassification(false);
                    setEditError(null);
                  }}
                  disabled={saving}
                >
                  {t("nutrition.view.cancel")}
                </button>
                <button
                  type="submit"
                  className="meal-edit-save"
                  disabled={saving}
                >
                  <Check size={14} weight="bold" aria-hidden="true" />
                  {saving
                    ? t("nutrition.view.updating")
                    : t("nutrition.view.update")}
                </button>
              </div>
            </form>
          ) : (
            <>
              <span>
                <small>{t("nutrition.view.mealType")}</small>
                <strong>{mealLabel(mealGroupKey(meal))}</strong>
              </span>
              <button
                type="button"
                className="meal-classification-trigger"
                onClick={beginClassificationEdit}
              >
                <PencilSimple size={14} aria-hidden="true" />
                {t("nutrition.action.edit")} {t("nutrition.view.mealType")}
              </button>
            </>
          )}
        </div>
        <ul>
          {meal.items.map((item) => {
            const canEdit =
              item.quantity !== null && item.quantity > 0;
            const isEditing = editingItemId === item.mealItemId;
            const isConfirmingDelete =
              confirmingDeleteItemId === item.mealItemId;
            return (
              <li
                key={item.mealItemId}
                className={isEditing ? "is-editing" : ""}
              >
                {isEditing ? (
                  <form
                    className="meal-item-editor"
                    onSubmit={(event) =>
                      void saveQuantity(event, item)
                    }
                  >
                    <span>{item.name}</span>
                    <label>
                      <span className="sr-only">
                        {t("nutrition.view.newQuantity", { name: item.name })}
                      </span>
                      <input
                        type="number"
                        min="0.001"
                        max="100000"
                        step="any"
                        inputMode="decimal"
                        value={draftQuantity}
                        onChange={(event) =>
                          setDraftQuantity(event.target.value)
                        }
                        autoFocus
                        required
                      />
                      <small>{item.unit || t("nutrition.view.unit.serving")}</small>
                    </label>
                    <div>
                      <button
                        type="button"
                        className="meal-edit-cancel"
                        onClick={() => {
                          setEditingItemId(null);
                          setEditError(null);
                        }}
                        disabled={saving}
                      >
                        {t("nutrition.view.cancel")}
                      </button>
                      <button
                        type="submit"
                        className="meal-edit-save"
                        disabled={saving}
                      >
                        <Check size={14} weight="bold" aria-hidden="true" />
                        {saving
                          ? t("nutrition.view.updating")
                          : t("nutrition.view.update")}
                      </button>
                    </div>
                  </form>
                ) : isConfirmingDelete ? (
                  <>
                    <span>
                      {t("nutrition.view.deleteQuestion", { name: item.name })}
                    </span>
                    <div className="meal-delete-confirm">
                      <button
                        type="button"
                        onClick={() => setConfirmingDeleteItemId(null)}
                        disabled={saving}
                      >
                        {t("nutrition.view.cancel")}
                      </button>
                      <button
                        type="button"
                        className="meal-delete-confirm-button"
                        onClick={() => void deleteItem(item)}
                        disabled={saving}
                      >
                        {saving
                          ? t("nutrition.action.deleting")
                          : t("nutrition.view.confirmDelete")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span>
                      {item.name}
                      {item.quantity !== null
                        ? ` × ${item.quantity}${item.unit ? ` ${item.unit}` : ""}`
                        : ""}
                    </span>
                    <div className="meal-item-actions">
                      <strong>
                        {valueLabel(item.nutrients.energyKcal, "kcal", 0)}
                      </strong>
                      {canEdit ? (
                        <button
                          type="button"
                          aria-label={t("nutrition.view.editQuantityNamed", {
                            name: item.name,
                          })}
                          onClick={() => beginEdit(item)}
                        >
                          <PencilSimple size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="meal-delete-trigger"
                        aria-label={t("nutrition.view.deleteNamed", {
                          name: item.name,
                        })}
                        onClick={() => {
                          setEditingItemId(null);
                          setConfirmingDeleteItemId(item.mealItemId);
                          setEditError(null);
                        }}
                      >
                        <Trash size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {addingFood ? (
          <section
            className="meal-add-food"
            aria-label={t("nutrition.view.addFood")}
          >
            <header>
              <strong>{t("nutrition.view.addFood")}</strong>
              <button
                type="button"
                aria-label={t("nutrition.view.cancelAddFood")}
                onClick={() => {
                  resetFoodAddition();
                  setEditError(null);
                }}
                disabled={saving}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            {selectedFood ? (
              <form className="meal-add-food-confirm" onSubmit={appendFood}>
                <div className="meal-add-food-selection">
                  <span>
                    <strong>{selectedFood.displayName}</strong>
                    <small>
                      {t("nutrition.view.labelBasis", {
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
                  <button
                    type="button"
                    onClick={() => {
                      addFoodSearchSequence.current += 1;
                      setSelectedFood(null);
                      setAddFoodQuantity("");
                      setAddFoodResults([]);
                      setAddFoodSearching(false);
                      setEditError(null);
                    }}
                    disabled={saving}
                  >
                    {t("nutrition.view.chooseAgain")}
                  </button>
                </div>
                <label className="field-block meal-add-food-quantity">
                  <span>
                    {t("nutrition.view.quantityUnit", {
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
                    value={addFoodQuantity}
                    onChange={(event) =>
                      setAddFoodQuantity(event.target.value)
                    }
                    autoFocus
                    required
                  />
                </label>
                <NutritionMacroStrip preview={selectedFoodPreview} />
                <button
                  type="submit"
                  className="meal-add-food-submit"
                  disabled={saving || selectedFoodPreview.invalid}
                >
                  <Plus size={15} weight="bold" aria-hidden="true" />
                  {saving
                    ? t("nutrition.action.adding")
                    : t("nutrition.view.addToSlot", {
                        slot: mealLabel(mealGroupKey(meal)),
                      })}
                </button>
              </form>
            ) : (
              <div className="meal-add-food-search">
                <label>
                  <span className="sr-only">
                    {t("nutrition.view.searchFood")}
                  </span>
                  <MagnifyingGlass size={17} aria-hidden="true" />
                  <input
                    value={addFoodQuery}
                    onChange={(event) => {
                      const query = event.target.value;
                      setAddFoodQuery(query);
                      if (!query.trim()) {
                        addFoodSearchSequence.current += 1;
                        setAddFoodResults([]);
                        setAddFoodSearching(false);
                      }
                      setEditError(null);
                    }}
                    placeholder={t("nutrition.view.searchFood")}
                    autoComplete="off"
                    autoFocus
                  />
                </label>
                {addFoodQuery.trim() ? (
                  <div className="meal-add-food-results">
                    {addFoodSearching ? (
                      <span className="meal-add-food-status">
                        {t("nutrition.view.searching")}
                      </span>
                    ) : addFoodResults.length ? (
                      addFoodResults.slice(0, 12).map((food) => {
                        const alreadyAdded = meal.items.some(
                          (item) => item.foodId === food.foodId,
                        );
                        const measure = displayMeasure(
                          food.baseQuantity,
                          food.defaultUnit,
                        );
                        return (
                          <button
                            type="button"
                            key={food.foodId}
                            disabled={alreadyAdded}
                            onClick={() => chooseFood(food)}
                          >
                            <span>
                              <strong>{food.displayName}</strong>
                              <small>
                                {alreadyAdded
                                  ? t("nutrition.view.alreadyAdded")
                                  : `${quantityText(measure.quantity)} ${measure.unit} · ${valueLabel(food.nutrients.energyKcal, "kcal", 0)}`}
                              </small>
                            </span>
                            {alreadyAdded ? (
                              <Check size={15} aria-hidden="true" />
                            ) : (
                              <Plus size={15} aria-hidden="true" />
                            )}
                          </button>
                        );
                      })
                    ) : (
                      <span className="meal-add-food-status">
                        {t("nutrition.view.foodNotFound")}
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        ) : (
          <button
            type="button"
            className="meal-add-food-trigger"
            onClick={beginFoodAddition}
            aria-expanded="false"
          >
            <Plus size={15} weight="bold" aria-hidden="true" />
            {t("nutrition.view.addFood")}
          </button>
        )}
        {editError ? (
          <p className="meal-edit-error" role="alert">
            {editError}
          </p>
        ) : null}
        <div className="meal-detail-grid">
          {nutrientFields.slice(1).map((field) => (
            <span key={field.key}>
              {t(`nutrition.nutrient.${field.key}`)}
              <strong>
                {valueLabel(
                  meal.nutrients[field.key],
                  field.unit,
                  field.digits ?? 1,
                )}
              </strong>
            </span>
          ))}
        </div>
        {canSaveAsCombo ? (
          <button
            type="button"
            className="meal-save-combo"
            onClick={() => onSaveAsCombo(meal)}
          >
            <Plus size={15} weight="bold" aria-hidden="true" />
            {t("nutrition.view.saveCombo")}
          </button>
        ) : null}
        {meal.notes ? <p>{meal.notes}</p> : null}
      </div>
    </details>
  );
}

export function NutritionView({
  active,
  initialDate,
  timezone,
  onDateChange,
}: {
  active: boolean;
  initialDate?: string;
  timezone: string;
  onDateChange?: (date: string) => void;
}) {
  const { t, formatNumber, formatTime } = useI18n();
  const missingValue = t("nutrition.value.noRecord");
  const valueLabel = (value: number | null, unit = "", digits = 0) =>
    numberLabel(value, formatNumber, missingValue, unit, digits);
  const mealLabel = (group: MealGroupKey) => t(`nutrition.meal.${group}`);
  const [data, setData] = useState<NutritionDayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(
    null,
  );
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFoods, setLibraryFoods] = useState<NutritionFood[]>([]);
  const [editor, setEditor] = useState<FoodEditor>(emptyFoodEditor);
  const [comboDraftMeal, setComboDraftMeal] =
    useState<NutritionMealView | null>(null);
  const [nutritionPane, setNutritionPane] = useState<"record" | "prep">(
    "record",
  );
  const [planCounts, setPlanCounts] = useState({ today: 0, prep: 0 });
  const [todayDate, setTodayDate] = useState(() =>
    dateInTimeZone(new Date(), timezone),
  );
  const [localDate, setLocalDate] = useState(() => {
    const today = dateInTimeZone(new Date(), timezone);
    return initialDate && isIsoDate(initialDate)
      ? initialDate > today
        ? today
        : initialDate
      : today;
  });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const nutritionRevisionRef = useRef<string | null>(null);
  const pendingNutritionRevisionRef = useRef<string | null>(null);
  const nutritionNeedsRetryRef = useRef(false);
  const revisionCheckingRef = useRef(false);
  const librarySearchSequence = useRef(0);
  const libraryDialogRef = useRef<HTMLElement | null>(null);
  const libraryListRef = useRef<HTMLDivElement | null>(null);
  const foodEditorRef = useRef<HTMLFormElement | null>(null);
  const resetLibraryListScroll = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (libraryListRef.current) libraryListRef.current.scrollTop = 0;
    });
  }, []);
  const resetFoodEditorScroll = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (foodEditorRef.current) foodEditorRef.current.scrollTop = 0;
    });
  }, []);
  const currentToday = dateInTimeZone(new Date(), timezone);
  const requestedExternalDate =
    initialDate && isIsoDate(initialDate)
      ? initialDate > currentToday
        ? currentToday
        : initialDate
      : currentToday;
  const [syncedExternalDate, setSyncedExternalDate] = useState(
    requestedExternalDate,
  );

  if (active && syncedExternalDate !== requestedExternalDate) {
    setSyncedExternalDate(requestedExternalDate);
    setLoading(true);
    setError(null);
    setLocalDate(requestedExternalDate);
  }

  const searchFoods = useCallback(
    async (query: string, includeInactive = false) => {
      const response = await fetch(
        `/api/nutrition/items?q=${encodeURIComponent(query)}&includeInactive=${includeInactive}`,
        { cache: "no-store" },
      );
      const result = await readJson(response);
      return result.items as NutritionFood[];
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      NUTRITION_LOAD_TIMEOUT_MS,
    );
    void fetch(
      `/api/nutrition/today?date=${encodeURIComponent(localDate)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(readJson)
      .then((result) => {
        if (!active) return;
        const nextData = result.nutrition as NutritionDayData;
        setData(nextData);
        nutritionNeedsRetryRef.current = nextData.status === "unavailable";
        if (nextData.status !== "unavailable") setError(null);
        if (
          pendingNutritionRevisionRef.current &&
          nextData.status !== "unavailable"
        ) {
          nutritionRevisionRef.current =
            pendingNutritionRevisionRef.current;
          pendingNutritionRevisionRef.current = null;
        } else if (nextData.status === "unavailable") {
          pendingNutritionRevisionRef.current = null;
        }
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        pendingNutritionRevisionRef.current = null;
        nutritionNeedsRetryRef.current = true;
        setError(
          requestErrorMessage(
            requestError,
            t("nutrition.view.error.load"),
          ),
        );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [localDate, refreshNonce, t]);

  useEffect(() => {
    async function checkNutritionRevision() {
      if (
        revisionCheckingRef.current ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      revisionCheckingRef.current = true;
      try {
        const response = await fetch("/api/fitness/revisions", {
          cache: "no-store",
        });
        if (!response.ok) return;
        const result = (await response.json()) as {
          revisions: { nutrition: string };
        };
        const nextRevision = result.revisions.nutrition;
        if (nutritionRevisionRef.current === null) {
          nutritionRevisionRef.current = nextRevision;
          if (!nutritionNeedsRetryRef.current) return;
        }
        if (
          (nutritionRevisionRef.current !== nextRevision ||
            nutritionNeedsRetryRef.current) &&
          pendingNutritionRevisionRef.current === null
        ) {
          pendingNutritionRevisionRef.current = nextRevision;
          setRefreshNonce((value) => value + 1);
        }
      } catch {
        // Keep the last verified day and try again on the next check.
      } finally {
        revisionCheckingRef.current = false;
      }
    }

    function syncClock() {
      const currentDate = dateInTimeZone(new Date(), timezone);
      setTodayDate((previousToday) => {
        if (previousToday === currentDate) return previousToday;
        setLocalDate((viewedDate) =>
          viewedDate === previousToday ? currentDate : viewedDate,
        );
        return currentDate;
      });
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        syncClock();
        void checkNutritionRevision();
      }
    }

    function handleFocus() {
      syncClock();
      void checkNutritionRevision();
    }

    function handlePageShow() {
      syncClock();
      void checkNutritionRevision();
    }

    syncClock();
    void checkNutritionRevision();
    const clockInterval = window.setInterval(syncClock, 60_000);
    const revisionInterval = window.setInterval(
      checkNutritionRevision,
      10_000,
    );
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      window.clearInterval(clockInterval);
      window.clearInterval(revisionInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [timezone]);

  useEffect(() => {
    if (!libraryOpen) return;
    const sequence = ++librarySearchSequence.current;
    const timeout = window.setTimeout(() => {
      void searchFoods(libraryQuery, true)
        .then((items) => {
          if (librarySearchSequence.current === sequence) {
            setLibraryFoods(items);
            resetLibraryListScroll();
          }
        })
        .catch(() => {
          if (librarySearchSequence.current === sequence) {
            setLibraryFoods([]);
          }
        });
    }, 180);
    return () => {
      window.clearTimeout(timeout);
      if (librarySearchSequence.current === sequence) {
        librarySearchSequence.current += 1;
      }
    };
  }, [libraryOpen, libraryQuery, resetLibraryListScroll, searchFoods]);

  useEffect(() => {
    if (!libraryOpen) return;
    resetLibraryListScroll();
    resetFoodEditorScroll();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusTimer = window.setTimeout(() => {
      const focusable = libraryDialogRef.current?.querySelector<HTMLElement>(
        "button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      focusable?.focus();
    }, 0);

    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setLibraryOpen(false);
        return;
      }
      if (event.key !== "Tab" || !libraryDialogRef.current) return;
      const focusable = [
        ...libraryDialogRef.current.querySelectorAll<HTMLElement>(
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
  }, [libraryOpen, resetFoodEditorScroll, resetLibraryListScroll]);

  function changeViewedDate(nextDate: string) {
    if (nextDate === localDate) return;
    setLoading(true);
    setError(null);
    setLocalDate(nextDate);
    onDateChange?.(nextDate);
  }

  function selectLibraryFood(food: NutritionFood) {
    setLibraryError(null);
    setEditor(editorFromFood(food));
    resetFoodEditorScroll();
  }

  function updateEditorNutrient(key: NutrientKey, value: string) {
    setEditor((current) => ({
      ...current,
      nutrients: { ...current.nutrients, [key]: value },
    }));
  }

  async function saveFood(event: FormEvent) {
    event.preventDefault();
    setBusy("food");
    setLibraryError(null);
    try {
      const method = editor.foodId ? "PATCH" : "POST";
      const response = await fetch("/api/nutrition/items", {
        method,
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          ...(editor.foodId
            ? { foodId: editor.foodId, action: "revise" }
            : {}),
          displayName: editor.displayName,
          brand: editor.brand || null,
          baseQuantity: Number(editor.baseQuantity),
          baseUnit: editor.baseUnit,
          nutrients: Object.fromEntries(
            Object.entries(editor.nutrients).map(([key, value]) => [
              key,
              nullableNumber(value),
            ]),
          ),
          sourceNote: "Site food library",
        }),
      });
      const result = await readJson(response);
      const saved = result.item as NutritionFood;
      setEditor(editorFromFood(saved));
      setLibraryFoods(await searchFoods(libraryQuery, true));
      resetLibraryListScroll();
      resetFoodEditorScroll();
    } catch (requestError) {
      setLibraryError(
        requestErrorMessage(
          requestError,
          t("nutrition.view.error.saveFood"),
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  async function toggleFoodActive() {
    if (!editor.foodId) return;
    setBusy("food-status");
    setLibraryError(null);
    try {
      const response = await fetch("/api/nutrition/items", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          foodId: editor.foodId,
          action: editor.isActive ? "deactivate" : "reactivate",
        }),
      });
      const result = await readJson(response);
      const saved = result.item as NutritionFood;
      setEditor(editorFromFood(saved));
      setLibraryFoods(await searchFoods(libraryQuery, true));
      resetLibraryListScroll();
      resetFoodEditorScroll();
    } catch (requestError) {
      setLibraryError(
        requestErrorMessage(
          requestError,
          t("nutrition.view.error.foodStatus"),
        ),
      );
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) {
    return (
      <div className="nutrition-view" aria-busy="true">
        <div className="skeleton nutrition-skeleton-summary" />
        <div className="skeleton nutrition-skeleton-actions" />
        <div className="skeleton nutrition-skeleton-meals" />
      </div>
    );
  }

  if (!data || data.status === "unavailable") {
    return (
      <div className="nutrition-view">
        <div className="state-message state-unavailable" role="alert">
          <strong>{t("nutrition.view.unavailableTitle")}</strong>
          <span>
            {error || t("nutrition.view.tryLater")}
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setError(null);
              setLoading(true);
              setRefreshNonce((value) => value + 1);
            }}
          >
            {t("nutrition.view.retry")}
          </button>
        </div>
      </div>
    );
  }

  const remaining = data.budget.remainingKcal;
  const remainingLabel =
    data.intakeState === "no_record"
      ? t("nutrition.view.remaining.notStarted")
      : remaining === null
        ? t("nutrition.view.remaining.cannot")
        : remaining < 0
          ? t("nutrition.view.remaining.over")
          : t("nutrition.view.remaining.available");
  const dayStatusLabel =
    data.intakeState === "no_record"
      ? t("nutrition.view.day.noRecord")
      : !data.budget.isComplete
        ? t("nutrition.view.day.partial")
        : data.activityState === "missing"
          ? t("nutrition.view.day.missingActivity")
          : data.activityState === "provisional"
            ? t("nutrition.view.day.provisional")
            : t("nutrition.view.day.final");
  const isToday = localDate === todayDate;
  const canLogSelectedDate = localDate <= todayDate;
  const groupedMeals = mealGroupOrder
    .map((key) => ({
      key,
      label: mealLabel(key),
      meals: data.meals.filter((meal) => mealGroupKey(meal) === key),
    }))
    .filter((group) => group.meals.length > 0);
  const itemCount = data.meals.reduce(
    (total, meal) => total + Math.max(meal.items.length, 1),
    0,
  );

  return (
    <div
      className={`nutrition-view${loading ? " is-refreshing" : ""}`}
      aria-busy={loading}
    >
      {error ? (
        <div className="state-message state-unavailable" role="alert">
          {error}
        </div>
      ) : null}
      {successMessage ? (
        <div className="nutrition-success" role="status" aria-live="polite">
          <Check size={16} weight="bold" aria-hidden="true" />
          {successMessage}
        </div>
      ) : null}

      <div
        className="nutrition-pane-switch"
        role="group"
        aria-label={t("nutrition.view.paneLabel")}
      >
        <button
          type="button"
          className={nutritionPane === "record" ? "is-active" : ""}
          aria-pressed={nutritionPane === "record"}
          onClick={() => setNutritionPane("record")}
        >
          {t("nutrition.view.record")}
          {planCounts.today > 0 ? (
            <span className="nutrition-pane-count">{planCounts.today}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={nutritionPane === "prep" ? "is-active" : ""}
          aria-pressed={nutritionPane === "prep"}
          onClick={() => setNutritionPane("prep")}
        >
          {t("nutrition.view.prep")}
          {planCounts.prep > 0 ? (
            <span className="nutrition-pane-count">{planCounts.prep}</span>
          ) : null}
        </button>
      </div>

      {nutritionPane === "record" ? (
        <>
      <section
        className="nutrition-date-nav"
        aria-label={t("nutrition.view.dateLabel")}
      >
        <button
          type="button"
          aria-label={t("nutrition.view.previousDay")}
          disabled={loading}
          onClick={() => changeViewedDate(shiftDate(localDate, -1))}
        >
          <CaretLeft size={17} weight="bold" aria-hidden="true" />
        </button>
        <label>
          <span className="sr-only">{t("nutrition.view.viewDate")}</span>
          <input
            type="date"
            value={localDate}
            max={todayDate}
            disabled={loading}
            onChange={(event) => {
              if (event.target.value) {
                changeViewedDate(event.target.value);
              }
            }}
          />
        </label>
        <button
          type="button"
          aria-label={t("nutrition.view.nextDay")}
          disabled={loading || localDate >= todayDate}
          onClick={() => {
            const next = shiftDate(localDate, 1);
            changeViewedDate(next > todayDate ? todayDate : next);
          }}
        >
          <CaretRight size={17} weight="bold" aria-hidden="true" />
        </button>
        {isToday ? (
          <span className="nutrition-date-current">
            {t("nutrition.view.today")}
          </span>
        ) : (
          <button
            type="button"
            className="nutrition-date-today"
            disabled={loading}
            onClick={() => changeViewedDate(todayDate)}
          >
            {t("nutrition.view.backToday")}
          </button>
        )}
      </section>

      <section className="nutrition-summary">
        <div className="nutrition-summary-top">
          <div>
            <span>{remainingLabel}</span>
            <strong>
              {data.intakeState === "no_record"
                ? missingValue
                : remaining === null
                  ? t("nutrition.view.cannotCalculate")
                : `${formatNumber(Math.abs(remaining))} kcal`}
            </strong>
          </div>
          <div className="nutrition-target-note">
            <span>
              {t("nutrition.view.consumed", {
                value: valueLabel(data.budget.consumedKcal, "kcal", 0),
              })}
            </span>
            <small>{dayStatusLabel}</small>
          </div>
        </div>

        <div className="nutrition-key-metrics">
          <div>
            <span>{t("nutrition.nutrient.proteinG")}</span>
            <strong>
              {valueLabel(data.protein.consumedG, "g", 1)}
            </strong>
            <small>
              {t("nutrition.view.target", {
                value: valueLabel(data?.protein.targetG ?? null, "g", 0),
              })}
            </small>
          </div>
          <div>
            <span>{t("nutrition.view.activeEnergy")}</span>
            <strong>
              {valueLabel(data?.activeEnergy.kcal ?? null, "kcal", 0)}
            </strong>
            <small>
              {data.activeEnergy.kcal === null
                ? t("nutrition.view.notEntered")
                : data.activeEnergy.observedAt
                  ? t("nutrition.view.updatedAt", {
                      time: timeLabel(
                        data.activeEnergy.observedAt,
                        timezone,
                        formatTime,
                        t("nutrition.time.notRecorded"),
                      ),
                    })
                  : data.activeEnergy.source === "Apple Health Shortcut"
                    ? t("nutrition.view.appleHealthSynced")
                    : t("nutrition.view.entered")}
            </small>
          </div>
          <div>
            <span>{t("nutrition.view.intakeTarget")}</span>
            <strong>
              {valueLabel(data.budget.targetKcal, "kcal", 0)}
            </strong>
            <small>
              {data.activityState === "missing"
                ? t("nutrition.view.activityNotCounted")
                : data.ruleState === "provisional"
                  ? t("nutrition.view.calibrating")
                  : t("nutrition.view.dailyTarget")}
            </small>
          </div>
        </div>

        <details className="nutrition-basis">
          <summary>{t("nutrition.view.basisTitle")}</summary>
          <p>
            {data.budget.targetKcal === null
              ? t("nutrition.view.basis.insufficient")
              : data.budget.basis === "fixed_daily_target"
                ? t("nutrition.view.basis.fixed")
                : t("nutrition.view.basis.formula")}
            {data.ruleState === "provisional" &&
            data.budget.basis !== "fixed_daily_target"
              ? ` ${t("nutrition.view.basis.provisional")}`
              : ""}
            {!data.budget.isComplete
              ? ` ${t("nutrition.view.basis.incomplete")}`
              : ""}
          </p>
          {data.budget.estimatedBalanceKcal !== null ? (
            <p>
              {t(
                data.budget.estimatedBalanceKcal > 0
                  ? "nutrition.view.balanceOver"
                  : "nutrition.view.balanceUnder",
                {
                  value: formatNumber(
                    Math.abs(data.budget.estimatedBalanceKcal),
                  ),
                },
              )}
            </p>
          ) : null}
        </details>
      </section>

      <NutritionQuickRecord
        nutrition={data}
        timezone={timezone}
        showMealAction={canLogSelectedDate}
        showEnergyAction={isToday}
        draftMeal={comboDraftMeal}
        onDraftConsumed={() => setComboDraftMeal(null)}
        onUpdated={setData}
        onOpenFoodLibrary={() => {
          setLibraryOpen(true);
          setLibraryError(null);
          setLibraryQuery("");
          setEditor(emptyFoodEditor());
        }}
        onError={setError}
      />
        </>
      ) : null}

      <NutritionPlans
        mode={nutritionPane}
        showToday={isToday}
        today={todayDate}
        refreshKey={refreshNonce}
        onCountsChange={setPlanCounts}
        onNutritionUpdated={setData}
        onRefresh={() => setRefreshNonce((value) => value + 1)}
        onError={setError}
      />

      {nutritionPane === "record" ? (
        <>
      <section className="nutrition-meals">
        <div className="nutrition-section-heading">
          <div>
            <h2>
              {isToday
                ? t("nutrition.view.todayMeals")
                : t("nutrition.view.dayMeals")}
            </h2>
            <span>
              {t("nutrition.view.recordCount", { count: itemCount })}
            </span>
          </div>
          <ForkKnife size={19} aria-hidden="true" />
        </div>

        {groupedMeals.length ? (
          <div className="nutrition-meal-list">
            {groupedMeals.map((group) => (
              <section className="meal-group" key={group.key}>
                <header>
                  <h3>{group.label}</h3>
                  <span>
                    {t("nutrition.view.itemCount", {
                      count: group.meals.reduce(
                      (total, meal) =>
                        total + Math.max(meal.items.length, 1),
                      0,
                      ),
                    })}
                  </span>
                </header>
                {group.meals.map((meal) => (
                  <MealRow
                    key={meal.mealId}
                    meal={meal}
                    timezone={timezone}
                    onUpdated={setData}
                    onRefresh={() => {
                      setLoading(true);
                      setRefreshNonce((value) => value + 1);
                    }}
                    onSuccess={setSuccessMessage}
                    onSaveAsCombo={setComboDraftMeal}
                    onSearchFoods={searchFoods}
                  />
                ))}
              </section>
            ))}
          </div>
        ) : (
          <div className="nutrition-empty">
            <p>
              {isToday
                ? t("nutrition.view.emptyToday")
                : t("nutrition.view.emptyDay")}
            </p>
            <span>
              {isToday
                ? t("nutrition.view.emptyTodayHint")
                : t("nutrition.view.emptyDayHint")}
            </span>
          </div>
        )}

        <details className="daily-nutrients">
          <summary>{t("nutrition.view.fullNutrition")}</summary>
          <div>
            {nutrientFields.map((field) => {
              const display = dailyNutrientLabel(
                data,
                field.key,
                field.unit,
                field.digits ?? 1,
                formatNumber,
                missingValue,
              );

              return (
                <span key={field.key}>
                  {t(`nutrition.nutrient.${field.key}`)}
                  <span className="daily-nutrient-value">
                    <strong>{display.value}</strong>
                    {display.partial ? (
                      <small>{t("nutrition.view.partial")}</small>
                    ) : null}
                  </span>
                </span>
              );
            })}
          </div>
        </details>
      </section>

      <NutritionTrend days={data.trend.days} />
        </>
      ) : null}

      {libraryOpen ? (
        <div
          className="library-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLibraryOpen(false);
          }}
        >
          <section
            ref={libraryDialogRef}
            className="food-library"
            role="dialog"
            aria-modal="true"
            aria-labelledby="food-library-title"
          >
            <header>
              <div>
                <h2 id="food-library-title">
                  {t("nutrition.view.library.title")}
                </h2>
                <span>{t("nutrition.view.library.subtitle")}</span>
              </div>
              <button
                type="button"
                aria-label={t("nutrition.view.library.close")}
                onClick={() => setLibraryOpen(false)}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>

            <div className="library-body">
              <aside>
                <label className="field-block">
                  <span>{t("nutrition.view.library.search")}</span>
                  <input
                    value={libraryQuery}
                    onChange={(event) =>
                      setLibraryQuery(event.target.value)
                    }
                    placeholder={t(
                      "nutrition.view.library.searchPlaceholder",
                    )}
                  />
                </label>
                <button
                  type="button"
                  className="library-new-button"
                  onClick={() => {
                    setLibraryError(null);
                    setEditor(emptyFoodEditor());
                    resetFoodEditorScroll();
                  }}
                >
                  <Plus size={16} aria-hidden="true" />
                  {t("nutrition.view.library.newFood")}
                </button>
                <div ref={libraryListRef} className="library-list">
                  {libraryFoods.slice(0, 80).map((food) => (
                    <button
                      type="button"
                      key={food.foodId}
                      className={
                        editor.foodId === food.foodId ? "is-active" : ""
                      }
                      onClick={() => selectLibraryFood(food)}
                    >
                      <span>{food.displayName}</span>
                      <small>
                        {food.isActive
                          ? food.defaultUnit
                          : t("nutrition.view.library.inactive")}
                      </small>
                    </button>
                  ))}
                </div>
              </aside>

              <form
                ref={foodEditorRef}
                className="food-editor"
                onSubmit={saveFood}
              >
                {libraryError ? (
                  <div className="library-inline-error" role="alert">
                    {libraryError}
                  </div>
                ) : null}
                <div className="food-editor-grid">
                  <label className="field-block">
                    <span>{t("nutrition.view.library.name")}</span>
                    <input
                      value={editor.displayName}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          displayName: event.target.value,
                        }))
                      }
                      required
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("nutrition.view.library.brand")}</span>
                    <input
                      value={editor.brand}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          brand: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("nutrition.view.library.baseQuantity")}</span>
                    <input
                      type="number"
                      min="0.001"
                      max="100000"
                      step="any"
                      value={editor.baseQuantity}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          baseQuantity: event.target.value,
                        }))
                      }
                      required
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("nutrition.view.library.unit")}</span>
                    <input
                      value={editor.baseUnit}
                      onChange={(event) =>
                        setEditor((current) => ({
                          ...current,
                          baseUnit: event.target.value,
                        }))
                      }
                      placeholder={t(
                        "nutrition.view.library.unitPlaceholder",
                      )}
                      required
                    />
                  </label>
                </div>

                <div className="food-nutrient-editor">
                  <p>{t("nutrition.view.library.nutrientBasis")}</p>
                  {nutrientFields.map((field) => (
                    <label className="field-block" key={field.key}>
                      <span>
                        {t(`nutrition.nutrient.${field.key}`)} ({field.unit})
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={editor.nutrients[field.key]}
                        onChange={(event) =>
                          updateEditorNutrient(
                            field.key,
                            event.target.value,
                          )
                        }
                        required={field.key === "energyKcal"}
                      />
                    </label>
                  ))}
                </div>

                <footer>
                  {editor.foodId ? (
                    <button
                      type="button"
                      className="danger-text-button"
                      onClick={() => void toggleFoodActive()}
                      disabled={busy === "food-status"}
                    >
                      {editor.isActive
                        ? t("nutrition.view.library.deactivate")
                        : t("nutrition.view.library.reactivate")}
                    </button>
                  ) : (
                    <span />
                  )}
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={busy === "food"}
                  >
                    {busy === "food"
                      ? t("nutrition.view.library.saving")
                      : editor.foodId
                        ? t("nutrition.view.library.saveVersion")
                        : t("nutrition.view.library.create")}
                  </button>
                </footer>
              </form>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
