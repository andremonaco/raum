import { describe, expect, it } from "vitest";

import { formatRelativeShort } from "./relativeTime";

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;

function ago(seconds: number): string {
  return formatRelativeShort(NOW_S - seconds, NOW_MS);
}

describe("formatRelativeShort", () => {
  it("clamps sub-minute and future timestamps to now", () => {
    expect(ago(0)).toBe("now");
    expect(ago(59)).toBe("now");
    expect(ago(-3600)).toBe("now");
  });

  it("rolls through minute, hour, day, week, month, year units", () => {
    expect(ago(60)).toBe("1m");
    expect(ago(90)).toBe("1m");
    expect(ago(59 * 60)).toBe("59m");
    expect(ago(60 * 60)).toBe("1h");
    expect(ago(23 * 3600)).toBe("23h");
    expect(ago(24 * 3600)).toBe("1d");
    expect(ago(6 * 86_400)).toBe("6d");
    expect(ago(7 * 86_400)).toBe("1w");
    expect(ago(29 * 86_400)).toBe("4w");
    expect(ago(30 * 86_400)).toBe("1mo");
    expect(ago(11 * 30 * 86_400)).toBe("11mo");
    expect(ago(365 * 86_400)).toBe("1y");
    expect(ago(2 * 365 * 86_400)).toBe("2y");
  });

  it("never emits 0y in the month/year boundary gap", () => {
    // 360–364 days: 12 "months" but less than a year — must not be "0y".
    expect(ago(362 * 86_400)).toBe("1y");
  });
});
