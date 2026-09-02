import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationJournal = JSON.parse(
  readFileSync(
    new URL("../drizzle/meta/_journal.json", import.meta.url),
    "utf8",
  ),
);
const migrationFiles = migrationJournal.entries.map(
  (entry) => `${entry.tag}.sql`,
);

function scalar(database, query) {
  return Object.values(database.prepare(query).get())[0];
}

test("nutrition migrations create the schema without bundled user records", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");

  for (const fileName of migrationFiles) {
    const sql = readFileSync(
      new URL(`../drizzle/${fileName}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean)) {
      database.exec(statement);
    }
  }

  for (const tableName of [
    "nutrition_foods",
    "nutrition_food_versions",
    "nutrition_food_aliases",
    "nutrition_meals",
    "nutrition_meal_revisions",
    "nutrition_meal_items",
    "nutrition_energy_observations",
    "nutrition_settings",
    "nutrition_import_log",
  ]) {
    assert.equal(scalar(database, `SELECT count(*) FROM ${tableName}`), 0);
  }
  assert.equal(
    scalar(
      database,
      "SELECT count(*) FROM pragma_table_info('nutrition_meals') WHERE name = 'voided_at'",
    ),
    1,
  );
  assert.equal(
    scalar(
      database,
      "SELECT count(*) FROM pragma_table_info('nutrition_settings') WHERE name = 'calorie_target_kcal' AND \"notnull\" = 0",
    ),
    1,
  );
  assert.equal(
    scalar(
      database,
      "SELECT count(*) FROM nutrition_meals WHERE voided_at IS NOT NULL",
    ),
    0,
  );
  for (const [tableName, foreignKeyCount] of Object.entries({
    nutrition_combos: 0,
    nutrition_combo_versions: 1,
    nutrition_combo_items: 3,
    nutrition_meal_combo_sources: 2,
    nutrition_meal_plans: 1,
    nutrition_meal_plan_items: 3,
  })) {
    assert.equal(
      scalar(
        database,
        `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '${tableName}'`,
      ),
      1,
    );
    assert.equal(scalar(database, `SELECT count(*) FROM ${tableName}`), 0);
    assert.equal(
      scalar(
        database,
        `SELECT count(*) FROM pragma_foreign_key_list('${tableName}')`,
      ),
      foreignKeyCount,
    );
  }
  assert.equal(
    scalar(
      database,
      "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'nutrition_combo_items_version_food_uq'",
    ),
    1,
  );
  assert.equal(
    scalar(
      database,
      "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'nutrition_meal_plan_items_plan_ordinal_uq'",
    ),
    1,
  );
  assert.equal(
    scalar(database, "SELECT count(*) FROM pragma_foreign_key_check"),
    0,
  );
  assert.equal(scalar(database, "PRAGMA integrity_check"), "ok");

  database.close();
});
