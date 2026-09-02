"use client";

import { CaretDown } from "@phosphor-icons/react";
import { useI18n } from "@/components/i18n/I18nProvider";
import type {
  NutrientKey,
  NutrientPreview,
} from "@/lib/nutrition-preview";

type NutrientField = {
  key: NutrientKey;
  unit: string;
  digits: number;
};

const primaryFields: NutrientField[] = [
  { key: "energyKcal", unit: "kcal", digits: 0 },
  { key: "proteinG", unit: "g", digits: 1 },
  { key: "carbsG", unit: "g", digits: 1 },
  { key: "totalFatG", unit: "g", digits: 1 },
];

const secondaryFields: NutrientField[] = [
  { key: "saturatedFatG", unit: "g", digits: 1 },
  { key: "transFatG", unit: "g", digits: 1 },
  { key: "sugarG", unit: "g", digits: 1 },
  { key: "fibreG", unit: "g", digits: 1 },
  { key: "sodiumMg", unit: "mg", digits: 0 },
  { key: "cholesterolMg", unit: "mg", digits: 0 },
];

type NumberFormatter = (
  value: number,
  options?: Intl.NumberFormatOptions,
) => string;

function numberLabel(
  value: number,
  unit: string,
  digits: number,
  formatNumber: NumberFormatter,
) {
  return `${formatNumber(value, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })} ${unit}`;
}

function nutrientPreviewValueLabel(
  preview: NutrientPreview["values"][NutrientKey],
  unit: string,
  digits: number,
  formatNumber: NumberFormatter,
  noDataLabel: string,
  approximate = false,
) {
  if (preview.value === null) return noDataLabel;
  const prefix = preview.partial ? "≥" : approximate ? "≈" : "";
  return `${prefix}${numberLabel(preview.value, unit, digits, formatNumber)}`;
}

function metricAccessibleLabel(
  field: NutrientField,
  preview: NutrientPreview["values"][NutrientKey],
  approximate: boolean,
  formatNumber: NumberFormatter,
  t: (key: string) => string,
) {
  const value = nutrientPreviewValueLabel(
    preview,
    field.unit,
    field.digits,
    formatNumber,
    t("nutrition.value.noRecord"),
    approximate,
  );
  return `${t(`nutrition.nutrient.${field.key}`)} ${value}${preview.partial ? `, ${t("nutrition.preview.partial")}` : ""}`;
}

export function NutritionMacroStrip({
  preview,
  approximate = false,
}: {
  preview: NutrientPreview;
  approximate?: boolean;
}) {
  const { t, formatNumber } = useI18n();
  return (
    <span
      className="nutrition-macro-strip"
      role="group"
      aria-label={`${t("nutrition.preview.label")}${approximate ? ` (${t("nutrition.preview.estimated")})` : ""}`}
    >
      {primaryFields.map((field) => {
        const value = preview.values[field.key];
        const showEstimateCue = approximate && field.key === "energyKcal";
        return (
          <span
            className={`nutrition-macro-metric${value.value === null ? " is-missing" : ""}`}
            key={field.key}
            aria-label={metricAccessibleLabel(
              field,
              value,
              showEstimateCue,
              formatNumber,
              t,
            )}
            title={
              value.partial
                ? t("nutrition.preview.partialMinimum")
                : undefined
            }
          >
            <span>{t(`nutrition.nutrient.${field.key}`)}</span>
            <strong aria-hidden="true">
              {nutrientPreviewValueLabel(
                value,
                field.unit,
                field.digits,
                formatNumber,
                t("nutrition.value.noRecord"),
                showEstimateCue,
              )}
            </strong>
          </span>
        );
      })}
    </span>
  );
}

export function NutritionDetailPreview({
  preview,
  contextLabel,
  approximate = false,
}: {
  preview: NutrientPreview;
  contextLabel?: string;
  approximate?: boolean;
}) {
  const { t, formatNumber } = useI18n();
  const resolvedContextLabel =
    contextLabel ?? t("nutrition.preview.currentQuantity");
  return (
    <section className="nutrition-detail-preview">
      <header>
        <h3>{t("nutrition.preview.title")}</h3>
        <span>
          {approximate
            ? `${resolvedContextLabel} · ${t("nutrition.preview.estimated")}`
            : resolvedContextLabel}
        </span>
      </header>
      {preview.empty ? (
        <p>{t("nutrition.preview.empty")}</p>
      ) : preview.invalid ? (
        <p>{t("nutrition.preview.invalid")}</p>
      ) : (
        <>
          <NutritionMacroStrip preview={preview} />
          <details className="nutrition-detail-more">
            <summary>
              {t("nutrition.preview.more")}
              <CaretDown size={14} weight="bold" aria-hidden="true" />
            </summary>
            <div>
              {secondaryFields.map((field) => {
                const value = preview.values[field.key];
                return (
                  <span key={field.key}>
                    <span>{t(`nutrition.nutrient.${field.key}`)}</span>
                    <span>
                      <strong>
                        {nutrientPreviewValueLabel(
                          value,
                          field.unit,
                          field.digits,
                          formatNumber,
                          t("nutrition.value.noRecord"),
                        )}
                      </strong>
                      {value.partial ? (
                        <small>{t("nutrition.preview.partial")}</small>
                      ) : null}
                    </span>
                  </span>
                );
              })}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
