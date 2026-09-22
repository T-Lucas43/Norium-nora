import { describe, expect, it } from "vitest";
import { defaultPeriods, periodsFromWeekly, subtractLunch, weeklyFromPeriods } from "./availability";

describe("scheduling availability helpers", () => {
  it("loads defaults for weekdays only", () => {
    const periods = defaultPeriods();
    expect(Object.keys(periods)).toHaveLength(7);
    expect(periods["0"].enabled).toBe(true);
    expect(periods["5"].enabled).toBe(false);
  });

  it("round-trips multiple periods per day exactly", () => {
    const weekly = {
      "0": [{ start: "08:00", end: "12:00" }, { start: "14:00", end: "18:00" }],
      "2": [{ start: "09:00", end: "17:00" }],
    };
    const back = weeklyFromPeriods(periodsFromWeekly(weekly), { enabled: false, start: "12:00", end: "14:00" });
    expect(back["0"]).toEqual(weekly["0"]);
    expect(back["2"]).toEqual(weekly["2"]);
    expect(back["1"]).toEqual([]);
    expect(Object.keys(back)).toHaveLength(7);
  });

  it("drops invalid stored periods without inventing data", () => {
    const periods = periodsFromWeekly({ "0": [{ start: "18:00", end: "08:00" }, { start: "xx", end: "yy" }] });
    expect(periods["0"].enabled).toBe(false);
    expect(periods["0"].slots).toEqual([{ start: "08:00", end: "18:00" }]);
  });

  it("subtracts lunch idempotently", () => {
    const lunch = { enabled: true, start: "12:00", end: "14:00" };
    const once = subtractLunch([{ start: "08:00", end: "18:00" }], lunch);
    expect(once).toEqual([{ start: "08:00", end: "12:00" }, { start: "14:00", end: "18:00" }]);
    expect(subtractLunch(once, lunch)).toEqual(once);
  });

  it("keeps slots outside lunch untouched", () => {
    const lunch = { enabled: true, start: "12:00", end: "14:00" };
    expect(subtractLunch([{ start: "08:00", end: "10:00" }], lunch)).toEqual([{ start: "08:00", end: "10:00" }]);
    expect(subtractLunch([{ start: "08:00", end: "18:00" }], { ...lunch, enabled: false })).toEqual([{ start: "08:00", end: "18:00" }]);
  });
});
