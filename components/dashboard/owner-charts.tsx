"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { ordersHref, profitHref, returnsHref, type DayRange } from "@/lib/dashboard/links";
import type { ChannelSplit, OwnerDayPoint } from "@/lib/dashboard/types";
import { formatBDT } from "@/lib/money";

// P4.3 (PRD §4.16) — the owner's 30-day charts. Every bar and slice is a
// link: a day's sales bar opens that day's orders, a profit bar opens that
// day's profit breakdown. Colours follow the entity (online is always blue,
// walk-in always orange) and each chart has a table view below it.

const GRID = "var(--border)";
const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 11 };

/** ৳ 1.2L / ৳ 45k — axis ticks only; every value a person reads is formatBDT. */
function compactTaka(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 100_000) return `${sign}৳${(a / 100_000).toFixed(a >= 1_000_000 ? 0 : 1)}L`;
  if (a >= 1_000) return `${sign}৳${Math.round(a / 1_000)}k`;
  return `${sign}৳${a}`;
}

type TipRow = { color: string; label: string; value: string };

function TipBox({ title, rows, hint }: { title: string; rows: TipRow[]; hint?: string }) {
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
          <span className="text-muted-foreground">{r.label}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{r.value}</span>
        </p>
      ))}
      {hint ? <p className="mt-1 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ backgroundColor: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function TableView({ children }: { children: ReactNode }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">Show as a table</summary>
      <div className="mt-2 max-h-64 overflow-y-auto">{children}</div>
    </details>
  );
}

type TipProps = { active?: boolean; payload?: readonly { payload?: unknown }[] };

/** The day a tooltip is over, or null when it's hidden. */
const tipDay = ({ active, payload }: TipProps) => (active && payload?.length ? (payload[0].payload as OwnerDayPoint) : null);

/** Recharts hands a bar's click the datum it drew. */
const dayOf = (entry: unknown) => (entry as { payload?: OwnerDayPoint })?.payload?.day;

// ─── Sales trend ────────────────────────────────────────────────────────

export function SalesTrendChart({ days }: { days: OwnerDayPoint[] }) {
  const router = useRouter();
  const open = (entry: unknown) => {
    const day = dayOf(entry);
    if (day) router.push(ordersHref({ preset: "sales", range: { from: day, to: day } }));
  };
  return (
    <div className="flex flex-col gap-2">
      <Legend
        items={[
          { color: "var(--viz-online)", label: "Online" },
          { color: "var(--viz-walk-in)", label: "Walk-in" },
        ]}
      />
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={days} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={compactTaka} width={52} />
            <Tooltip
              cursor={{ fill: "var(--muted)" }}
              content={(props: TipProps) => {
                const d = tipDay(props);
                return d ? (
                  <TipBox
                    title={d.label}
                    rows={[
                      { color: "var(--viz-online)", label: "Online", value: formatBDT(d.online) },
                      { color: "var(--viz-walk-in)", label: "Walk-in", value: formatBDT(d.walkIn) },
                    ]}
                    hint={`${d.orders} orders · click to open them`}
                  />
                ) : null;
              }}
            />
            <Bar dataKey="online" stackId="s" fill="var(--viz-online)" stroke="var(--card)" strokeWidth={1} maxBarSize={24} className="cursor-pointer" onClick={open} />
            <Bar dataKey="walkIn" stackId="s" fill="var(--viz-walk-in)" stroke="var(--card)" strokeWidth={1} maxBarSize={24} radius={[4, 4, 0, 0]} className="cursor-pointer" onClick={open} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TableView>
        <DayTable
          days={days}
          columns={[
            { label: "Orders", render: (d) => d.orders },
            { label: "Online", render: (d) => formatBDT(d.online) },
            { label: "Walk-in", render: (d) => formatBDT(d.walkIn) },
          ]}
          href={(d) => ordersHref({ preset: "sales", range: { from: d.day, to: d.day } })}
        />
      </TableView>
    </div>
  );
}

// ─── Channel split ──────────────────────────────────────────────────────

export function ChannelSplitChart({ split, range }: { split: ChannelSplit; range: DayRange }) {
  const router = useRouter();
  const total = split.online + split.walkIn;
  const slices = [
    { key: "ONLINE" as const, label: "Online", value: split.online, orders: split.onlineOrders, color: "var(--viz-online)" },
    { key: "WALK_IN" as const, label: "Walk-in", value: split.walkIn, orders: split.walkInOrders, color: "var(--viz-walk-in)" },
  ];
  const share = (v: number) => (total > 0 ? `${Math.round((v / total) * 100)}%` : "—");
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="h-40 w-40 shrink-0">
        {total > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="label"
                innerRadius="62%"
                outerRadius="100%"
                stroke="var(--card)"
                strokeWidth={2}
                startAngle={90}
                endAngle={-270}
                className="cursor-pointer"
                onClick={(entry: unknown) => {
                  const key = (entry as { payload?: { key?: "ONLINE" | "WALK_IN" } })?.payload?.key;
                  if (key) router.push(ordersHref({ preset: "sales", channel: key, range }));
                }}
              >
                {slices.map((s) => (
                  <Cell key={s.key} fill={s.color} />
                ))}
              </Pie>
              <Tooltip
                content={({ active, payload }: TipProps) => {
                  const slice = active && payload?.length ? (payload[0].payload as (typeof slices)[number]) : null;
                  return slice ? <TipBox title={slice.label} rows={[{ color: slice.color, label: `${slice.orders} orders`, value: formatBDT(slice.value) }]} /> : null;
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex size-full items-center justify-center rounded-full border-8 border-muted text-xs text-muted-foreground">No sales</div>
        )}
      </div>
      <ul className="flex w-full flex-col gap-2">
        {slices.map((s) => (
          <li key={s.key}>
            <Link href={ordersHref({ preset: "sales", channel: s.key, range })} className="flex items-center gap-2 rounded-md p-1.5 hover:bg-muted">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
              <span className="text-sm">{s.label}</span>
              <span className="ml-auto text-right">
                <span className="block font-semibold tabular-nums">{formatBDT(s.value)}</span>
                <span className="block text-xs text-muted-foreground tabular-nums">
                  {share(s.value)} · {s.orders} orders
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Profit trend ───────────────────────────────────────────────────────

export function ProfitTrendChart({ days }: { days: OwnerDayPoint[] }) {
  const router = useRouter();
  const open = (entry: unknown) => {
    const day = dayOf(entry);
    if (day) router.push(profitHref({ from: day, to: day }));
  };
  // Gains and losses are two series so each rounds away from the zero line.
  const data = days.map((d) => ({ ...d, gain: d.profit > 0 ? d.profit : 0, loss: d.profit < 0 ? d.profit : 0 }));
  return (
    <div className="flex flex-col gap-2">
      <Legend
        items={[
          { color: "var(--viz-online)", label: "Profit" },
          { color: "var(--viz-loss)", label: "Loss" },
        ]}
      />
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} stackOffset="sign">
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={compactTaka} width={52} />
            <Tooltip
              cursor={{ fill: "var(--muted)" }}
              content={(props: TipProps) => {
                const d = tipDay(props);
                return d ? (
                  <TipBox title={d.label} rows={[{ color: d.profit < 0 ? "var(--viz-loss)" : "var(--viz-online)", label: d.profit < 0 ? "Loss" : "Profit", value: formatBDT(d.profit) }]} hint="Click for the breakdown" />
                ) : null;
              }}
            />
            <Bar dataKey="gain" stackId="p" fill="var(--viz-online)" maxBarSize={24} radius={[4, 4, 0, 0]} className="cursor-pointer" onClick={open} />
            <Bar dataKey="loss" stackId="p" fill="var(--viz-loss)" maxBarSize={24} radius={[0, 0, 4, 4]} className="cursor-pointer" onClick={open} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TableView>
        <DayTable days={days} columns={[{ label: "Profit", render: (d) => formatBDT(d.profit) }]} href={(d) => profitHref({ from: d.day, to: d.day })} />
      </TableView>
    </div>
  );
}

// ─── Returns and exchanges ──────────────────────────────────────────────

export function ReturnsChart({ days }: { days: OwnerDayPoint[] }) {
  const router = useRouter();
  const open = () => router.push(returnsHref({ view: "report" }));
  return (
    <div className="flex flex-col gap-2">
      <Legend
        items={[
          { color: "var(--viz-returns)", label: "Returns" },
          { color: "var(--viz-exchanges)", label: "Exchanges" },
        ]}
      />
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={days} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
            <Tooltip
              cursor={{ fill: "var(--muted)" }}
              content={(props: TipProps) => {
                const d = tipDay(props);
                return d ? (
                  <TipBox
                    title={d.label}
                    rows={[
                      { color: "var(--viz-returns)", label: "Returns", value: String(d.returns) },
                      { color: "var(--viz-exchanges)", label: "Exchanges", value: String(d.exchanges) },
                    ]}
                  />
                ) : null;
              }}
            />
            <Bar dataKey="returns" stackId="r" fill="var(--viz-returns)" stroke="var(--card)" strokeWidth={1} maxBarSize={24} className="cursor-pointer" onClick={open} />
            <Bar dataKey="exchanges" stackId="r" fill="var(--viz-exchanges)" stroke="var(--card)" strokeWidth={1} maxBarSize={24} radius={[4, 4, 0, 0]} className="cursor-pointer" onClick={open} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <TableView>
        <DayTable
          days={days}
          columns={[
            { label: "Returns", render: (d) => d.returns },
            { label: "Exchanges", render: (d) => d.exchanges },
          ]}
          href={() => returnsHref({ view: "report" })}
        />
      </TableView>
    </div>
  );
}

function DayTable({ days, columns, href }: { days: OwnerDayPoint[]; columns: { label: string; render: (d: OwnerDayPoint) => ReactNode }[]; href: (d: OwnerDayPoint) => string }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="py-1 text-left font-medium">Day</th>
          {columns.map((c) => (
            <th key={c.label} className="py-1 text-right font-medium">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {[...days].reverse().map((d) => (
          <tr key={d.day} className="border-t">
            <td className="py-1">
              <Link href={href(d)} className="underline-offset-4 hover:underline">
                {d.label}
              </Link>
            </td>
            {columns.map((c) => (
              <td key={c.label} className="py-1 text-right tabular-nums">
                {c.render(d)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
