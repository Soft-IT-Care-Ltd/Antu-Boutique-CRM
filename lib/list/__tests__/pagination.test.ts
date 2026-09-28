import { describe, expect, it } from "vitest";

import { pageArgs, pageInfo, readPageParams } from "@/lib/list/pagination";
import { ORDER_TAB_BY_KEY, ORDER_TABS, tabForStatus } from "@/lib/orders/tabs";
import { ORDER_STATUS_VALUES } from "@/lib/orders/constants";

describe("pagination (CORRECTIONS.md item 15)", () => {
  it("says showing X–Y of Z", () => {
    expect(pageInfo(0, 1, 25)).toEqual({ totalPages: 1, first: 0, last: 0 });
    expect(pageInfo(60, 1, 25)).toEqual({ totalPages: 3, first: 1, last: 25 });
    expect(pageInfo(60, 3, 25)).toEqual({ totalPages: 3, first: 51, last: 60 });
    expect(pageArgs({ page: 3, pageSize: 50 })).toEqual({ skip: 100, take: 50 });
  });

  it("only takes 25 / 50 / 100 from a URL, else the saved size", () => {
    expect(readPageParams({ page: "2", pageSize: "50" }, 25)).toEqual({ page: 2, pageSize: 50 });
    expect(readPageParams({ pageSize: "37" }, 100)).toEqual({ page: 1, pageSize: 100 });
    expect(readPageParams({ page: "-4" }, 25)).toEqual({ page: 1, pageSize: 25 });
  });
});

describe("order tabs (CORRECTIONS.md item 14)", () => {
  it("puts every status under a tab, so no order is hidden", () => {
    const covered = new Set(ORDER_TABS.flatMap((t) => (t.statuses === "all" ? [] : t.statuses)));
    for (const s of ORDER_STATUS_VALUES) expect(covered.has(s), s).toBe(true);
  });

  it("keeps open work out of the date filter and finished tabs in it", () => {
    expect(ORDER_TABS.filter((t) => t.open).map((t) => t.key)).toEqual(["needs_confirmation", "waiting_for_stock", "needs_transfer", "ready_to_pack", "on_hold", "packed", "with_courier"]);
    expect(ORDER_TABS.filter((t) => !t.open).map((t) => t.key)).toEqual(["delivered", "completed", "returns", "cancelled", "all"]);
  });

  it("opens a status link on the tab that holds it", () => {
    for (const s of ORDER_STATUS_VALUES) {
      const { tab } = tabForStatus(s);
      const statuses = ORDER_TAB_BY_KEY[tab].statuses;
      expect(statuses === "all" || statuses.includes(s), s).toBe(true);
    }
    expect(tabForStatus("CONFIRMED")).toEqual({ tab: "ready_to_pack" });
    expect(tabForStatus("HANDED_TO_COURIER")).toEqual({ tab: "with_courier", sub: "handed_over" });
    expect(tabForStatus("LEAD")).toEqual({ tab: "needs_confirmation" });
  });
});
