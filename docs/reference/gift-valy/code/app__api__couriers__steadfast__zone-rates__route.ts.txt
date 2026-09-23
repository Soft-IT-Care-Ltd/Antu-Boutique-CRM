import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requirePermission, apiError } from "@/lib/authz";
import { logAudit } from "@/lib/audit";
import { DELIVERY_ZONES } from "@/lib/order-constants";
import { STEADFAST_COURIER_NAME } from "@/lib/steadfast-constants";
import {
  SETTING_KEYS,
  getCourierOverchargeTolerancePct,
  getCourierStuckThresholds,
} from "@/lib/settings";

// CORRECTIONS Courier §1/§2 — the 3-zone courier cost rate table (base + per-kg
// per zone) on the Courier page. Only Steadfast is exposed in the UI, but the
// storage is per courier so more couriers slot in later without a rebuild.
// Requires courier.manage (the same gate as handover/estimates).

const rateSchema = z.object({
  zone: z.enum(["INSIDE_DHAKA", "SUB_DHAKA", "OUTSIDE_DHAKA"]),
  baseRate: z.number().min(0),
  perKgRate: z.number().min(0),
});

const bodySchema = z.object({
  rates: z.array(rateSchema).max(DELIVERY_ZONES.length),
  // §R4 — overcharge alert tolerance (percent). Optional so older clients that
  // only send rates keep working.
  overchargeTolerancePct: z.number().min(0).max(100).optional(),
  // §R6 — stuck-parcel escalation thresholds (days). Both optional; the higher
  // is floored to the lower when read so the escalation never inverts.
  stuckAmberDays: z.number().min(0).max(365).optional(),
  stuckRedDays: z.number().min(0).max(365).optional(),
});

async function steadfastCourierId(userId?: number): Promise<number> {
  const courier = await prisma.courier.upsert({
    where: { name: STEADFAST_COURIER_NAME },
    update: {},
    create: {
      name: STEADFAST_COURIER_NAME,
      isActive: true,
      createdBy: userId ?? null,
    },
    select: { id: true },
  });
  return courier.id;
}

export async function GET() {
  try {
    await requirePermission("courier.manage");
    const courierId = await steadfastCourierId();
    const rates = await prisma.courierZoneRate.findMany({
      where: { courierId },
    });
    const stuck = await getCourierStuckThresholds();
    return NextResponse.json({
      rates: DELIVERY_ZONES.map((zone) => {
        const r = rates.find((row) => row.zone === zone);
        return {
          zone,
          baseRate: r ? Number(r.baseRate) : 0,
          perKgRate: r ? Number(r.perKgRate) : 0,
        };
      }),
      overchargeTolerancePct: await getCourierOverchargeTolerancePct(),
      stuckAmberDays: stuck.amberDays,
      stuckRedDays: stuck.redDays,
    });
  } catch (e) {
    return apiError(e);
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requirePermission("courier.manage");
    const { rates, overchargeTolerancePct, stuckAmberDays, stuckRedDays } =
      bodySchema.parse(await req.json());
    const courierId = await steadfastCourierId(session.user.id);

    const round2 = (n: number) => Math.round(n * 100) / 100;
    await prisma.$transaction(async (tx) => {
      for (const r of rates) {
        await tx.courierZoneRate.upsert({
          where: { courierId_zone: { courierId, zone: r.zone } },
          update: { baseRate: round2(r.baseRate), perKgRate: round2(r.perKgRate) },
          create: {
            courierId,
            zone: r.zone,
            baseRate: round2(r.baseRate),
            perKgRate: round2(r.perKgRate),
          },
        });
      }
      // §R4 — persist the overcharge tolerance in the settings table (JSON value).
      if (overchargeTolerancePct != null) {
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.courierOverchargeTolerancePct },
          update: { value: round2(overchargeTolerancePct) },
          create: {
            key: SETTING_KEYS.courierOverchargeTolerancePct,
            value: round2(overchargeTolerancePct),
          },
        });
      }
      // §R6 — persist the stuck-parcel escalation thresholds (whole days).
      if (stuckAmberDays != null) {
        const v = Math.round(stuckAmberDays);
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.courierStuckAmberDays },
          update: { value: v },
          create: { key: SETTING_KEYS.courierStuckAmberDays, value: v },
        });
      }
      if (stuckRedDays != null) {
        const v = Math.round(stuckRedDays);
        await tx.setting.upsert({
          where: { key: SETTING_KEYS.courierStuckRedDays },
          update: { value: v },
          create: { key: SETTING_KEYS.courierStuckRedDays, value: v },
        });
      }
    });

    await logAudit({
      userId: session.user.id,
      action: "courier.zone_rates.update",
      entity: "courier_zone_rates",
      entityId: courierId,
      after: { rates },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
