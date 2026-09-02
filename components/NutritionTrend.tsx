"use client";

import { ChartBar } from "@phosphor-icons/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { NutritionTrendDay } from "@/lib/nutrition";

type TrendKind = "energy" | "protein";

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function shortDate(
  value: string,
  formatDate: ReturnType<typeof useI18n>["formatDate"],
  weekday = false,
) {
  return formatDate(value, {
    month: "numeric",
    day: "numeric",
    ...(weekday ? { weekday: "short" as const } : {}),
  });
}

function valueLabel(
  value: number | null,
  unit: string,
  digits: number,
  formatNumber: ReturnType<typeof useI18n>["formatNumber"],
  noRecord: string,
) {
  if (value === null) return noRecord;
  return `${formatNumber(value, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })} ${unit}`;
}

function differenceLabel(
  value: number | null,
  target: number | null,
  unit: string,
  formatNumber: ReturnType<typeof useI18n>["formatNumber"],
  t: ReturnType<typeof useI18n>["t"],
) {
  if (value === null || target === null) return null;
  const difference = value - target;
  if (Math.abs(difference) < 0.05) {
    return t("nutrition.trend.sameTarget");
  }
  const differenceValue = `${formatNumber(Math.abs(difference), {
    maximumFractionDigits: unit === "kcal" ? 0 : 1,
  })} ${unit}`;
  return t(
    difference > 0
      ? "nutrition.trend.aboveTarget"
      : "nutrition.trend.belowTarget",
    { value: differenceValue },
  );
}

function activityLabel(
  state: NutritionTrendDay["activityState"],
  t: ReturnType<typeof useI18n>["t"],
) {
  if (state === "final") return t("nutrition.trend.activityFinal");
  if (state === "provisional") {
    return t("nutrition.trend.activityProvisional");
  }
  return t("nutrition.trend.activityMissing");
}

export function NutritionTrend({ days }: { days: NutritionTrendDay[] }) {
  const { t, formatDate, formatNumber } = useI18n();
  const [kind, setKind] = useState<TrendKind>("energy");
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chart = useMemo(() => {
    const width = 360;
    const height = 132;
    const top = 12;
    const bottom = 108;
    const values = days.map((day) =>
      kind === "energy" ? day.energyKcal : day.proteinG,
    );
    const targets = days.map((day) =>
      kind === "energy" ? day.energyTargetKcal : day.proteinTargetG,
    );
    const knownValues = values.filter(
      (value): value is number => value !== null,
    );
    const knownTargets = targets.filter(
      (value): value is number => value !== null,
    );
    const maximum = Math.max(1, ...knownValues, ...knownTargets);
    const chartMaximum = maximum * 1.12;
    const slotWidth = width / Math.max(days.length, 1);
    const barWidth = Math.min(15, slotWidth * 0.58);
    const yFor = (value: number) =>
      bottom - (value / chartMaximum) * (bottom - top);
    const xFor = (index: number) => slotWidth * (index + 0.5);
    const targetPath = targets
      .map((target, index) => {
        if (target === null) return "";
        const command =
          index > 0 && targets[index - 1] !== null ? "L" : "M";
        return `${command} ${xFor(index).toFixed(2)} ${yFor(target).toFixed(2)}`;
      })
      .filter(Boolean)
      .join(" ");

    return {
      width,
      height,
      top,
      bottom,
      slotWidth,
      barWidth,
      values,
      targets,
      knownValues,
      knownTargets,
      targetPath,
      yFor,
      xFor,
    };
  }, [days, kind]);

  useEffect(() => {
    if (!pinned) return;
    function closeOutside(event: PointerEvent) {
      if (!chartRef.current?.contains(event.target as Node)) {
        setPinned(false);
        setActiveIndex(null);
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [pinned]);

  const unit = kind === "energy" ? "kcal" : "g";
  const digits = kind === "energy" ? 0 : 1;
  const title = t(
    kind === "energy"
      ? "nutrition.trend.energy"
      : "nutrition.trend.protein",
  );
  const recordedAverage = average(chart.knownValues);
  const targetAverage = average(chart.knownTargets);
  const finalActivityDays = days.filter(
    (day) => day.activityState === "final",
  ).length;
  const activeDay =
    activeIndex === null ? null : days[activeIndex] ?? null;
  const activeValue = activeDay
    ? kind === "energy"
      ? activeDay.energyKcal
      : activeDay.proteinG
    : null;
  const activeTarget = activeDay
    ? kind === "energy"
      ? activeDay.energyTargetKcal
      : activeDay.proteinTargetG
    : null;

  function indexAtPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - bounds.left) / Math.max(bounds.width, 1);
    return Math.min(
      days.length - 1,
      Math.max(0, Math.floor(ratio * days.length)),
    );
  }

  return (
    <section className="nutrition-trend">
      <div className="nutrition-trend-heading">
        <div>
          <h2>{t("nutrition.trend.title")}</h2>
          <span>{t("nutrition.trend.blank")}</span>
        </div>
        <div
          className="nutrition-trend-toggle"
          role="group"
          aria-label={t("nutrition.trend.type")}
        >
          {(
            [
              ["energy", t("nutrition.trend.energy")],
              ["protein", t("nutrition.trend.protein")],
            ] as Array<[TrendKind, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={kind === id ? "is-active" : ""}
              aria-pressed={kind === id}
              onClick={() => {
                setKind(id);
                setActiveIndex(null);
                setPinned(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {chart.knownValues.length === 0 ? (
        <div className="nutrition-trend-empty">
          <ChartBar size={22} aria-hidden="true" />
          <span>{t("nutrition.trend.empty", { kind: title })}</span>
        </div>
      ) : (
        <>
          <div className="nutrition-trend-summary">
            <div>
              <span>{t("nutrition.trend.recordedAverage")}</span>
              <strong>
                {valueLabel(
                  recordedAverage === null
                    ? null
                    : Math.round(recordedAverage * 10) / 10,
                  unit,
                  digits,
                  formatNumber,
                  t("nutrition.value.noRecord"),
                )}
              </strong>
            </div>
            <span>
              {kind === "energy"
                ? t("nutrition.trend.energyCoverage", {
                    known: chart.knownValues.length,
                    total: days.length,
                    final: finalActivityDays,
                  })
                : t("nutrition.trend.proteinCoverage", {
                    known: chart.knownValues.length,
                    total: days.length,
                  })}
              {targetAverage === null
                ? ""
                : ` · ${t("nutrition.trend.targetAverage", {
                    value: valueLabel(
                      targetAverage,
                      unit,
                      digits,
                      formatNumber,
                      t("nutrition.value.noRecord"),
                    ),
                  })}${kind === "energy" ? ` (${t("nutrition.trend.provisionalSuffix")})` : ""}`}
            </span>
          </div>

          <div className="nutrition-chart-plot" ref={chartRef}>
            <svg
              className="nutrition-trend-chart"
              viewBox={`0 0 ${chart.width} ${chart.height}`}
              role="group"
              aria-label={t("nutrition.trend.chartLabel", { kind: title })}
              onPointerMove={(event) => {
                if (event.pointerType === "mouse" && !pinned) {
                  setActiveIndex(indexAtPointer(event));
                }
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse" && !pinned) {
                  setActiveIndex(null);
                }
              }}
              onPointerDown={(event) => {
                setActiveIndex(indexAtPointer(event));
                setPinned(true);
              }}
            >
              <line
                x1="0"
                y1={chart.bottom}
                x2={chart.width}
                y2={chart.bottom}
                className="nutrition-trend-baseline"
                aria-hidden="true"
              />
              {chart.values.map((value, index) => {
                if (value === null) return null;
                const x = chart.xFor(index) - chart.barWidth / 2;
                const y = chart.yFor(value);
                return (
                  <rect
                    key={days[index].localDate}
                    x={x}
                    y={y}
                    width={chart.barWidth}
                    height={Math.max(chart.bottom - y, 1)}
                    rx="3"
                    className="nutrition-trend-bar"
                    aria-hidden="true"
                  />
                );
              })}
              {chart.targetPath ? (
                <path
                  d={chart.targetPath}
                  className="nutrition-trend-target"
                  aria-hidden="true"
                />
              ) : null}
              {chart.targets.map((target, index) =>
                target === null ? null : (
                  <circle
                    key={`target-${days[index].localDate}`}
                    cx={chart.xFor(index)}
                    cy={chart.yFor(target)}
                    r="2.2"
                    className="nutrition-trend-target-point"
                    aria-hidden="true"
                  />
                ),
              )}
              {days.map((day, index) => (
                <g
                  key={`hit-${day.localDate}`}
                  role="button"
                  tabIndex={0}
                  aria-label={t("nutrition.trend.dayLabel", {
                    date: shortDate(day.localDate, formatDate, true),
                    value: valueLabel(
                      chart.values[index],
                      unit,
                      digits,
                      formatNumber,
                      t("nutrition.value.noRecord"),
                    ),
                    target: valueLabel(
                      chart.targets[index],
                      unit,
                      digits,
                      formatNumber,
                      t("nutrition.value.noRecord"),
                    ),
                    activity:
                      kind === "energy"
                        ? `, ${activityLabel(day.activityState, t)}`
                        : "",
                  })}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => {
                    if (!pinned) setActiveIndex(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setActiveIndex(index);
                      setPinned(true);
                    }
                    if (event.key === "Escape") {
                      setPinned(false);
                      setActiveIndex(null);
                    }
                  }}
                >
                  <rect
                    x={index * chart.slotWidth}
                    y={chart.top}
                    width={chart.slotWidth}
                    height={chart.bottom - chart.top}
                    className="nutrition-trend-hit-area"
                  />
                </g>
              ))}
              {activeIndex !== null ? (
                <line
                  x1={chart.xFor(activeIndex)}
                  y1={chart.top}
                  x2={chart.xFor(activeIndex)}
                  y2={chart.bottom}
                  className="nutrition-trend-selection"
                  aria-hidden="true"
                />
              ) : null}
            </svg>

            {activeDay ? (
              <div
                className="chart-tooltip nutrition-chart-tooltip"
                role="status"
                aria-live="polite"
                style={{
                  left: `${Math.min(78, Math.max(22, (chart.xFor(activeIndex!) / chart.width) * 100))}%`,
                  top: "4px",
                }}
              >
                <span>{shortDate(activeDay.localDate, formatDate, true)}</span>
                <strong>
                  {valueLabel(
                    activeValue,
                    unit,
                    digits,
                    formatNumber,
                    t("nutrition.value.noRecord"),
                  )}
                </strong>
                <small>
                  {t("nutrition.trend.target", {
                    value: valueLabel(
                      activeTarget,
                      unit,
                      digits,
                      formatNumber,
                      t("nutrition.value.noRecord"),
                    ),
                  })}
                  {differenceLabel(
                    activeValue,
                    activeTarget,
                    unit,
                    formatNumber,
                    t,
                  )
                    ? `, ${differenceLabel(
                        activeValue,
                        activeTarget,
                        unit,
                        formatNumber,
                        t,
                      )}`
                    : ""}
                </small>
                {kind === "energy" ? (
                  <small>{activityLabel(activeDay.activityState, t)}</small>
                ) : null}
              </div>
            ) : null}
          </div>

          <ul className="sr-only">
            {days.map((day, index) => (
              <li key={`accessible-${day.localDate}`}>
                {t("nutrition.trend.dayLabel", {
                  date: shortDate(day.localDate, formatDate, true),
                  value: valueLabel(
                    chart.values[index],
                    unit,
                    digits,
                    formatNumber,
                    t("nutrition.value.noRecord"),
                  ),
                  target: valueLabel(
                    chart.targets[index],
                    unit,
                    digits,
                    formatNumber,
                    t("nutrition.value.noRecord"),
                  ),
                  activity:
                    kind === "energy"
                      ? `, ${activityLabel(day.activityState, t)}`
                      : "",
                })}
              </li>
            ))}
          </ul>

          <div className="nutrition-trend-footer">
            <span>
              {days[0] ? shortDate(days[0].localDate, formatDate) : ""}
            </span>
            <span>
              {kind === "energy"
                ? t("nutrition.trend.energyLegend")
                : t("nutrition.trend.proteinLegend")}
            </span>
            <span>
              {days.at(-1)
                ? shortDate(days.at(-1)!.localDate, formatDate)
                : ""}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
