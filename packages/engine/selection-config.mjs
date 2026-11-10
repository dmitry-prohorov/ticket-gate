// The `selection` key of gate.config.mjs: the project values the e2e selection engine (./selection)
// reads. Validated at load time; a bad value throws Error('gate.config: selection: <what>').
// Graph sources, rules and test runners come from the config and from every pack's
// selectionGraphs, selectionRules and testRunners hooks (config first, then packs in packs order).
import { packHooksAll } from "./pack-hooks-all.mjs";
import { ROOT } from "./root.mjs";
import { SelectionConfigError, defineSelection } from "./selection/define.mjs";

export const SELECTION_HOOKS = Object.freeze([
  "selectionGraphs",
  "selectionRules",
  "testRunners",
]);

const KIND = {
  selectionGraphs: "graph source",
  selectionRules: "rule",
  testRunners: "test runner",
};

/** `{ by, item }` for the config's own items then every pack's, each checked to be a named object. */
function collect(hook, own, config, fail) {
  const rows = [];
  const add = (by, value) => {
    for (const item of [].concat(value)) {
      if (!item || typeof item !== "object" || typeof item.name !== "string")
        fail(
          "selection",
          `${KIND[hook]} from ${by} must be an object with a string name`,
        );
      rows.push({ by, item });
    }
  };
  if (own !== undefined) add("gate.config", own);
  for (const { by, value } of packHooksAll(hook, config)) add(by, value);
  const seen = new Map();
  for (const { by, item } of rows) {
    if (seen.has(item.name))
      fail(
        "selection",
        `${KIND[hook]} "${item.name}" is given by ${seen.get(item.name)} and ${by}`,
      );
    seen.set(item.name, by);
  }
  return rows;
}

/** Validates `config.selection` and returns the defined selection; `fail(where, what)` throws. */
export function selectionOf(config, fail) {
  const sel = config.selection;
  if (!sel || typeof sel !== "object" || Array.isArray(sel))
    fail("selection", "must be an object");
  const graphs = collect("selectionGraphs", sel.graphs, config, fail);
  const rules = collect("selectionRules", sel.rules, config, fail);
  const runners = collect("testRunners", undefined, config, fail);
  let runner = sel.runner;
  if (typeof runner === "string") {
    const found = runners.find((r) => r.item.name === runner);
    if (!found) {
      fail("selection", `no test runner named "${runner}"`);
    }
    runner = found.item;
  }
  try {
    return defineSelection({
      ...sel,
      root: sel.root ?? ROOT,
      graphs: graphs.map((r) => r.item),
      rules: rules.map((r) => r.item),
      runner,
    });
  } catch (e) {
    if (e instanceof SelectionConfigError) fail("selection", e.message);
    throw e;
  }
}
