// Shapes the dashboards hand to their client charts. Money is in taka as
// a plain number here only because the charts plot it — every figure a
// person reads is formatted with formatBDT from the same value.
// Profit fields exist only on the owner's series (report.pl.view +
// product.cost.view); no other dashboard builds or sends them.

/** One day of the owner's 30-day charts. */
export type OwnerDayPoint = {
  day: string;
  label: string;
  /** Orders placed that day that count as sales — value by channel. */
  online: number;
  walkIn: number;
  orders: number;
  /** Revenue − COGS of goods that left that day, − that day's operating expenses. */
  profit: number;
  /** Returns (customer returns + parcels the courier brought back) and exchanges opened that day. */
  returns: number;
  exchanges: number;
};

export type ChannelSplit = { online: number; walkIn: number; onlineOrders: number; walkInOrders: number };
