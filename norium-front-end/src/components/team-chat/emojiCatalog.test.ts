import { describe, expect, it } from "vitest";
import { ALL_EMOJIS, EMOJI_CATEGORIES, QUICK_REACTIONS } from "./emojiCatalog";

describe("emojiCatalog", () => {
  it("offers a broad, categorized and unique emoji catalog", () => {
    expect(EMOJI_CATEGORIES.length).toBeGreaterThanOrEqual(8);
    expect(ALL_EMOJIS.length).toBeGreaterThan(350);
    expect(new Set(ALL_EMOJIS).size).toBe(ALL_EMOJIS.length);
    expect(QUICK_REACTIONS).toEqual(expect.arrayContaining(["👍", "❤️", "😂", "🎉"]));
  });
});
