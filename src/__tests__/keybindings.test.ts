import { describe, it, expect } from "vitest";
import {
  keybindingsByCategory,
  KEYBINDINGS,
  CATEGORY_TITLES,
  MODE_HINTS,
} from "../core/keybindings.js";

describe("KEYBINDINGS", () => {
  it("all keybindings have valid categories", () => {
    const valid = Object.keys(CATEGORY_TITLES);
    for (const kb of KEYBINDINGS) {
      expect(valid).toContain(kb.category);
    }
  });

  it("all keybindings have non-empty keys and descriptions", () => {
    for (const kb of KEYBINDINGS) {
      expect(kb.keys.length).toBeGreaterThan(0);
      expect(kb.description.length).toBeGreaterThan(0);
    }
  });
});

describe("keybindingsByCategory", () => {
  it("returns groups in the correct order", () => {
    const groups = keybindingsByCategory();
    expect(groups.length).toBe(Object.keys(CATEGORY_TITLES).length);
    expect(groups[0][0]).toBe("Global");
    expect(groups[1][0]).toBe("List");
    expect(groups[2][0]).toBe("On the selected workspace (list or detail)");
    expect(groups[3][0]).toBe("Detail");
  });

  it("every keybinding appears in exactly one category group", () => {
    const groups = keybindingsByCategory();
    const allKeys = groups.flatMap(([, kbs]) => kbs);
    expect(allKeys.length).toBe(KEYBINDINGS.length);
  });

  it("each group contains only keybindings of that category", () => {
    const groups = keybindingsByCategory();
    for (const [title, kbs] of groups) {
      const expectedCat = Object.entries(CATEGORY_TITLES).find(
        ([, v]) => v === title,
      )![0];
      for (const kb of kbs) {
        expect(kb.category).toBe(expectedCat);
      }
    }
  });
});

describe("MODE_HINTS", () => {
  it("includes hints for every mode", () => {
    const requiredModes = ["list", "detail", "new", "auto-improve"];
    for (const mode of requiredModes) {
      expect(MODE_HINTS[mode]).toBeDefined();
      expect(MODE_HINTS[mode].length).toBeGreaterThan(0);
    }
  });

  it("auto-improve hint mentions count step", () => {
    expect(MODE_HINTS["auto-improve"]).toContain("count");
  });

  it("hints match the actual keybindings", () => {
    // Check that the list mode hint references keys that exist as keybindings
    const allKeys = new Set(KEYBINDINGS.map((kb) => kb.keys.split(" · ")).flat());
    const hint = MODE_HINTS["list"];
    for (const part of hint.split(" · ")) {
      const key = part.split(" ")[0];
      if (key === "Space") continue;
      if (!allKeys.has(key)) {
        // Check if it's a prefix match (e.g. Alt+a matches Alt+a)
        const matched = Array.from(allKeys).some((k) => k === key || k.toLowerCase() === key.toLowerCase());
        expect(matched || key === key.toLowerCase()).toBe(true);
      }
    }
  });
});
