import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nutritionMessages } from "../lib/i18n/messages/nutrition.ts";

const require = createRequire(import.meta.url);
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const compile = (text) => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

// Exercise the mounted effect with keyboard-sized visual viewport changes,
// without substituting a window resize for a real visual viewport resize.
function mountViewportEffect() {
  const text = source("components/FitnessApp.tsx");
  const tree = ts.createSourceFile("FitnessApp.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" &&
        node.arguments[0]?.getText(tree).includes("--dialog-viewport-height")) {
      callback = node.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(callback, "the app must mount visual viewport handling");
  const listeners = new Map();
  const properties = new Map();
  const frames = new Map();
  let frameId = 0;
  const viewport = {
    height: 844, offsetTop: 0,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => {
      assert.equal(listeners.get(name), listener);
      listeners.delete(name);
    },
  };
  const document = {
    documentElement: { style: {
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: (key) => properties.delete(key),
    } },
    activeElement: null,
  };
  class Field {
    scrolls = 0;
    matches() { return true; }
    closest() { return {}; }
    scrollIntoView(options) {
      assert.equal(options.block, "nearest");
      this.scrolls += 1;
    }
  }
  const window = {
    visualViewport: viewport,
    requestAnimationFrame: (fn) => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const mount = (visualViewport = viewport) => {
    window.visualViewport = visualViewport;
    return vm.runInNewContext(compile(`(${callback})()`), { window, document, HTMLElement: Field });
  };
  return { viewport, properties, frames, listeners, document, Field, mount };
}

test("dialogs follow keyboard height and pan, restore height and clean up listeners", () => {
  const state = mountViewportEffect();
  const cleanup = state.mount();
  assert.equal(state.properties.get("--dialog-viewport-height"), "844px");
  const field = new state.Field();
  state.document.activeElement = field;
  state.viewport.height = 430;
  state.listeners.get("resize")();
  assert.equal(state.properties.get("--dialog-viewport-height"), "430px");
  for (const callback of state.frames.values()) callback();
  assert.equal(field.scrolls, 1);
  state.viewport.offsetTop = 72;
  state.listeners.get("scroll")();
  assert.equal(state.properties.get("--dialog-viewport-top"), "72px");
  assert.equal(field.scrolls, 1, "panning must not trigger another scroll loop");
  state.viewport.height = 844;
  state.viewport.offsetTop = 0;
  state.listeners.get("resize")();
  assert.equal(state.properties.get("--dialog-viewport-height"), "844px");
  cleanup();
  assert.equal(state.listeners.size, 0);
  assert.equal(state.frames.size, 0);
  assert.equal(state.properties.size, 0);
});

test("viewport handling preserves the CSS fallback when the API is unavailable", () => {
  const state = mountViewportEffect();
  assert.equal(state.mount(null), undefined);
  assert.equal(state.properties.size, 0);
});

test("food summaries retain all macros, unknown values, zero and the 100g basis in every locale", () => {
  const code = compile(source("components/nutrition/NutritionPreview.tsx"));
  for (const locale of ["en", "zh-HK", "zh-TW", "zh-CN"]) {
    const exports = {};
    vm.runInNewContext(code, {
      exports,
      require: (name) => name === "@/components/i18n/I18nProvider" ? {
        useI18n: () => ({
          t: (key) => nutritionMessages[locale][key],
          formatNumber: (value, options) => new Intl.NumberFormat(locale, options).format(value),
        }),
      } : name === "@phosphor-icons/react" ? {} : require(name),
    });
    const food = { baseQuantity: 1, defaultUnit: "100g", nutrients: {
      energyKcal: 125, proteinG: 10, carbsG: null, totalFatG: 0,
    } };
    const html = renderToStaticMarkup(React.createElement(exports.FoodNutrientSummary, { food }));
    assert.match(html, /125 kcal \/ 100 g/);
    assert.match(html, /10 g/);
    assert.match(html, />0 g</);
    assert.ok(html.includes(nutritionMessages[locale]["nutrition.value.notProvided"]));
    for (const key of ["proteinG", "carbsG", "totalFatG"]) {
      assert.ok(html.includes(nutritionMessages[locale][`nutrition.nutrient.${key}`]));
    }
    assert.doesNotMatch(html, /12500/);
  }
});
