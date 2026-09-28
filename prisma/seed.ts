import { PrismaClient, type OrderStatus as OrderStatusName, type RoleName } from "@prisma/client";
import bcrypt from "bcryptjs";

import { PERMISSIONS, ROLE_TEMPLATES } from "../lib/auth/permission-definitions";
import { buildVariantSku } from "../lib/catalog/codes";
// Imported, not duplicated: these take a transaction client and are free of
// "server-only", so demo stock moves through the exact code the app uses —
// the DB's stock/ledger consistency trigger would reject anything else.
import { adjustStock, writeOffDamagedStock } from "../lib/inventory/adjustments";
import { recordStockMovement } from "../lib/inventory/ledger";
import { SEEDED_LOCATION_IDS } from "../lib/locations/constants";
import { createPurchase } from "../lib/inventory/purchases";
// P3.2 — the returns demo goes through the real services (lib/returns/*,
// packing, status moves). They're marked "server-only", which is why every
// seed entry point runs tsx with --conditions=react-server: under that
// condition the server-only guard is an empty module.
import { moveOrderStatus } from "../lib/orders/lifecycle";
import { packOrder } from "../lib/orders/pack";
import { getPosCashWalletId } from "../lib/pos/drawer";
import { completeConditionCheck } from "../lib/returns/condition-check";
import { createCounterExchange, decideReturnCase, requestReturnCase } from "../lib/returns/cases";
import { adjustStoreCredit } from "../lib/store-credit/ledger";
import { setPackaging } from "../lib/packaging/service";
import { createPosSale } from "../lib/pos/sale";
import { reserveVariantStock } from "../lib/orders/stock";
import { createStockCount, postStockCount, scanCountUnit } from "../lib/stock-counts/service";
import { createTransfer, receiveTransfer, resolveMissing, scanTransferUnit, sendTransfer } from "../lib/transfers/service";
import { computeOrderTotals } from "../lib/orders/totals";
import { generateOrderNumber } from "../lib/orders/order-number";
import { resolveSetLines, writeSetLines } from "../lib/sets/order-lines";
import { saveSet } from "../lib/sets/service";
import { DEFAULT_OFFICE_HOURS, OFFICE_HOURS_SETTING_KEY } from "../lib/attendance/office-hours";
import { attendanceStatus, dayKind } from "../lib/attendance/rules";
import { dhakaDayStart, dhakaMonth, dhakaToday, shiftMonth } from "../lib/targets/month";
import { statsByTeam, statsByUser } from "../lib/targets/performance";

// Mirrors lib/settings/get.ts's ORDER_EDIT_WINDOW_SETTING_KEY — duplicated
// for the same "server-only" reason as nextOrderNo below.
const ORDER_EDIT_WINDOW_SETTING_KEY = "order_edit_window_minutes";
const DEFAULT_ORDER_EDIT_WINDOW_MINUTES = 30;

// Mirrors lib/settings/get.ts's PACKING_SLA_HOURS_SETTING_KEY — same reason.
const PACKING_SLA_HOURS_SETTING_KEY = "packing_sla_hours";
const DEFAULT_PACKING_SLA_HOURS = 24;

// Mirrors lib/orders/order-number.ts's generateOrderNumber — duplicated for
// the same "server-only" reason. Demo orders MUST
// go through this (not a hardcoded "AB-2609-0001" string) so they advance
// the same order_sequences counter the real API route reads — otherwise the
// very first order placed through the app collides with a seeded one.
async function nextOrderNo(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], when: Date): Promise<string> {
  const yy = String(when.getFullYear()).slice(-2);
  const mm = String(when.getMonth() + 1).padStart(2, "0");
  const yearMonth = `${yy}${mm}`;
  const sequence = await tx.orderSequence.upsert({
    where: { yearMonth },
    create: { yearMonth, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  return `AB-${yearMonth}-${String(sequence.lastNumber).padStart(4, "0")}`;
}

const prisma = new PrismaClient();

const DEMO_PASSWORD = "ChangeMe123!";

const ROLE_LABELS: Record<RoleName, string> = {
  ADMIN: "Admin / Owner",
  MANAGER: "Manager",
  TEAM_LEADER: "Team Leader",
  SALES_EXECUTIVE: "Sales Executive",
  PACKING: "Packing / Operations",
  ACCOUNTS: "Accounts",
  POS_OPERATOR: "Showroom / POS Operator",
};

// PRD §4.2 short SKU codes (lib/catalog/codes.ts): the same codes the
// 20260925120000 migration gave an existing database.
const SIZES: Array<{ name: string; code: string }> = [
  { name: "Free", code: "F" },
  { name: "S", code: "S" },
  { name: "M", code: "M" },
  { name: "L", code: "L" },
  { name: "XL", code: "XL" },
  { name: "XXL", code: "XXL" },
];

const COLORS: Array<{ name: string; code: string; hexCode: string }> = [
  { name: "Black", code: "BLK", hexCode: "#000000" },
  { name: "White", code: "WHT", hexCode: "#FFFFFF" },
  { name: "Maroon", code: "MRN", hexCode: "#800000" },
  { name: "Navy Blue", code: "NBL", hexCode: "#000080" },
  { name: "Red", code: "RD", hexCode: "#D7263D" },
  { name: "Mustard Yellow", code: "MYL", hexCode: "#E1AD01" },
  { name: "Pink", code: "PNK", hexCode: "#F4A6C6" },
  { name: "Emerald Green", code: "EGR", hexCode: "#046A38" },
];

const CATEGORIES = ["Saree", "Salwar Kameez / Three-Piece", "Kurti", "Western Wear", "Abaya & Hijab", "Accessories"];

type SeedUser = {
  name: string;
  phone: string;
  email: string | null;
  role: RoleName;
};

const DEMO_USERS: SeedUser[] = [
  { name: "M.H. Neshad Al Kafian", phone: "01711000001", email: "orionbuildersbd@gmail.com", role: "ADMIN" },
  { name: "Demo Manager", phone: "01711000002", email: "manager@antuboutique.com", role: "MANAGER" },
  { name: "Demo Team Leader", phone: "01711000003", email: "teamleader@antuboutique.com", role: "TEAM_LEADER" },
  { name: "Demo Sales Executive", phone: "01711000004", email: "sales@antuboutique.com", role: "SALES_EXECUTIVE" },
  { name: "Demo Packing Staff", phone: "01711000005", email: "packing@antuboutique.com", role: "PACKING" },
  { name: "Demo Accounts Staff", phone: "01711000006", email: "accounts@antuboutique.com", role: "ACCOUNTS" },
  { name: "Demo POS Operator", phone: "01711000007", email: "pos@antuboutique.com", role: "POS_OPERATOR" },
  // P4.2 — two more executives so the leaderboard has a race to show.
  { name: "Rima Akter", phone: "01711000008", email: "rima@antuboutique.com", role: "SALES_EXECUTIVE" },
  { name: "Sumaiya Khan", phone: "01711000009", email: "sumaiya@antuboutique.com", role: "SALES_EXECUTIVE" },
];

// P5.2 — role permissions are edited in Settings → Roles & permissions, so
// re-running the seed must not undo those edits. A role gets its whole
// ROLE_TEMPLATES set only when the seed creates it; an existing role only
// gains the template's keys for permissions this run added (a new feature's
// permission reaches the roles it was designed for). SEED_RESET_ROLE_PERMISSIONS=1
// puts every role back to its template (dev only — it discards Settings edits).
const RESET_ROLE_PERMISSIONS = process.env.SEED_RESET_ROLE_PERMISSIONS === "1";

async function seedPermissionsAndRoles() {
  const knownKeys = new Set((await prisma.permission.findMany({ select: { key: true } })).map((p) => p.key));
  const knownRoles = new Set((await prisma.role.findMany({ select: { name: true } })).map((r) => r.name));
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      update: { group: permission.group, label: permission.label },
      create: permission,
    });
  }

  const roleIds: Record<RoleName, string> = {} as Record<RoleName, string>;

  for (const roleName of Object.keys(ROLE_LABELS) as RoleName[]) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: { label: ROLE_LABELS[roleName] },
      create: { name: roleName, label: ROLE_LABELS[roleName] },
    });
    roleIds[roleName] = role.id;
  }

  const permissionRows = await prisma.permission.findMany({ select: { id: true, key: true } });
  const permissionIdByKey = new Map(permissionRows.map((p) => [p.key, p.id]));

  for (const roleName of Object.keys(ROLE_TEMPLATES) as RoleName[]) {
    const roleId = roleIds[roleName];
    const fresh = RESET_ROLE_PERMISSIONS || !knownRoles.has(roleName);
    if (RESET_ROLE_PERMISSIONS) await prisma.rolePermission.deleteMany({ where: { roleId } });
    const keys = fresh ? ROLE_TEMPLATES[roleName] : ROLE_TEMPLATES[roleName].filter((key) => !knownKeys.has(key));
    await prisma.rolePermission.createMany({
      data: keys
        .map((key) => permissionIdByKey.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId, permissionId })),
      skipDuplicates: true,
    });
  }

  return roleIds;
}

async function seedCatalogMasters() {
  for (const [index, size] of SIZES.entries()) {
    await prisma.size.upsert({
      where: { name: size.name },
      update: { sortOrder: index },
      create: { name: size.name, code: size.code, sortOrder: index },
    });
  }

  for (const [index, color] of COLORS.entries()) {
    await prisma.color.upsert({
      where: { name: color.name },
      update: { hexCode: color.hexCode, sortOrder: index },
      create: { name: color.name, code: color.code, hexCode: color.hexCode, sortOrder: index },
    });
  }

  for (const [index, name] of CATEGORIES.entries()) {
    const existing = await prisma.category.findFirst({ where: { name, parentId: null } });
    if (existing) {
      await prisma.category.update({ where: { id: existing.id }, data: { sortOrder: index } });
    } else {
      await prisma.category.create({ data: { name, sortOrder: index } });
    }
  }
}

// Demo catalog data. `stock`/`cost` are the variant's OPENING balance: a
// newly created variant gets them as one OPENING_BALANCE ledger row (see
// seedCatalogProducts). Re-running the seed never touches stock or cost of
// an existing variant — those only move through the ledger.
type DemoVariant = { size: string; color: string; stock: number; cost: number; threshold?: number; priceOverride?: number };
type DemoProduct = {
  code: string;
  name: string;
  categoryName: string;
  brand: string;
  fabric: string;
  basePrice: number;
  tags: string[];
  variants: DemoVariant[];
};

const DEMO_PRODUCTS: DemoProduct[] = [
  {
    code: "S01",
    name: "Jamdani Saree — Classic",
    categoryName: "Saree",
    brand: "Antu Originals",
    fabric: "Jamdani Cotton",
    basePrice: 3500,
    tags: ["saree", "festive"],
    variants: [
      { size: "Free", color: "Maroon", stock: 12, cost: 2200 },
      { size: "Free", color: "Navy Blue", stock: 8, cost: 2200 },
      { size: "Free", color: "Black", stock: 3, cost: 2200, threshold: 5 },
    ],
  },
  {
    code: "K12",
    name: "Embroidered Kurti",
    categoryName: "Kurti",
    brand: "Antu Originals",
    fabric: "Cotton",
    basePrice: 1500,
    tags: ["kurti", "casual"],
    variants: [
      { size: "M", color: "Maroon", stock: 10, cost: 700 },
      { size: "L", color: "Maroon", stock: 6, cost: 700 },
      { size: "XL", color: "Maroon", stock: 2, cost: 700, threshold: 5 },
      { size: "M", color: "Mustard Yellow", stock: 9, cost: 700 },
      { size: "L", color: "Mustard Yellow", stock: 0, cost: 700 },
    ],
  },
  {
    code: "3P5",
    name: "Three-Piece Salwar Set",
    categoryName: "Salwar Kameez / Three-Piece",
    brand: "Antu Originals",
    fabric: "Georgette",
    basePrice: 2800,
    tags: ["three-piece"],
    variants: [
      { size: "M", color: "Pink", stock: 7, cost: 1600 },
      { size: "L", color: "Pink", stock: 4, cost: 1600 },
      { size: "M", color: "Emerald Green", stock: 11, cost: 1600, priceOverride: 2950 },
    ],
  },
  {
    code: "W02",
    name: "Western Top",
    categoryName: "Western Wear",
    brand: "Antu Originals",
    fabric: "Linen",
    basePrice: 1200,
    tags: ["western"],
    variants: [
      { size: "S", color: "White", stock: 5, cost: 550 },
      { size: "M", color: "White", stock: 1, cost: 550, threshold: 3 },
      { size: "M", color: "Black", stock: 0, cost: 550 },
    ],
  },
];

async function seedCatalogProducts() {
  const [sizes, colors, categories] = await Promise.all([
    prisma.size.findMany(),
    prisma.color.findMany(),
    prisma.category.findMany(),
  ]);
  const sizeByName = new Map(sizes.map((s) => [s.name, s]));
  const colorByName = new Map(colors.map((c) => [c.name, c]));
  const categoryByName = new Map(categories.map((c) => [c.name, c]));

  for (const demo of DEMO_PRODUCTS) {
    const category = categoryByName.get(demo.categoryName);

    const product = await prisma.product.upsert({
      where: { code: demo.code },
      update: {
        name: demo.name,
        categoryId: category?.id ?? null,
        brand: demo.brand,
        fabric: demo.fabric,
        basePrice: demo.basePrice,
        tags: demo.tags,
      },
      create: {
        code: demo.code,
        name: demo.name,
        categoryId: category?.id ?? null,
        brand: demo.brand,
        fabric: demo.fabric,
        basePrice: demo.basePrice,
        tags: demo.tags,
      },
    });

    for (const variant of demo.variants) {
      const size = sizeByName.get(variant.size);
      const color = colorByName.get(variant.color);
      if (!size || !color) continue;

      const existing = await prisma.productVariant.findUnique({
        where: { productId_sizeId_colorId: { productId: product.id, sizeId: size.id, colorId: color.id } },
      });
      if (existing) {
        await prisma.productVariant.update({
          where: { id: existing.id },
          data: { lowStockThreshold: variant.threshold ?? null, priceOverride: variant.priceOverride ?? null },
        });
        continue;
      }

      await prisma.$transaction(async (tx) => {
        const created = await tx.productVariant.create({
          data: {
            productId: product.id,
            sizeId: size.id,
            colorId: color.id,
            sku: buildVariantSku(demo.code, size.code, color.code),
            weightedAvgCost: variant.cost,
            lowStockThreshold: variant.threshold ?? null,
            priceOverride: variant.priceOverride ?? null,
          },
        });
        if (variant.stock !== 0) {
          // C3 — the warehouse (packing hub) holds the opening stock; the
          // Shyamoli showroom gets a few of each on top so the POS sells
          // from its own shelf, and the Parlour sales corner one of the
          // well-stocked ones.
          await recordStockMovement(tx, {
            variantId: created.id,
            locationId: SEEDED_LOCATION_IDS.mohammadpur,
            type: "ADJUSTMENT",
            qty: variant.stock,
            unitCost: variant.cost,
            referenceType: "OPENING_BALANCE",
            actorId: null,
            note: "Opening balance (seed)",
          });
          if (variant.stock > 0) {
            await recordStockMovement(tx, {
              variantId: created.id,
              locationId: SEEDED_LOCATION_IDS.shyamoli,
              type: "ADJUSTMENT",
              qty: Math.min(3, variant.stock),
              unitCost: variant.cost,
              referenceType: "OPENING_BALANCE",
              actorId: null,
              note: "Opening balance (seed) — showroom shelf",
            });
          }
          if (variant.stock >= 8) {
            await recordStockMovement(tx, {
              variantId: created.id,
              locationId: SEEDED_LOCATION_IDS.parlour,
              type: "ADJUSTMENT",
              qty: 1,
              unitCost: variant.cost,
              referenceType: "OPENING_BALANCE",
              actorId: null,
              note: "Opening balance (seed) — sales corner",
            });
          }
        }
      });
    }
  }
}

async function seedUsers(roleIds: Record<RoleName, string>) {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  let team = await prisma.team.findFirst({ where: { name: "Showroom Sales Team" } });
  if (!team) {
    team = await prisma.team.create({ data: { name: "Showroom Sales Team" } });
  }

  for (const demoUser of DEMO_USERS) {
    const teamId =
      demoUser.role === "TEAM_LEADER" || demoUser.role === "SALES_EXECUTIVE" ? team.id : null;

    await prisma.user.upsert({
      where: { phone: demoUser.phone },
      update: {
        name: demoUser.name,
        email: demoUser.email,
        roleId: roleIds[demoUser.role],
        teamId,
        isActive: true,
      },
      create: {
        name: demoUser.name,
        phone: demoUser.phone,
        email: demoUser.email,
        passwordHash,
        roleId: roleIds[demoUser.role],
        teamId,
        mustChangePassword: false,
      },
    });
  }

  const teamLeader = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000003" } });
  if (team.leaderId !== teamLeader.id) {
    await prisma.team.update({ where: { id: team.id }, data: { leaderId: teamLeader.id } });
  }

  // C3 (CORRECTIONS.md item 2) — location incharges: the packer runs the
  // Mohammadpur hub, the POS operator the Shyamoli showroom. Admin and
  // Manager act for every location through location.all.
  const byPhone = async (phone: string) => (await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true } })).id;
  await prisma.userLocation.createMany({
    data: [
      { userId: await byPhone("01711000005"), locationId: SEEDED_LOCATION_IDS.mohammadpur },
      { userId: await byPhone("01711000007"), locationId: SEEDED_LOCATION_IDS.shyamoli },
    ],
    skipDuplicates: true,
  });
}

// PRD §4.4 demo customers — one person per customer, no payer/recipient
// split. Deliberately created by different roles (SE, TL, Manager) so the
// SALES_EXECUTIVE-scoping story is visible immediately: logging in as the
// demo SE on /customers must show only the two rows credited to them below.
type DemoCustomer = {
  name: string;
  phone: string;
  altPhone?: string;
  division?: string;
  district?: string;
  thana?: string;
  addressDetail?: string;
  notes?: string;
  tags?: Array<"VIP" | "WHOLESALE" | "PROBLEM_CUSTOMER">;
  createdByPhone: string;
};

const DEMO_CUSTOMERS: DemoCustomer[] = [
  {
    name: "Farzana Akter",
    phone: "01911223344",
    division: "Dhaka",
    district: "Dhaka",
    thana: "Mirpur",
    addressDetail: "House 12, Road 5, Mirpur 10",
    tags: ["VIP"],
    notes: "Prefers bKash. Regular repeat buyer of sarees.",
    createdByPhone: "01711000004",
  },
  {
    name: "Rezaul Karim",
    phone: "01812345678",
    altPhone: "01912345678",
    division: "Dhaka",
    district: "Dhaka",
    thana: "Dhanmondi",
    addressDetail: "Road 27, Dhanmondi",
    tags: ["WHOLESALE"],
    notes: "Buys in bulk for a small boutique resale.",
    createdByPhone: "01711000004",
  },
  {
    name: "Shirin Sultana",
    phone: "01611556677",
    division: "Chattogram",
    district: "Chattogram",
    thana: "Panchlaish",
    tags: ["PROBLEM_CUSTOMER"],
    notes: "Has refused COD delivery before — confirm before dispatch.",
    createdByPhone: "01711000003",
  },
  {
    name: "Tanvir Ahmed",
    phone: "01511998877",
    division: "Sylhet",
    district: "Sylhet",
    thana: "Zindabazar",
    createdByPhone: "01711000003",
  },
  {
    name: "Nusrat Jahan",
    phone: "01711998800",
    division: "Rajshahi",
    district: "Rajshahi",
    thana: "Boalia",
    tags: ["VIP"],
    createdByPhone: "01711000002",
  },
];

async function seedCustomers() {
  const users = await prisma.user.findMany({ select: { id: true, phone: true, teamId: true } });
  const userByPhone = new Map(users.map((u) => [u.phone, u]));

  for (const demo of DEMO_CUSTOMERS) {
    const creator = userByPhone.get(demo.createdByPhone);

    await prisma.customer.upsert({
      where: { phone: demo.phone },
      update: {
        name: demo.name,
        altPhone: demo.altPhone ?? null,
        division: demo.division ?? null,
        district: demo.district ?? null,
        thana: demo.thana ?? null,
        addressDetail: demo.addressDetail ?? null,
        notes: demo.notes ?? null,
        tags: demo.tags ?? [],
      },
      create: {
        name: demo.name,
        phone: demo.phone,
        altPhone: demo.altPhone ?? null,
        division: demo.division ?? null,
        district: demo.district ?? null,
        thana: demo.thana ?? null,
        addressDetail: demo.addressDetail ?? null,
        notes: demo.notes ?? null,
        tags: demo.tags ?? [],
        createdById: creator?.id ?? null,
        teamId: creator?.teamId ?? null,
      },
    });
  }
}

// PRD §4.9 — minimal courier + per-zone charge, just enough for the order
// form's courier/zone/delivery-charge pickers. The full courier module
// (Steadfast credentials, shipments, COD reconciliation) is P2.2.
type DemoCourier = {
  name: string;
  contact: string;
  provider?: "STEADFAST";
  zones: Array<{ zone: "INSIDE_CITY" | "SUB_CITY" | "OUTSIDE_CITY"; charge: number; codChargePercent: number; returnCharge: number }>;
};

const DEMO_COURIERS: DemoCourier[] = [
  {
    name: "Steadfast Courier",
    contact: "16374",
    provider: "STEADFAST",
    zones: [
      { zone: "INSIDE_CITY", charge: 60, codChargePercent: 1, returnCharge: 60 },
      { zone: "SUB_CITY", charge: 100, codChargePercent: 1, returnCharge: 80 },
      { zone: "OUTSIDE_CITY", charge: 130, codChargePercent: 1, returnCharge: 100 },
    ],
  },
  {
    name: "Pathao Courier",
    contact: "16710",
    zones: [
      { zone: "INSIDE_CITY", charge: 65, codChargePercent: 1.5, returnCharge: 65 },
      { zone: "SUB_CITY", charge: 110, codChargePercent: 1.5, returnCharge: 90 },
      { zone: "OUTSIDE_CITY", charge: 140, codChargePercent: 1.5, returnCharge: 110 },
    ],
  },
];

// Zone charges are edited in Settings → Couriers & zones (P5.2): the seed
// only fills in a zone that doesn't exist yet, never overwrites one.
async function seedCouriers(couriers: DemoCourier[] = DEMO_COURIERS) {
  for (const courier of couriers) {
    const row = await prisma.courierCompany.upsert({
      where: { name: courier.name },
      update: { provider: courier.provider ?? null },
      create: { name: courier.name, contact: courier.contact, provider: courier.provider ?? null },
    });
    for (const zone of courier.zones) {
      await prisma.courierZone.upsert({
        where: { courierId_zone: { courierId: row.id, zone: zone.zone } },
        update: {},
        create: {
          courierId: row.id,
          zone: zone.zone,
          charge: zone.charge,
          codChargePercent: zone.codChargePercent,
          returnCharge: zone.returnCharge,
        },
      });
    }
  }
}

// PRD §4.6 demo orders — enough real content for the order list/detail
// screens to be judged, and to show the CONFIRMED-reserves-stock rule
// (CLAUDE.md rule 10) actually holding on seeded data. Guarded on "any
// order already exists" (not a specific orderNo — these are now generated
// through nextOrderNo(), same as the real API route, not hardcoded) so
// re-running `db:seed` never reserves the same stock twice — unlike the
// upsert-based seeders above, an Order write also has a side effect
// (reservedQty), which isn't safely re-appliable.
async function seedDemoOrders() {
  const alreadySeeded = (await prisma.order.count()) > 0;
  if (alreadySeeded) return;

  const se = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000004" } });
  const teamLeader = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000003" } });
  const farzana = await prisma.customer.findUniqueOrThrow({ where: { phone: "01911223344" } });
  const shirin = await prisma.customer.findUniqueOrThrow({ where: { phone: "01611556677" } });
  const kurtiVariant = await prisma.productVariant.findFirstOrThrow({
    where: { product: { code: "K12" }, size: { name: "M" }, color: { name: "Maroon" } },
  });
  const sareeVariant = await prisma.productVariant.findFirstOrThrow({
    where: { product: { code: "S01" }, size: { name: "Free" }, color: { name: "Navy Blue" } },
  });
  const steadfast = await prisma.courierCompany.findUniqueOrThrow({ where: { name: "Steadfast Courier" } });
  const insideZone = await prisma.courierZone.findFirstOrThrow({ where: { courierId: steadfast.id, zone: "INSIDE_CITY" } });

  await prisma.$transaction(async (tx) => {
    // Order 1 — confirmed, advance already collected, courier chosen.
    const qty1 = 2;
    const unitPrice1 = 1500;
    const deliveryCharge1 = Number(insideZone.charge);
    const total1 = qty1 * unitPrice1 + deliveryCharge1;
    const advance1 = 500;

    const now = new Date();
    const order1 = await tx.order.create({
      data: {
        orderNo: await nextOrderNo(tx, now),
        channel: "ONLINE",
        status: "CONFIRMED",
        customerId: farzana.id,
        courierId: steadfast.id,
        courierZoneId: insideZone.id,
        deliveryCharge: deliveryCharge1,
        expectedDeliveryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        subtotal: qty1 * unitPrice1,
        discountTotal: 0,
        total: total1,
        dueAmount: total1 - advance1,
        internalNote: "Customer wants the darker maroon shade — confirmed against her Messenger screenshot.",
        createdById: se.id,
        teamId: se.teamId,
      },
    });
    await tx.orderItem.create({ data: { orderId: order1.id, variantId: kurtiVariant.id, qty: qty1, unitPrice: unitPrice1, lineDiscount: 0 } });
    await tx.productVariant.update({ where: { id: kurtiVariant.id }, data: { reservedQty: { increment: qty1 } } });
    await tx.orderStatusHistory.create({
      data: { orderId: order1.id, fromStatus: null, toStatus: "CONFIRMED", changedById: se.id, note: "Order created" },
    });
    await tx.payment.create({
      data: {
        orderId: order1.id,
        amount: advance1,
        method: "BKASH",
        walletId: "wallet_bkash_personal",
        transactionId: "SEED-TXN-0001",
        receivedById: se.id,
        verified: true,
      },
    });

    // Order 2 — full COD, no advance, no courier picked yet, placed by the
    // Team Leader for a flagged customer.
    const qty2 = 1;
    const unitPrice2 = 3500;
    const total2 = qty2 * unitPrice2;

    const order2 = await tx.order.create({
      data: {
        orderNo: await nextOrderNo(tx, now),
        channel: "ONLINE",
        status: "CONFIRMED",
        customerId: shirin.id,
        deliveryCharge: 0,
        subtotal: qty2 * unitPrice2,
        discountTotal: 0,
        total: total2,
        dueAmount: total2,
        internalNote: "Has refused COD before — call to reconfirm before booking courier.",
        createdById: teamLeader.id,
        teamId: teamLeader.teamId,
      },
    });
    await tx.orderItem.create({ data: { orderId: order2.id, variantId: sareeVariant.id, qty: qty2, unitPrice: unitPrice2, lineDiscount: 0 } });
    await tx.productVariant.update({ where: { id: sareeVariant.id }, data: { reservedQty: { increment: qty2 } } });
    await tx.orderStatusHistory.create({
      data: { orderId: order2.id, fromStatus: null, toStatus: "CONFIRMED", changedById: teamLeader.id, note: "Order created" },
    });
  });
}

// PRD §4.3 demo inventory — suppliers, two purchases (one with transport
// cost to allocate, one part-paid so the supplier-due column has content),
// a stock-count adjustment and a damage write-off, so the stock report,
// ledger and purchase screens can be judged with real-looking data. Guarded
// on "any purchase exists": every one of these moves stock and appends to
// the immutable ledger, so none of it is safely re-appliable.
async function seedInventory() {
  if ((await prisma.purchase.count()) > 0) return;

  const admin = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000001" } });
  const manager = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000002" } });
  const variantFor = (code: string, size: string, color: string) =>
    prisma.productVariant.findFirstOrThrow({ where: { product: { code }, size: { name: size }, color: { name: color } } });

  const rupkotha = await prisma.supplier.upsert({
    where: { name: "Rupkotha Fabrics (Islampur)" },
    update: {},
    create: { name: "Rupkotha Fabrics (Islampur)", phone: "01819445566", address: "Islampur, Old Dhaka", notes: "Jamdani and cotton sarees. Pays transport by pickup van." },
  });
  const nakshi = await prisma.supplier.upsert({
    where: { name: "Nakshi Stitch House" },
    update: {},
    create: { name: "Nakshi Stitch House", phone: "01912778899", address: "Mirpur 10, Dhaka", notes: "Kurti and three-piece job work." },
  });

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  const [sareeMaroon, sareeBlack, kurtiMM, kurtiLM, kurtiLMustard, threePcPink] = await Promise.all([
    variantFor("S01", "Free", "Maroon"),
    variantFor("S01", "Free", "Black"),
    variantFor("K12", "M", "Maroon"),
    variantFor("K12", "L", "Maroon"),
    variantFor("K12", "L", "Mustard Yellow"),
    variantFor("3P5", "L", "Pink"),
  ]);

  await prisma.$transaction(
    async (tx) => {
      await createPurchase(
        tx,
        {
          supplierId: rupkotha.id,
          purchaseDate: daysAgo(12),
          invoiceNo: "RF-7781",
          allocationMethod: "BY_VALUE",
          transportCost: 600,
          otherCost: 0,
          amountPaid: 14_200,
          note: "Eid restock — paid in full by bKash merchant.",
          items: [
            { variantId: sareeMaroon.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 4, unitCost: 2300 },
            { variantId: sareeBlack.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 2, unitCost: 2300 },
          ],
        },
        manager.id,
      );

      await createPurchase(
        tx,
        {
          supplierId: nakshi.id,
          purchaseDate: daysAgo(4),
          invoiceNo: "NSH-0412",
          allocationMethod: "BY_QTY",
          transportCost: 250,
          otherCost: 150,
          amountPaid: 5_000,
          note: "Balance due after quality check.",
          items: [
            // C3 — one purchase received into two locations.
            { variantId: kurtiMM.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 4, unitCost: 720 },
            { variantId: kurtiMM.id, locationId: SEEDED_LOCATION_IDS.shyamoli, qty: 2, unitCost: 720 },
            { variantId: kurtiLM.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 4, unitCost: 720 },
            { variantId: kurtiLMustard.id, locationId: SEEDED_LOCATION_IDS.shyamoli, qty: 5, unitCost: 760 },
            { variantId: threePcPink.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 3, unitCost: 1650 },
          ],
        },
        manager.id,
      );

      await adjustStock(tx, { variantId: kurtiMM.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: -1, reason: "Monthly stock count — one short against the ledger" }, admin.id);
      await writeOffDamagedStock(tx, { variantId: sareeMaroon.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, qty: 1, reason: "Dye bleed along the border, not sellable" }, manager.id);
    },
    { timeout: 60_000 },
  );
}

// ---------------------------------------------------------------------------
// P2.2 — courier cost rates, variant weights, and demo shipments
// ---------------------------------------------------------------------------

// What Steadfast charges US (base covers the first kg, per-kg each extra
// started kg) — separate from the customer's delivery charge above.
const STEADFAST_COST_RATES = [
  { zone: "INSIDE_CITY", baseRate: 60, perKgRate: 20 },
  { zone: "SUB_CITY", baseRate: 100, perKgRate: 25 },
  { zone: "OUTSIDE_CITY", baseRate: 120, perKgRate: 25 },
] as const;

// Parcel weight per unit in grams. W02 is deliberately left blank so the
// send dialog's "some items have no weight" warning has something to show.
const VARIANT_WEIGHTS_GRAMS: Record<string, number> = { S01: 650, K12: 250, "3P5": 480 };

async function seedCourierCosts() {
  const steadfast = await prisma.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" } });
  for (const rate of STEADFAST_COST_RATES) {
    await prisma.courierCostRate.upsert({
      where: { courierId_zone: { courierId: steadfast.id, zone: rate.zone } },
      update: {},
      create: { courierId: steadfast.id, ...rate },
    });
  }
  for (const [code, grams] of Object.entries(VARIANT_WEIGHTS_GRAMS)) {
    await prisma.productVariant.updateMany({ where: { product: { code }, weightGrams: null }, data: { weightGrams: grams } });
  }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type CourierDemoStage = "PACKED" | "HANDED_TO_COURIER" | "IN_TRANSIT" | "APPROVAL_PENDING" | "DELIVERED" | "RETURNED" | "PARTIAL_DELIVERED";

type CourierDemoSpec = {
  stage: CourierDemoStage;
  customerPhone: string;
  lines: { code: string; size: string; color: string; qty: number; unitPrice: number }[];
  zone: "INSIDE_CITY" | "SUB_CITY" | "OUTSIDE_CITY";
  advance?: number;
  deliveryNote?: string;
  internalNote?: string;
  hoursAgo: number;
};

// One demo order per courier stage so every Courier-page tab has content.
// Written the way the app writes them — reserve at CONFIRMED, SALE_OUT +
// cost snapshot at PACKED through the real ledger function, status history
// at each step — because lib/orders/pack.ts and lib/courier/* are
// "server-only" and can't run under tsx. Consignment ids / tracking codes
// are obviously fake (DEMO…) — never a real Steadfast parcel.
const COURIER_DEMO_ORDERS: CourierDemoSpec[] = [
  {
    stage: "PACKED",
    customerPhone: "01812345678",
    lines: [{ code: "K12", size: "M", color: "Mustard Yellow", qty: 1, unitPrice: 1450 }],
    zone: "INSIDE_CITY",
    deliveryNote: "Call before coming — office hours only, 10am–6pm.",
    internalNote: "Customer is a repeat buyer; gave 50 tk discount last time.",
    hoursAgo: 5,
  },
  {
    stage: "PACKED",
    customerPhone: "01511998877",
    lines: [
      { code: "3P5", size: "M", color: "Emerald Green", qty: 1, unitPrice: 2950 },
      { code: "W02", size: "S", color: "White", qty: 1, unitPrice: 990 },
    ],
    zone: "OUTSIDE_CITY",
    advance: 500,
    hoursAgo: 3,
  },
  {
    stage: "HANDED_TO_COURIER",
    customerPhone: "01711998800",
    lines: [{ code: "S01", size: "Free", color: "Navy Blue", qty: 1, unitPrice: 4200 }],
    zone: "OUTSIDE_CITY",
    advance: 1000,
    hoursAgo: 20,
  },
  {
    stage: "IN_TRANSIT",
    customerPhone: "01911223344",
    lines: [{ code: "K12", size: "L", color: "Maroon", qty: 1, unitPrice: 1450 }],
    zone: "INSIDE_CITY",
    deliveryNote: "Leave with the guard if not home.",
    hoursAgo: 30,
  },
  {
    stage: "APPROVAL_PENDING",
    customerPhone: "01611556677",
    lines: [{ code: "3P5", size: "L", color: "Pink", qty: 1, unitPrice: 2750 }],
    zone: "OUTSIDE_CITY",
    hoursAgo: 52,
  },
  {
    stage: "DELIVERED",
    customerPhone: "01812345678",
    lines: [{ code: "S01", size: "Free", color: "Navy Blue", qty: 1, unitPrice: 4200 }],
    zone: "INSIDE_CITY",
    advance: 1200,
    hoursAgo: 75,
  },
  {
    stage: "RETURNED",
    customerPhone: "01511998877",
    lines: [{ code: "K12", size: "M", color: "Mustard Yellow", qty: 2, unitPrice: 1450 }],
    zone: "OUTSIDE_CITY",
    hoursAgo: 96,
  },
  {
    stage: "PARTIAL_DELIVERED",
    customerPhone: "01911223344",
    lines: [
      { code: "K12", size: "L", color: "Maroon", qty: 1, unitPrice: 1450 },
      { code: "3P5", size: "M", color: "Emerald Green", qty: 1, unitPrice: 2950 },
    ],
    zone: "INSIDE_CITY",
    hoursAgo: 60,
  },
];

const STEADFAST_STAGE_STATUS: Record<Exclude<CourierDemoStage, "PACKED">, string> = {
  HANDED_TO_COURIER: "in_review",
  IN_TRANSIT: "pending",
  APPROVAL_PENDING: "delivered_approval_pending",
  DELIVERED: "delivered",
  RETURNED: "cancelled",
  PARTIAL_DELIVERED: "partial_delivered",
};

async function seedCourierDemo() {
  if ((await prisma.shipment.count()) > 0) return;

  const se = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000004" } });
  const packer = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000005" } });
  const steadfast = await prisma.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" }, include: { zones: true } });
  const rates = await prisma.courierCostRate.findMany({ where: { courierId: steadfast.id } });

  let n = 0;
  for (const spec of COURIER_DEMO_ORDERS) {
    n += 1;
    await prisma.$transaction(
      async (tx: Tx) => {
        const at = (hoursAfterCreate: number) => new Date(Date.now() - (spec.hoursAgo - hoursAfterCreate) * 60 * 60 * 1000);
        const customer = await tx.customer.findUniqueOrThrow({ where: { phone: spec.customerPhone } });
        const zoneRow = steadfast.zones.find((z) => z.zone === spec.zone)!;
        const variants = await Promise.all(
          spec.lines.map((l) =>
            tx.productVariant.findFirstOrThrow({ where: { product: { code: l.code }, size: { name: l.size }, color: { name: l.color } } }),
          ),
        );
        const subtotal = spec.lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
        const deliveryCharge = Number(zoneRow.charge);
        const total = subtotal + deliveryCharge;
        const advance = spec.advance ?? 0;

        const order = await tx.order.create({
          data: {
            orderNo: await nextOrderNo(tx, at(0)),
            channel: "ONLINE",
            status: "CONFIRMED",
            customerId: customer.id,
            courierId: steadfast.id,
            courierZoneId: zoneRow.id,
            deliveryCharge,
            subtotal,
            discountTotal: 0,
            total,
            dueAmount: total - advance,
            deliveryNote: spec.deliveryNote ?? null,
            internalNote: spec.internalNote ?? null,
            createdById: se.id,
            teamId: se.teamId,
            createdAt: at(0),
          },
        });
        const items = [];
        for (const [i, line] of spec.lines.entries()) {
          items.push(await tx.orderItem.create({ data: { orderId: order.id, variantId: variants[i].id, qty: line.qty, unitPrice: line.unitPrice } }));
          await tx.productVariant.update({ where: { id: variants[i].id }, data: { reservedQty: { increment: line.qty } } });
        }
        await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: null, toStatus: "CONFIRMED", changedById: se.id, note: "Order created", createdAt: at(0) } });
        if (advance > 0) {
          await tx.payment.create({
            data: { orderId: order.id, amount: advance, method: "BKASH", walletId: "wallet_bkash_personal", transactionId: `SEED-SF-${n}`, receivedById: se.id, verified: true, paidAt: at(0) },
          });
        }

        // PACKED — cost snapshot + SALE_OUT through the real ledger function.
        for (const [i, item] of items.entries()) {
          await tx.orderItem.update({ where: { id: item.id }, data: { unitCostSnapshot: variants[i].weightedAvgCost } });
          await recordStockMovement(tx, {
            variantId: variants[i].id,
            locationId: SEEDED_LOCATION_IDS.mohammadpur,
            type: "SALE_OUT",
            qty: -item.qty,
            unitCost: variants[i].weightedAvgCost,
            referenceType: "ORDER",
            referenceId: order.id,
            actorId: packer.id,
            releaseReserved: item.qty,
          });
        }
        await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: "CONFIRMED", toStatus: "PACKED", changedById: packer.id, note: "Packing checklist complete", createdAt: at(1) } });
        await tx.order.update({ where: { id: order.id }, data: { status: "PACKED" } });
        if (spec.stage === "PACKED") return;

        // HANDED_TO_COURIER — booked with Steadfast.
        const weightGrams = spec.lines.reduce((sum, l, i) => sum + (variants[i].weightGrams ?? 0) * l.qty, 0) || null;
        const rate = rates.find((r) => r.zone === spec.zone)!;
        const kg = Math.max(1, Math.ceil((weightGrams ?? 0) / 1000));
        const estimate = Number(rate.baseRate) + Number(rate.perKgRate) * (kg - 1);
        const trackingCode = `DEMOSF${String(n).padStart(4, "0")}`;
        const cod = Math.max(0, total - advance);
        const steadfastStatus = STEADFAST_STAGE_STATUS[spec.stage];
        const final = ["DELIVERED", "RETURNED", "PARTIAL_DELIVERED"].includes(spec.stage);
        const orderStatus =
          spec.stage === "APPROVAL_PENDING" ? "IN_TRANSIT" : (spec.stage as "HANDED_TO_COURIER" | "IN_TRANSIT" | "DELIVERED" | "RETURNED" | "PARTIAL_DELIVERED");

        const shipment = await tx.shipment.create({
          data: {
            orderId: order.id,
            courierId: steadfast.id,
            consignmentId: `DEMO-${100000 + n}`,
            trackingCode,
            trackingUrl: `https://steadfast.com.bd/tl/${trackingCode}`,
            steadfastStatus,
            subStatus:
              spec.stage === "IN_TRANSIT" ? "PENDING" : spec.stage === "APPROVAL_PENDING" ? "DELIVERY_APPROVAL_PENDING" : null,
            zone: spec.zone,
            weightGrams,
            codAmount: cod,
            courierCostEstimate: estimate,
            courierCostActual: final ? estimate + 10 : null,
            codCollected: spec.stage === "DELIVERED" ? cod : spec.stage === "PARTIAL_DELIVERED" ? spec.lines[0].unitPrice + deliveryCharge : null,
            accountsReviewRequired: spec.stage === "PARTIAL_DELIVERED",
            bookedAt: at(2),
            bookedById: packer.id,
            inTransitAt: spec.stage === "HANDED_TO_COURIER" ? null : at(8),
            deliveredAt: spec.stage === "DELIVERED" || spec.stage === "PARTIAL_DELIVERED" ? at(30) : null,
            returnedAt: spec.stage === "RETURNED" ? at(40) : null,
            finalizedAt: final ? at(spec.stage === "RETURNED" ? 40 : 30) : null,
            lastStatusAt: at(final ? 30 : 8),
            createdAt: at(2),
          },
        });
        await tx.shipmentStatusLog.create({
          data: { shipmentId: shipment.id, source: "API", rawStatus: "in_review", rawPayload: { status: 200, consignment: { consignment_id: 100000 + n, invoice: order.orderNo, tracking_code: trackingCode, status: "in_review" }, demo: true }, receivedAt: at(2) },
        });
        await tx.order.update({ where: { id: order.id }, data: { status: orderStatus } });
        const history: { from: string; to: string; by: string | null; note: string; h: number }[] = [
          { from: "PACKED", to: "HANDED_TO_COURIER", by: packer.id, note: `Sent via Steadfast API, tracking ${trackingCode}`, h: 2 },
        ];
        if (spec.stage !== "HANDED_TO_COURIER") {
          history.push({ from: "HANDED_TO_COURIER", to: "IN_TRANSIT", by: null, note: "Steadfast webhook: pending", h: 8 });
          await tx.shipmentTrackingEvent.createMany({
            data: [
              { shipmentId: shipment.id, message: "Parcel received at Steadfast hub (Tejgaon).", eventAt: at(8), source: "WEBHOOK" },
              { shipmentId: shipment.id, message: "Parcel dispatched to the delivery hub.", eventAt: at(14), source: "WEBHOOK" },
            ],
          });
          await tx.shipmentStatusLog.create({
            data: { shipmentId: shipment.id, source: "WEBHOOK", rawStatus: "pending", rawPayload: { notification_type: "delivery_status", consignment_id: 100000 + n, invoice: order.orderNo, status: "pending", demo: true }, receivedAt: at(8) },
          });
        }
        if (final) {
          const to = orderStatus;
          history.push({ from: "IN_TRANSIT", to, by: null, note: `Steadfast webhook: ${steadfastStatus}`, h: spec.stage === "RETURNED" ? 40 : 30 });
          await tx.shipmentStatusLog.create({
            data: {
              shipmentId: shipment.id,
              source: "WEBHOOK",
              rawStatus: steadfastStatus,
              rawPayload: { notification_type: "delivery_status", consignment_id: 100000 + n, invoice: order.orderNo, status: steadfastStatus, delivery_charge: estimate + 10, status_api_cross_check: steadfastStatus, demo: true },
              receivedAt: at(30),
            },
          });
        }
        for (const hEntry of history) {
          await tx.orderStatusHistory.create({
            data: { orderId: order.id, fromStatus: hEntry.from as never, toStatus: hEntry.to as never, changedById: hEntry.by, note: hEntry.note, createdAt: at(hEntry.h) },
          });
        }

        // Goods coming back wait for Packing's condition check.
        if (spec.stage === "RETURNED") {
          await tx.returnInspection.create({
            data: {
              orderId: order.id,
              shipmentId: shipment.id,
              source: "COURIER_RETURN",
              status: "PENDING",
              createdAt: at(40),
              lines: { create: items.map((item) => ({ orderItemId: item.id, qty: item.qty })) },
            },
          });
        }
        if (spec.stage === "PARTIAL_DELIVERED") {
          await tx.returnInspection.create({
            data: { orderId: order.id, shipmentId: shipment.id, source: "PARTIAL_DELIVERY", status: "AWAITING_KEPT_ITEMS", createdAt: at(30) },
          });
        }
      },
      { timeout: 60_000 },
    );
  }
}

// P2.2b — courier statements. Only states that move no money are seeded (a
// processing payout; a paid one whose single parcel isn't ours), because
// settling is lib/courier/reconcile.ts's job and that module is server-only.
async function seedCourierStatementsDemo() {
  if ((await prisma.courierStatement.count()) > 0) return;
  const steadfast = await prisma.courierCompany.findUniqueOrThrow({ where: { provider: "STEADFAST" } });
  const delivered = await prisma.shipment.findFirst({ where: { courierId: steadfast.id, order: { status: "DELIVERED" } }, include: { order: true } });
  if (!delivered) return;
  const cod = Number(delivered.codCollected ?? delivered.codAmount);
  const charge = Number(delivered.courierCostActual ?? 60);
  const fee = Math.round((cod - charge) * 0.01);
  const today = new Date();

  await prisma.courierStatement.create({
    data: {
      courierId: steadfast.id,
      source: "STEADFAST_API",
      reference: "SFC-DEMO-0001",
      status: "PROCESSING",
      statementDate: today,
      grossAmount: cod,
      deliveryCharge: charge,
      codCharge: fee,
      netAmount: cod - charge - fee,
      walletId: "wallet_bank",
      rawPayload: { payment_id: "SFC-DEMO-0001", status_label: "processing", demo: true },
      lines: { create: [{ lineNo: 1, consignmentId: delivered.consignmentId, invoice: delivered.order.orderNo, codAmount: cod }] },
    },
  });
  await prisma.courierStatement.create({
    data: {
      courierId: steadfast.id,
      source: "STEADFAST_API",
      reference: "SFC-DEMO-0002",
      status: "PAID",
      statementDate: new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000),
      grossAmount: 1850,
      deliveryCharge: 110,
      codCharge: 17,
      netAmount: 1723,
      walletId: "wallet_bank",
      rawPayload: { payment_id: "SFC-DEMO-0002", status_label: "paid", demo: true },
      lines: {
        create: [
          {
            lineNo: 1,
            consignmentId: "DEMO-FOREIGN-1",
            invoice: "PANEL-7781",
            codAmount: 1850,
            status: "UNMATCHED",
            mismatchReason: "No shipment of ours has this consignment id or order no.",
          },
        ],
      },
    },
  });
}

// P2.3 — the wallets PRD §4.10 names. Same fixed ids as the migration
// (20260923200000_wallets_refunds_expenses), so re-seeding never duplicates.
const SEED_WALLETS = [
  { id: "wallet_bkash_personal", name: "bKash Personal", type: "BKASH", sortOrder: 1, opening: 25_000 },
  { id: "wallet_bkash_merchant", name: "bKash Merchant", type: "BKASH", sortOrder: 2, opening: 40_000 },
  { id: "wallet_nagad", name: "Nagad", type: "NAGAD", sortOrder: 3, opening: 8_000 },
  { id: "wallet_rocket", name: "Rocket", type: "ROCKET", sortOrder: 4, opening: 0 },
  { id: "wallet_bank", name: "Bank Account", type: "BANK", sortOrder: 5, opening: 1_50_000 },
  { id: "wallet_showroom_cash", name: "Showroom Cash", type: "CASH", sortOrder: 6, opening: 12_000 },
] as const;

async function seedWallets() {
  for (const w of SEED_WALLETS) {
    await prisma.wallet.upsert({
      where: { id: w.id },
      update: {},
      create: { id: w.id, name: w.name, type: w.type, sortOrder: w.sortOrder, openingBalance: 0, openingDate: new Date("2025-12-31T18:00:00Z") },
    });
  }
}

/**
 * P2.3 demo money: opening balances, a verification queue, a refund waiting
 * for approval, a month of expenses, a week of Facebook ad spend (each
 * posting its "Ad cost" expense, as lib/expenses/service.ts does), a cash
 * top-up and a bKash→bank transfer. Skipped once any wallet entry exists.
 */
async function seedFinanceDemo() {
  if ((await prisma.walletEntry.count()) > 0) return;
  const admin = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000001" } });
  const accounts = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000006" } });
  const se = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000004" } });
  const dayMs = 24 * 60 * 60 * 1000;
  // Dhaka midnight `n` days ago, as UTC.
  const dhakaDay = (n: number) => {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date(Date.now() - n * dayMs));
    return new Date(`${ymd}T00:00:00+06:00`);
  };

  // Opening balances counted on the 1st of last month.
  const openingDate = dhakaDay(new Date().getDate() + 30);
  for (const w of SEED_WALLETS) {
    await prisma.wallet.update({ where: { id: w.id }, data: { openingBalance: w.opening, openingDate } });
  }

  // Verification queue: part-payments on open orders, not yet verified.
  const openOrders = await prisma.order.findMany({
    where: { deletedAt: null, status: { in: ["CONFIRMED", "PACKED"] }, dueAmount: { gt: 300 } },
    orderBy: { createdAt: "asc" },
    take: 3,
  });
  const queue = [
    { method: "NAGAD", walletId: "wallet_nagad", trx: "SEED-NGD-7781", note: "Customer sent a Nagad screenshot on Messenger" },
    { method: "BKASH", walletId: "wallet_bkash_merchant", trx: "SEED-BKM-5520", note: null },
    { method: "BKASH", walletId: "wallet_bkash_personal", trx: "SEED-BKP-9914", note: "Paid from her husband's number" },
  ] as const;
  for (const [i, order] of openOrders.entries()) {
    const q = queue[i];
    await prisma.payment.create({
      data: { orderId: order.id, amount: 300, method: q.method, walletId: q.walletId, transactionId: q.trx, receivedById: se.id, verified: false, paidAt: new Date(Date.now() - (i + 1) * 3 * 60 * 60 * 1000), note: q.note },
    });
    await recomputeDue(order.id);
  }

  // A refund Accounts asked for, waiting for a Manager/Admin.
  const paidOrder = await prisma.order.findFirst({ where: { deletedAt: null, payments: { some: { kind: "PAYMENT", verified: true, method: "BKASH", amount: { gte: 400 } } } }, orderBy: { createdAt: "asc" } });
  if (paidOrder) {
    await prisma.payment.create({
      data: {
        orderId: paidOrder.id,
        kind: "REFUND",
        amount: -200,
        method: "BKASH",
        walletId: "wallet_bkash_personal",
        receivedById: accounts.id,
        refundReason: "Customer sent the advance twice (৳200 extra) — returning the difference.",
        refundStatus: "PENDING",
        paidAt: new Date(),
      },
    });
  }

  // A month of running costs.
  const expenses = [
    { cat: "expcat_rent", nature: "FIXED", amount: 35_000, wallet: "wallet_bank", day: 20, note: "Showroom rent — this month" },
    { cat: "expcat_salary", nature: "FIXED", amount: 18_000, wallet: "wallet_bank", day: 18, note: "Packing staff salary" },
    { cat: "expcat_salary", nature: "FIXED", amount: 22_000, wallet: "wallet_bank", day: 18, note: "Sales team salary" },
    { cat: "expcat_utility", nature: "FIXED", amount: 4_850, wallet: "wallet_bkash_merchant", day: 15, note: "DESCO electricity bill" },
    { cat: "expcat_utility", nature: "FIXED", amount: 1_500, wallet: "wallet_bkash_merchant", day: 14, note: "Internet (ISP)" },
    { cat: "expcat_packaging", nature: "VARIABLE", amount: 3_200, wallet: "wallet_showroom_cash", day: 12, note: "Poly mailers ×500, tape" },
    { cat: "expcat_packaging", nature: "VARIABLE", amount: 1_150, wallet: "wallet_showroom_cash", day: 4, note: "Gift boxes ×50" },
    { cat: "expcat_transport", nature: "VARIABLE", amount: 650, wallet: "wallet_showroom_cash", day: 9, note: "CNG to Islampur wholesale market" },
    { cat: "expcat_transport", nature: "VARIABLE", amount: 420, wallet: "wallet_showroom_cash", day: 2, note: "Rickshaw van — parcel drop at Steadfast hub" },
    { cat: "expcat_courier", nature: "VARIABLE", amount: 780, wallet: "wallet_showroom_cash", day: 6, note: "Sundarban Courier — 6 outside-Dhaka parcels (cash)" },
    { cat: "expcat_misc", nature: "VARIABLE", amount: 300, wallet: "wallet_showroom_cash", day: 3, note: "Tea & snacks for customers" },
  ] as const;
  for (const e of expenses) {
    await prisma.expense.create({
      data: { expenseDate: dhakaDay(e.day), categoryId: e.cat, nature: e.nature, amount: e.amount, walletId: e.wallet, note: e.note, createdById: accounts.id },
    });
  }

  // A week of Facebook boosts, each posting its Ad cost expense.
  const adDays = [7, 6, 5, 4, 3, 2, 1, 0];
  const adAmounts = [1200, 950, 1500, 800, 1100, 1350, 1000, 700];
  for (const [i, n] of adDays.entries()) {
    const spend = await prisma.dailyAdSpend.create({
      data: { spendDate: dhakaDay(n), platform: i % 4 === 3 ? "INSTAGRAM" : "FACEBOOK", amount: adAmounts[i], walletId: "wallet_bkash_merchant", createdById: admin.id },
    });
    await prisma.expense.create({
      data: {
        expenseDate: spend.spendDate,
        categoryId: "expcat_ad_cost",
        nature: "VARIABLE",
        amount: spend.amount,
        walletId: spend.walletId,
        note: `Ad spend — ${spend.platform === "INSTAGRAM" ? "Instagram" : "Facebook"}`,
        adSpendId: spend.id,
        createdById: admin.id,
      },
    });
  }

  // Owner topped up the cash drawer; bKash personal cashed out to the bank.
  await prisma.walletEntry.create({
    data: { walletId: "wallet_showroom_cash", type: "MANUAL_IN", amount: 5_000, entryDate: dhakaDay(10), note: "Owner added change for the cash drawer", createdById: admin.id },
  });
  const transferId = "seed-transfer-0001";
  for (const [walletId, type] of [["wallet_bkash_personal", "TRANSFER_OUT"], ["wallet_bank", "TRANSFER_IN"]] as const) {
    await prisma.walletEntry.create({
      data: { walletId, type, amount: 15_000, entryDate: dhakaDay(8), note: "bKash cash-out to bank", transferId, createdById: accounts.id },
    });
  }
}

/** Mirror of lib/orders/totals.ts recomputeOrderDueAmount (server-only, so not importable here). */
async function recomputeDue(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { total: true } });
  const paid = await prisma.payment.aggregate({
    where: { orderId, OR: [{ kind: "PAYMENT" }, { kind: "REFUND", refundStatus: "APPROVED" }] },
    _sum: { amount: true },
  });
  await prisma.order.update({ where: { id: orderId }, data: { dueAmount: Number(order.total) - Number(paid._sum.amount ?? 0) } });
}

// ---------------------------------------------------------------------------
// P3.1 — POS: showroom sales and the cash drawer
// ---------------------------------------------------------------------------

const POS_CASH_WALLET_ID = "wallet_showroom_cash";

/**
 * Mirror of lib/wallets/ledger.ts's derived balance (server-only, so not
 * importable here): opening + verified payments − approved refunds −
 * expenses ± entries + paid courier payouts, dated on/after openingDate and
 * before `before`.
 */
async function walletBookBalance(walletId: string, before: Date): Promise<number> {
  const [row] = await prisma.$queryRaw<{ balance: string }[]>`
    WITH w AS (SELECT "openingBalance", "openingDate" FROM "wallets" WHERE "id" = ${walletId}),
    f AS (
      SELECT p."amount", p."paidAt" AS "at" FROM "payments" p
       WHERE p."walletId" = ${walletId} AND ((p."kind" = 'PAYMENT' AND p."verified") OR (p."kind" = 'REFUND' AND p."refundStatus" = 'APPROVED'))
      UNION ALL SELECT -e."amount", e."expenseDate" FROM "expenses" e WHERE e."walletId" = ${walletId} AND e."deletedAt" IS NULL
      UNION ALL SELECT CASE WHEN we."type" IN ('MANUAL_IN', 'TRANSFER_IN') THEN we."amount" ELSE -we."amount" END, we."entryDate" FROM "wallet_entries" we WHERE we."walletId" = ${walletId} AND we."voidedAt" IS NULL
      UNION ALL SELECT s."netAmount", s."statementDate" FROM "courier_statements" s WHERE s."walletId" = ${walletId} AND s."status" = 'PAID'
    )
    SELECT ((SELECT "openingBalance" FROM w) + COALESCE((SELECT SUM(f."amount") FROM f, w WHERE f."at" >= w."openingDate" AND f."at" < ${before}), 0))::text AS "balance"`;
  return Number(row.balance);
}

type PosDemoSale = {
  at: Date;
  lines: { variantId: string; qty: number; lineDiscount?: number }[];
  customer?: { phone: string; name: string };
  tenders: { method: "CASH" | "BKASH" | "NAGAD" | "CARD"; amount?: number; tendered?: number; walletId: string; trx?: string }[];
  verified: boolean;
};

/**
 * Written the way lib/pos/sale.ts writes a sale (server-only, so mirrored):
 * WALK_IN, straight to COMPLETED, cost frozen, POS_SALE_OUT through the real
 * ledger function, payments paying the total exactly.
 */
async function seedPosSale(posUserId: string, teamId: string | null, sale: PosDemoSale) {
  await prisma.$transaction(async (tx) => {
    const variants = await tx.productVariant.findMany({ where: { id: { in: sale.lines.map((l) => l.variantId) } }, include: { product: { select: { basePrice: true } } } });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const priced = sale.lines.map((l) => {
      const v = byId.get(l.variantId)!;
      const price = Number((v.priceOverride ?? v.product.basePrice).toString());
      return { ...l, v, price, discount: l.lineDiscount ?? 0 };
    });
    const subtotal = priced.reduce((a, l) => a + l.qty * l.price, 0);
    const discount = priced.reduce((a, l) => a + l.discount, 0);
    const total = subtotal - discount;

    let customerId: string | null = null;
    if (sale.customer) {
      const c = await tx.customer.upsert({ where: { phone: sale.customer.phone }, update: {}, create: { name: sale.customer.name, phone: sale.customer.phone, createdById: posUserId, teamId } });
      customerId = c.id;
    }
    const order = await tx.order.create({
      data: {
        orderNo: await nextOrderNo(tx, sale.at),
        channel: "WALK_IN",
        status: "COMPLETED",
        customerId,
        subtotal,
        discountTotal: discount,
        total,
        dueAmount: 0,
        createdById: posUserId,
        teamId,
        createdAt: sale.at,
      },
    });
    for (const l of priced) {
      await tx.orderItem.create({ data: { orderId: order.id, variantId: l.v.id, qty: l.qty, unitPrice: l.price, lineDiscount: l.discount, unitCostSnapshot: l.v.weightedAvgCost } });
      await recordStockMovement(tx, { variantId: l.v.id, locationId: SEEDED_LOCATION_IDS.shyamoli, type: "POS_SALE_OUT", qty: -l.qty, unitCost: l.v.weightedAvgCost, referenceType: "ORDER", referenceId: order.id, actorId: posUserId });
    }
    let left = total;
    for (const [i, t] of sale.tenders.entries()) {
      const amount = i === sale.tenders.length - 1 ? left : t.amount!;
      left -= amount;
      const change = t.method === "CASH" && t.tendered ? t.tendered - amount : 0;
      await tx.payment.create({
        data: {
          orderId: order.id,
          amount,
          method: t.method,
          walletId: t.walletId,
          transactionId: t.trx ?? null,
          paidAt: sale.at,
          receivedById: posUserId,
          verified: sale.verified,
          verifiedById: sale.verified ? posUserId : null,
          verifiedAt: sale.verified ? sale.at : null,
          cashTendered: t.method === "CASH" && t.tendered && t.tendered >= amount ? t.tendered : null,
          note: change > 0 ? `Tendered ৳ ${t.tendered}, change ৳ ${change}` : null,
        },
      });
    }
    await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: null, toStatus: "COMPLETED", changedById: posUserId, note: "Showroom sale (POS) — paid in full at the counter", createdAt: sale.at } });
  });
}

/**
 * P3.1 demo: yesterday's drawer counted and closed ৳20 short (posted to Cash
 * over/short, its cash verified by the count), today's drawer open with a
 * couple of sales in it, and price-tag-ready SKUs. Skipped once any drawer exists.
 */
async function seedPosDemo() {
  if ((await prisma.cashDrawer.count()) > 0) return;
  const pos = await prisma.user.findUniqueOrThrow({ where: { phone: "01711000007" } });
  const dhakaDayStr = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date(Date.now() - n * 86_400_000));
  const dayStart = (n: number) => new Date(`${dhakaDayStr(n)}T00:00:00+06:00`);
  const at = (n: number, hh: number, mm: number) => new Date(`${dhakaDayStr(n)}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+06:00`);

  const sellable = await prisma.productVariant.findMany({ where: { isActive: true, product: { deletedAt: null, isActive: true } }, orderBy: { sku: "asc" } });
  const pick = sellable.filter((v) => v.stockQty - v.reservedQty >= 3);
  if (pick.length < 3) return;
  const [a, b, c] = pick;
  const bkash = await prisma.wallet.findFirst({ where: { type: "BKASH", isActive: true }, orderBy: { sortOrder: "asc" } });
  const bank = await prisma.wallet.findFirst({ where: { type: "BANK", isActive: true }, orderBy: { sortOrder: "asc" } });
  if (!bkash || !bank) return;

  // Yesterday: open at what the books said, three sales, a petty expense, closed ৳20 short.
  const yOpen = at(1, 10, 5);
  const yOpening = await walletBookBalance(POS_CASH_WALLET_ID, dayStart(1));
  const yesterday = await prisma.cashDrawer.create({
    data: { walletId: POS_CASH_WALLET_ID, businessDay: dayStart(1), openedAt: yOpen, openedById: pos.id, openingCount: yOpening, bookBalanceAtOpen: yOpening },
  });
  await seedPosSale(pos.id, pos.teamId, { at: at(1, 11, 20), lines: [{ variantId: a.id, qty: 1 }], tenders: [{ method: "CASH", walletId: POS_CASH_WALLET_ID, tendered: 5000 }], verified: true });
  await seedPosSale(pos.id, pos.teamId, {
    at: at(1, 14, 45),
    lines: [{ variantId: b.id, qty: 1, lineDiscount: 100 }],
    customer: { phone: "01899100201", name: "Nusrat Jahan (showroom)" },
    tenders: [{ method: "BKASH", walletId: bkash.id, trx: "SEED-POS-BK-1101" }],
    verified: false,
  });
  await seedPosSale(pos.id, pos.teamId, { at: at(1, 17, 30), lines: [{ variantId: c.id, qty: 1 }], tenders: [{ method: "CARD", walletId: bank.id }], verified: false });
  await prisma.expense.create({ data: { expenseDate: dayStart(1), categoryId: "expcat_misc", nature: "VARIABLE", amount: 120, walletId: POS_CASH_WALLET_ID, note: "Tea & biscuits for customers", createdById: pos.id } });

  const yCash = await prisma.payment.aggregate({ where: { walletId: POS_CASH_WALLET_ID, kind: "PAYMENT", paidAt: { gte: dayStart(1), lt: dayStart(0) } }, _sum: { amount: true } });
  const yExpected = yOpening + Number(yCash._sum.amount ?? 0) - 120;
  const yCounted = yExpected - 20;
  const yClose = at(1, 20, 40);
  await prisma.expense.create({
    data: { expenseDate: dayStart(1), categoryId: "expcat_cash_over_short", nature: "VARIABLE", amount: 20, walletId: POS_CASH_WALLET_ID, note: `Cash short ৳ 20 at the ${dhakaDayStr(1)} drawer count — gave ৳20 too much change`, cashDrawerId: yesterday.id, createdById: pos.id },
  });
  await prisma.cashDrawer.update({
    where: { id: yesterday.id },
    data: { status: "CLOSED", closedAt: yClose, closedById: pos.id, closingCount: yCounted, expectedClose: yExpected, difference: yCounted - yExpected, closeNote: "Gave ৳20 too much change on the afternoon rush" },
  });

  // Today: opened at yesterday's count, two sales so far — one anonymous cash with change.
  await prisma.cashDrawer.create({
    data: { walletId: POS_CASH_WALLET_ID, businessDay: dayStart(0), openedAt: new Date(Math.max(dayStart(0).getTime() + 4 * 3_600_000, Date.now() - 3_600_000)), openedById: pos.id, openingCount: yCounted, bookBalanceAtOpen: yCounted },
  });
  await seedPosSale(pos.id, pos.teamId, { at: new Date(Date.now() - 40 * 60_000), lines: [{ variantId: a.id, qty: 1 }], tenders: [{ method: "CASH", walletId: POS_CASH_WALLET_ID, tendered: 5000 }], verified: false });
  await seedPosSale(pos.id, pos.teamId, {
    at: new Date(Date.now() - 15 * 60_000),
    lines: [{ variantId: b.id, qty: 1 }],
    customer: { phone: "01899100201", name: "Nusrat Jahan (showroom)" },
    tenders: [{ method: "CASH", amount: 500, walletId: POS_CASH_WALLET_ID }, { method: "NAGAD", walletId: (await prisma.wallet.findFirst({ where: { type: "NAGAD", isActive: true } }))?.id ?? bkash.id, trx: "SEED-POS-NG-2201" }],
    verified: false,
  });
}

// ---------------------------------------------------------------------------
// P3.2 — returns and exchanges demo (PRD §4.11): one of each state, built
// through the real services so stock, ledger, credit and audit are genuine.
// ---------------------------------------------------------------------------

type SessionLike = { id: string; role: RoleName; teamId: string | null };

async function sessionFor(phone: string): Promise<SessionLike> {
  const u = await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true, teamId: true, role: { select: { name: true } } } });
  return { id: u.id, role: u.role.name, teamId: u.teamId };
}

/** Pairs of active variants of one product, both with stock to spare: the one sold and the one it's swapped for. */
async function variantPairs(minAvailable: number) {
  const variants = await prisma.productVariant.findMany({
    where: { isActive: true, product: { isActive: true, deletedAt: null } },
    orderBy: { sku: "asc" },
    select: { id: true, productId: true, stockQty: true, reservedQty: true, product: { select: { basePrice: true } }, priceOverride: true },
  });
  const byProduct = new Map<string, typeof variants>();
  for (const v of variants) if (v.stockQty - v.reservedQty >= minAvailable) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);
  // Every product gives as many disjoint pairs as it has stocked variants for.
  return [...byProduct.values()].flatMap((vs) =>
    Array.from({ length: Math.floor(vs.length / 2) }, (_, i) => ({ sold: vs[2 * i], swap: vs[2 * i + 1], price: Number(vs[2 * i].priceOverride ?? vs[2 * i].product.basePrice) })),
  );
}

type DemoOrderEnd = "CONFIRMED" | "IN_TRANSIT" | "DELIVERED" | "RETURNED";

/**
 * A delivered online order sold by the demo SE, paid in full by bKash (verified), packed and walked through the courier statuses.
 * P4.2: `opts` sells it as someone else and/or stops it earlier — still CONFIRMED, on the way, or refused at the door
 * (RETURNED from the courier: cash on delivery, so nothing was paid, and the return waits for Packing's check).
 */
async function seedDeliveredOrder(
  customerPhone: string,
  variantId: string,
  qty: number,
  unitPrice: number,
  daysAgo: number,
  opts: { sellerPhone?: string; end?: DemoOrderEnd } = {},
): Promise<{ id: string; itemId: string }> {
  const end = opts.end ?? "DELIVERED";
  const [se, packer, accounts] = await Promise.all([sessionFor(opts.sellerPhone ?? "01711000004"), sessionFor("01711000005"), sessionFor("01711000006")]);
  const customer = await prisma.customer.findUniqueOrThrow({ where: { phone: customerPhone } });
  const bkash = await prisma.wallet.findFirstOrThrow({ where: { type: "BKASH", isActive: true }, orderBy: { sortOrder: "asc" } });
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  return prisma.$transaction(
    async (tx: Tx) => {
      const total = qty * unitPrice;
      const order = await tx.order.create({
        data: {
          orderNo: await nextOrderNo(tx, at),
          channel: "ONLINE",
          status: "CONFIRMED",
          customerId: customer.id,
          subtotal: total,
          total,
          dueAmount: end === "RETURNED" ? total : 0,
          createdById: se.id,
          teamId: se.teamId,
          createdAt: at,
          items: { create: [{ variantId, qty, unitPrice }] },
        },
        include: { items: true },
      });
      await tx.productVariant.update({ where: { id: variantId }, data: { reservedQty: { increment: qty } } });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, toStatus: "CONFIRMED", changedById: se.id, createdAt: at } });
      if (end !== "RETURNED") {
        await tx.payment.create({
          data: { orderId: order.id, amount: total, method: "BKASH", walletId: bkash.id, paidAt: at, receivedById: se.id, verified: true, verifiedById: accounts.id, verifiedAt: at, note: "Demo: paid in full by bKash" },
        });
      }
      if (end === "CONFIRMED") return { id: order.id, itemId: order.items[0].id };
      await packOrder(tx, { id: order.id, status: "CONFIRMED", items: order.items }, packer.id);
      const path = { IN_TRANSIT: ["HANDED_TO_COURIER", "IN_TRANSIT"], DELIVERED: ["HANDED_TO_COURIER", "IN_TRANSIT", "DELIVERED"], RETURNED: ["HANDED_TO_COURIER", "IN_TRANSIT", "RETURNED"] } as const;
      let status: OrderStatusName = "PACKED";
      for (const next of path[end]) {
        await moveOrderStatus(tx, { id: order.id, status, items: [] }, next, packer.id);
        status = next;
      }
      return { id: order.id, itemId: order.items[0].id };
    },
    { timeout: 60_000 },
  );
}

async function seedReturnsDemo() {
  if ((await prisma.returnCase.count()) > 0) return;
  const [se, tl, manager, packer, pos] = await Promise.all(["01711000004", "01711000003", "01711000002", "01711000005", "01711000007"].map(sessionFor));
  const pairs = await variantPairs(3);
  if (pairs.length < 4) {
    console.log("Returns demo skipped: not enough products with two stocked variants.");
    return;
  }

  // 1. Awaiting approval: a size exchange the SE asked for.
  const a = await seedDeliveredOrder("01911223344", pairs[0].sold.id, 1, pairs[0].price, 4);
  await requestReturnCase(prisma, se, {
    orderId: a.id,
    type: "EXCHANGE",
    reason: "WRONG_SIZE",
    reasonNote: "Customer says it's tight at the chest",
    courierChargeBearer: "CUSTOMER",
    lines: [{ orderItemId: a.itemId, qty: 1, replacementVariantId: pairs[0].swap.id }],
  });

  // 2. Approved, waiting for the item: we pay delivery on the replacement.
  const b = await seedDeliveredOrder("01812345678", pairs[1].sold.id, 1, pairs[1].price, 6);
  const bCase = await requestReturnCase(prisma, se, {
    orderId: b.id,
    type: "EXCHANGE",
    reason: "DEFECTIVE",
    reasonNote: "Loose stitching on the hem",
    courierChargeBearer: "COMPANY",
    lines: [{ orderItemId: b.itemId, qty: 1, replacementVariantId: pairs[1].swap.id }],
  });
  await decideReturnCase(prisma, tl, bCase.id, { decision: "APPROVE", note: "Our fault — we pay the courier" });

  // 3. Completed return: two came back, one good, one damaged (written off at cost).
  const c = await seedDeliveredOrder("01911223344", pairs[2].sold.id, 2, pairs[2].price, 9);
  const cCase = await requestReturnCase(prisma, se, { orderId: c.id, type: "RETURN", reason: "NOT_AS_EXPECTED", reasonNote: "Colour looked different in the photo", lines: [{ orderItemId: c.itemId, qty: 2 }] });
  await decideReturnCase(prisma, manager, cCase.id, { decision: "APPROVE" });
  const cInspection = await prisma.returnCase.findUniqueOrThrow({ where: { id: cCase.id }, select: { inspectionId: true } });
  await prisma.$transaction((tx: Tx) => completeConditionCheck(tx, { inspectionId: cInspection.inspectionId!, lines: [{ orderItemId: c.itemId, goodQty: 1, damagedQty: 1 }], note: "One has a lipstick stain" }, packer.id), { timeout: 60_000 });

  // 4. Rejected.
  const d = await seedDeliveredOrder("01812345678", pairs[3].sold.id, 1, pairs[3].price, 20);
  const dCase = await requestReturnCase(prisma, se, { orderId: d.id, type: "RETURN", reason: "OTHER", reasonNote: "Customer changed their mind", lines: [{ orderItemId: d.itemId, qty: 1 }] });
  await decideReturnCase(prisma, tl, dCase.id, { decision: "REJECT", note: "Worn and washed — can't be resold" });

  // 5. At the counter: a walk-in swaps a size of the same garment, no difference to pay.
  const walkIn = await prisma.order.findFirst({
    where: { channel: "WALK_IN", status: "COMPLETED", exchangedFromOrderId: null },
    orderBy: { createdAt: "asc" },
    include: { items: { include: { variant: { select: { productId: true } } } } },
  });
  const item = walkIn?.items[0];
  const swap = item
    ? await prisma.productVariant.findFirst({ where: { productId: item.variant.productId, id: { not: item.variantId }, isActive: true, stockQty: { gte: 2 } }, orderBy: { sku: "asc" } })
    : null;
  if (walkIn && item && swap) {
    await createCounterExchange(prisma, { user: pos, cashWalletId: await getPosCashWalletId(prisma), canCreateCustomer: true }, {
      orderId: walkIn.id,
      reason: "WRONG_SIZE",
      lines: [{ orderItemId: item.id, qty: 1, replacementVariantId: swap.id, goodQty: 1, damagedQty: 0 }],
      tenders: [],
    });
  }
}

// P3.2 — store credit: a walk-in swaps for something cheaper at the counter
// (the difference goes to credit, the anonymous sale gets a phone number),
// and the Admin adds goodwill credit for a regular. Through the real services.
async function seedStoreCreditDemo() {
  if ((await prisma.storeCreditEntry.count()) > 0) return;
  const [pos, admin] = await Promise.all(["01711000007", "01711000001"].map(sessionFor));

  const walkIn = await prisma.order.findFirst({
    where: { channel: "WALK_IN", status: "COMPLETED", exchangedFromOrderId: null, returnCases: { none: {} } },
    orderBy: { createdAt: "asc" },
    include: { items: { include: { variant: { select: { productId: true } } } } },
  });
  const item = walkIn?.items.find((i) => i.returnedQty < i.qty);
  const cheaper = item
    ? await prisma.productVariant.findFirst({
        where: { productId: { not: item.variant.productId }, isActive: true, priceOverride: null, stockQty: { gte: 3 }, product: { isActive: true, deletedAt: null, basePrice: { lt: item.unitPrice } } },
        orderBy: { product: { basePrice: "asc" } },
      })
    : null;
  if (walkIn && item && cheaper) {
    await createCounterExchange(prisma, { user: pos, cashWalletId: await getPosCashWalletId(prisma), canCreateCustomer: true }, {
      orderId: walkIn.id,
      reason: "NOT_AS_EXPECTED",
      reasonNote: "Wanted something lighter for summer",
      lines: [{ orderItemId: item.id, qty: 1, replacementVariantId: cheaper.id, goodQty: 1, damagedQty: 0 }],
      tenders: [],
      customer: walkIn.customerId ? null : { phone: "01911223344" },
    });
  } else {
    console.log("Store credit counter demo skipped: no walk-in sale with a cheaper product to swap to.");
  }

  const regular = await prisma.customer.findUnique({ where: { phone: "01812345678" } });
  if (regular) await adjustStoreCredit(prisma, { customerId: regular.id, amount: 300, reason: "Goodwill — the parcel arrived two days late", actorId: admin.id });
}

// P3.3 — outfit sets and packaging (PRD §4.2). Antu's branded packaging as
// component-only products with opening stock; a dupatta and a plazo so a
// three-piece set can be built from separate products; two sets; the
// packaging rules; and one set sold online (reserved) and one at the counter
// (packaging taken out of stock). All through the real services.
async function seedSetsAndPackagingDemo() {
  if ((await prisma.outfitSet.count()) > 0) return;
  const [admin, se, pos] = await Promise.all(["01711000001", "01711000004", "01711000007"].map(sessionFor));
  const [sizes, colors] = await Promise.all([prisma.size.findMany(), prisma.color.findMany()]);
  const size = (name: string) => sizes.find((s) => s.name === name)!;
  const color = (name: string) => colors.find((c) => c.name === name)!;

  async function product(input: { code: string; name: string; kind: "SELLABLE" | "COMPONENT_ONLY"; basePrice: number; cost: number; stock: number; variants: [string, string][] }) {
    const existing = await prisma.product.findUnique({ where: { code: input.code } });
    if (existing) return prisma.product.findUniqueOrThrow({ where: { id: existing.id }, include: { variants: true } });
    const p = await prisma.product.create({ data: { code: input.code, name: input.name, kind: input.kind, basePrice: input.basePrice, createdById: admin.id } });
    for (const [s, c] of input.variants) {
      const v = await prisma.productVariant.create({
        data: { productId: p.id, sizeId: size(s).id, colorId: color(c).id, sku: buildVariantSku(input.code, size(s).code, color(c).code), weightedAvgCost: input.cost },
      });
      // C3 — packaging sits mostly at the packing hub, with a share at the
      // showroom for counter sales (bags, tissue).
      const atShowroom = input.kind === "COMPONENT_ONLY" ? Math.floor(input.stock / 3) : Math.min(2, input.stock);
      await prisma.$transaction(async (tx: Tx) => {
        await recordStockMovement(tx, { variantId: v.id, locationId: SEEDED_LOCATION_IDS.mohammadpur, type: "PURCHASE_IN", qty: input.stock - atShowroom, unitCost: input.cost, referenceType: "OPENING_BALANCE", actorId: admin.id, note: "Opening stock" });
        if (atShowroom > 0) await recordStockMovement(tx, { variantId: v.id, locationId: SEEDED_LOCATION_IDS.shyamoli, type: "PURCHASE_IN", qty: atShowroom, unitCost: input.cost, referenceType: "OPENING_BALANCE", actorId: admin.id, note: "Opening stock — showroom" });
      });
    }
    return prisma.product.findUniqueOrThrow({ where: { id: p.id }, include: { variants: true } });
  }

  // Packaging materials: never sold, no price, costed from purchases.
  const bag = await product({ code: "BG1", name: "Antu shopping bag", kind: "COMPONENT_ONLY", basePrice: 0, cost: 18, stock: 300, variants: [["Free", "White"]] });
  const mailer = await product({ code: "ML1", name: "Antu mailer bag", kind: "COMPONENT_ONLY", basePrice: 0, cost: 9, stock: 400, variants: [["Free", "Black"]] });
  const box = await product({ code: "BX1", name: "Saree gift box", kind: "COMPONENT_ONLY", basePrice: 0, cost: 55, stock: 40, variants: [["Free", "Maroon"]] });
  const tissue = await product({ code: "TS1", name: "Tissue paper sheet", kind: "COMPONENT_ONLY", basePrice: 0, cost: 2, stock: 1000, variants: [["Free", "Pink"]] });
  const tag = await product({ code: "TG1", name: "Brand hang tag", kind: "COMPONENT_ONLY", basePrice: 0, cost: 3, stock: 800, variants: [["Free", "Black"]] });

  // Separate pieces a set is built from.
  const dupatta = await product({ code: "D01", name: "Chiffon Dupatta", kind: "SELLABLE", basePrice: 600, cost: 220, stock: 12, variants: [["Free", "Maroon"], ["Free", "Mustard Yellow"], ["Free", "Pink"]] });
  const plazo = await product({ code: "P01", name: "Cotton Plazo", kind: "SELLABLE", basePrice: 900, cost: 350, stock: 8, variants: [["M", "White"], ["L", "White"], ["XL", "White"], ["M", "Black"], ["L", "Black"]] });
  const [kurti, saree, top] = await Promise.all(["K12", "S01", "W02"].map((code) => prisma.product.findUnique({ where: { code } })));
  if (!kurti || !saree || !top) {
    console.log("Outfit set demo skipped: the demo kurti, saree or top is missing.");
    return;
  }

  // Packaging rules: every parcel a mailer bag; every counter sale a bag and
  // two sheets of tissue; a tag on every kurti and top; a box with every saree.
  await setPackaging(prisma, admin.id, { scope: "ONLINE_PARCEL" }, [{ materialVariantId: mailer.variants[0].id, qty: 1 }]);
  await setPackaging(prisma, admin.id, { scope: "POS_SALE" }, [
    { materialVariantId: bag.variants[0].id, qty: 1 },
    { materialVariantId: tissue.variants[0].id, qty: 2 },
  ]);
  await setPackaging(prisma, admin.id, { productId: saree.id }, [{ materialVariantId: box.variants[0].id, qty: 1 }]);
  for (const p of [kurti, top]) await setPackaging(prisma, admin.id, { productId: p.id }, [{ materialVariantId: tag.variants[0].id, qty: 1 }]);

  const eid = await saveSet(prisma, admin.id, {
    name: "Eid Three-Piece — Kurti + Dupatta + Plazo",
    description: "Pick the kurti, dupatta and plazo separately — any size, any colour.",
    price: 2800,
    isActive: true,
    components: [
      { productId: kurti.id, qty: 1 },
      { productId: dupatta.id, qty: 1 },
      { productId: plazo.id, qty: 1 },
    ],
    packaging: [{ materialVariantId: tissue.variants[0].id, qty: 1 }],
  });
  await saveSet(prisma, admin.id, {
    name: "Mother & Daughter — Saree + 2 Tops",
    price: 5500,
    isActive: true,
    components: [
      { productId: saree.id, qty: 1 },
      { productId: top.id, qty: 2 },
    ],
    packaging: [],
  });

  // Choices for the Eid set: the first in-stock size/colour of each piece.
  const inStock = async (productId: string, need: number) =>
    (await prisma.productVariant.findMany({ where: { productId, isActive: true }, orderBy: { sku: "asc" } })).find((v) => v.stockQty - v.reservedQty >= need)?.id;
  const choices: { productId: string; variantId: string }[] = [];
  for (const productId of [kurti.id, dupatta.id, plazo.id]) {
    const variantId = await inStock(productId, 2);
    if (!variantId) {
      console.log("Outfit set sales demo skipped: a component is out of stock.");
      return;
    }
    choices.push({ productId, variantId });
  }

  // Sold online (confirmed, reserved) to a demo customer…
  const customer = await prisma.customer.findUnique({ where: { phone: "01911223344" } });
  if (customer) {
    await prisma.$transaction(
      async (tx: Tx) => {
        const [line] = await resolveSetLines(tx, [{ setId: eid.id, qty: 1, unitPrice: 2800, lineDiscount: 0, choices }], { hasCostAccess: true });
        const totals = computeOrderTotals(line.children, 80);
        const order = await tx.order.create({
          data: {
            orderNo: await generateOrderNumber(tx),
            channel: "ONLINE",
            status: "CONFIRMED",
            customerId: customer.id,
            deliveryCharge: 80,
            subtotal: totals.subtotal,
            discountTotal: totals.discountTotal,
            total: totals.total,
            dueAmount: totals.total,
            createdById: se.id,
            teamId: se.teamId,
          },
        });
        for (const child of await writeSetLines(tx, order.id, [line])) await reserveVariantStock(tx, child.variantId, child.qty);
        await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: null, toStatus: "CONFIRMED", changedById: se.id, note: "Order created — Eid set" } });
      },
      { timeout: 60_000 },
    );
  }

  // …and at the counter, paid by card: the bag and tissue leave stock with it.
  await createPosSale(prisma, { user: pos, cashWalletId: await getPosCashWalletId(prisma), hasCostAccess: false, canCreateCustomer: true }, {
    items: [],
    sets: [{ setId: eid.id, qty: 1, unitPrice: 2800, lineDiscount: 100, choices }],
    cartDiscount: 0,
    customer: null,
    tenders: [{ method: "CARD", amount: 2700 }],
  });
}

// C3 (CORRECTIONS.md item 11) — a dress the showroom's figures say it
// doesn't have, sold at the counter because it was in hand: Shyamoli goes
// to −1 and its incharge and the managers get the Negative stock alert.
async function seedNegativeStockDemo() {
  if ((await prisma.variantStock.count({ where: { qty: { lt: 0 } } })) > 0) return;
  const pos = await sessionFor("01711000007");
  const candidates = await prisma.productVariant.findMany({
    where: { isActive: true, product: { isActive: true, deletedAt: null, kind: "SELLABLE" }, stockQty: { gt: 0 } },
    orderBy: { sku: "asc" },
    select: { id: true, sku: true, stockQty: true, reservedQty: true, priceOverride: true, product: { select: { basePrice: true } }, locationStocks: { where: { locationId: SEEDED_LOCATION_IDS.shyamoli }, select: { qty: true } } },
  });
  const v = candidates.find((c) => (c.locationStocks[0]?.qty ?? 0) === 0 && c.stockQty - c.reservedQty > 0);
  if (!v) return;
  const price = Number(v.priceOverride ?? v.product.basePrice);
  await createPosSale(
    prisma,
    { user: pos, cashWalletId: await getPosCashWalletId(prisma), hasCostAccess: false, canCreateCustomer: true },
    { items: [{ variantId: v.id, qty: 1, unitPrice: price, lineDiscount: 0 }], cartDiscount: 0, customer: null, tenders: [{ method: "CARD", amount: price }], acknowledgeNegativeStock: true, note: "Last piece was on the display rail" },
  );
}

// ---------------------------------------------------------------------------
// C4 — CORRECTIONS.md items 2 and 3: a transfer in every state, stock
// counts, and one waiting online order the hub can't pack until the
// showroom sends a dress over — all through the real services (scan by
// scan), so stock, the in-transit figure, the ledger and the audit log are
// genuine. Each part moves stock, so each is guarded on its own "already
// there" check.
// ---------------------------------------------------------------------------

async function seedTransfersAndCountsDemo() {
  const [admin, manager, packer, pos, se] = await Promise.all(["01711000001", "01711000002", "01711000005", "01711000007", "01711000004"].map(sessionFor));
  const HUB = SEEDED_LOCATION_IDS.mohammadpur;
  const SHOWROOM = SEEDED_LOCATION_IDS.shyamoli;
  const run = <T,>(fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) => prisma.$transaction(fn, { timeout: 60_000 });
  const scanN = async (id: string, user: SessionLike, side: "send" | "receive", sku: string, n: number) => {
    for (let i = 0; i < n; i++) await run((tx) => scanTransferUnit(tx, user, id, side, sku));
  };
  const sellable = () =>
    prisma.productVariant.findMany({
      where: { isActive: true, product: { isActive: true, deletedAt: null, kind: "SELLABLE" } },
      orderBy: { sku: "asc" },
      select: { id: true, sku: true, reservedQty: true, priceOverride: true, product: { select: { basePrice: true } }, locationStocks: { select: { locationId: true, qty: true } } },
    });
  const qtyAt = (v: Awaited<ReturnType<typeof sellable>>[number], locationId: string) => v.locationStocks.find((s) => s.locationId === locationId)?.qty ?? 0;

  // 1. A transfer in every state, from well-stocked hub variants.
  if ((await prisma.stockTransfer.count()) === 0) {
    const roomy = (await sellable()).filter((v) => qtyAt(v, HUB) - v.reservedQty >= 6);
    if (roomy.length >= 3) {
      const [v1, v2, v3] = roomy;
      // Received in full: 2 × v1, hub → Shyamoli showroom.
      const t1 = await run((tx) => createTransfer(tx, packer, { fromLocationId: HUB, toLocationId: SHOWROOM, note: "Restocking the display rail" }));
      await scanN(t1.id, packer, "send", v1.sku, 2);
      await run((tx) => sendTransfer(tx, packer, t1.id));
      await scanN(t1.id, pos, "receive", v1.sku, 2);
      await run((tx) => receiveTransfer(tx, pos, t1.id));
      // Received with a difference: 3 × v2 to the Parlour corner, 2 arrived — 1 still missing in transit.
      const t2 = await run((tx) => createTransfer(tx, admin, { fromLocationId: HUB, toLocationId: SEEDED_LOCATION_IDS.parlour, note: "Sent with the rickshaw van" }));
      await scanN(t2.id, admin, "send", v2.sku, 3);
      await run((tx) => sendTransfer(tx, admin, t2.id));
      await scanN(t2.id, admin, "receive", v2.sku, 2);
      await run((tx) => receiveTransfer(tx, admin, t2.id));
      // Short, and already resolved: 2 × v3 to the Studio, 1 arrived, the other written off ("Stock shortage").
      const t3 = await run((tx) => createTransfer(tx, admin, { fromLocationId: HUB, toLocationId: SEEDED_LOCATION_IDS.studio, note: "For the photo shoot" }));
      await scanN(t3.id, admin, "send", v3.sku, 2);
      await run((tx) => sendTransfer(tx, admin, t3.id));
      await scanN(t3.id, admin, "receive", v3.sku, 1);
      await run((tx) => receiveTransfer(tx, admin, t3.id));
      await run((tx) => resolveMissing(tx, manager, t3.id, { variantId: v3.id, action: "WRITE_OFF", qty: 1, reason: "Not in the van — the rider says only one was handed over" }));
      // In transit: 1 × v3 hub → Studio, waiting to be scanned in.
      const t4 = await run((tx) => createTransfer(tx, packer, { fromLocationId: HUB, toLocationId: SEEDED_LOCATION_IDS.studio }));
      await scanN(t4.id, packer, "send", v3.sku, 1);
      await run((tx) => sendTransfer(tx, packer, t4.id));
    }
  }

  // 2. "Needed at the packing hub": the hub's last pieces of a dress went to
  //    the showroom rail, then an online order came in for one.
  const NEED_NOTE = "Wants the one on the Shyamoli display rail — confirmed on Messenger.";
  if ((await prisma.order.count({ where: { internalNote: NEED_NOTE } })) === 0) {
    const w = (await sellable()).find((v) => v.reservedQty === 0 && qtyAt(v, HUB) >= 2 && qtyAt(v, HUB) <= 5);
    if (w) {
      const moved = qtyAt(w, HUB);
      const t = await run((tx) => createTransfer(tx, packer, { fromLocationId: HUB, toLocationId: SHOWROOM, note: "Last pieces to the display rail" }));
      await scanN(t.id, packer, "send", w.sku, moved);
      await run((tx) => sendTransfer(tx, packer, t.id));
      await scanN(t.id, pos, "receive", w.sku, moved);
      await run((tx) => receiveTransfer(tx, pos, t.id));
      const customer = await prisma.customer.findUniqueOrThrow({ where: { phone: "01911223344" } });
      const price = Number(w.priceOverride ?? w.product.basePrice);
      await run(async (tx) => {
        const order = await tx.order.create({
          data: {
            orderNo: await nextOrderNo(tx, new Date()),
            channel: "ONLINE",
            status: "CONFIRMED",
            customerId: customer.id,
            subtotal: price,
            total: price,
            dueAmount: price,
            internalNote: NEED_NOTE,
            createdById: se.id,
            teamId: se.teamId,
          },
        });
        await tx.orderItem.create({ data: { orderId: order.id, variantId: w.id, qty: 1, unitPrice: price } });
        await reserveVariantStock(tx, w.id, 1);
        await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: null, toStatus: "CONFIRMED", changedById: se.id, note: "Order created" } });
      });
    }
  }

  // 3. A posted spot count at the showroom (one dress short) …
  if ((await prisma.stockCount.count({ where: { status: "POSTED" } })) === 0) {
    const shelf = (await sellable()).filter((v) => qtyAt(v, SHOWROOM) >= 2).slice(0, 2);
    if (shelf.length > 0) {
      const sc = await run((tx) => createStockCount(tx, pos, { locationId: SHOWROOM, scope: "SPOT", note: "Front rail" }));
      const last = shelf.length - 1;
      for (const [i, v] of shelf.entries()) {
        const n = qtyAt(v, SHOWROOM) - (i === last ? 1 : 0);
        for (let k = 0; k < n; k++) await run((tx) => scanCountUnit(tx, pos, sc.id, v.sku));
      }
      await run((tx) => postStockCount(tx, manager, sc.id));
    }
  }

  // 4. … and one still being counted at the hub.
  if ((await prisma.stockCount.count({ where: { status: "OPEN" } })) === 0) {
    const rack = (await sellable()).filter((v) => qtyAt(v, HUB) > 0).slice(0, 2);
    const open = await run((tx) => createStockCount(tx, packer, { locationId: HUB, scope: "SPOT", note: "Rack A" }));
    for (const v of rack) await run((tx) => scanCountUnit(tx, packer, open.id, v.sku));
  }
}

async function seedSettings() {
  await prisma.setting.upsert({
    where: { key: ORDER_EDIT_WINDOW_SETTING_KEY },
    update: {},
    create: { key: ORDER_EDIT_WINDOW_SETTING_KEY, value: String(DEFAULT_ORDER_EDIT_WINDOW_MINUTES) },
  });
  await prisma.setting.upsert({
    where: { key: PACKING_SLA_HOURS_SETTING_KEY },
    update: {},
    create: { key: PACKING_SLA_HOURS_SETTING_KEY, value: String(DEFAULT_PACKING_SLA_HOURS) },
  });
  // Mirrors lib/expenses/constants.ts AD_ALLOCATION_SETTING_KEY / DEFAULT_AD_ALLOCATION.
  await prisma.setting.upsert({ where: { key: "ad_cost_allocation" }, update: {}, create: { key: "ad_cost_allocation", value: "EQUAL" } });
  // P4.2 — office hours drive the late / half-day flags (lib/attendance/office-hours.ts).
  await prisma.setting.upsert({ where: { key: OFFICE_HOURS_SETTING_KEY }, update: {}, create: { key: OFFICE_HOURS_SETTING_KEY, value: JSON.stringify(DEFAULT_OFFICE_HOURS) } });
}

// P4.1 (PRD §4.5) — leads across the whole funnel for the demo SE, the
// Team Leader and the Manager, with follow-ups overdue, due today and
// upcoming, a few converted into the demo orders they already placed, and
// a few days of quick-entry counts.
async function seedLeadsDemo() {
  if ((await prisma.lead.count()) > 0) return;
  const [se, tl, manager] = await Promise.all(["01711000004", "01711000003", "01711000002"].map((phone) => prisma.user.findUniqueOrThrow({ where: { phone } })));
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = Date.now();
  const ago = (days: number, hours = 0) => new Date(now - days * DAY - hours * HOUR);

  type DemoLead = {
    owner: typeof se;
    name: string;
    phone?: string;
    source: "FACEBOOK_AD" | "MESSENGER" | "WHATSAPP" | "INSTAGRAM" | "REFERRAL" | "REPEAT_CUSTOMER" | "SHOWROOM_WALK_IN" | "OTHER";
    campaign?: string;
    interest?: string;
    status: "NEW" | "CONTACTED" | "FOLLOW_UP" | "NEGOTIATING" | "CONVERTED" | "LOST";
    lost?: ["PRICE" | "SIZE_UNAVAILABLE" | "NO_RESPONSE" | "BOUGHT_ELSEWHERE" | "OTHER", string?];
    createdDaysAgo: number;
    /** Hours from now: negative = overdue. */
    followUps?: { inHours: number; note?: string }[];
    done?: { daysAgo: number; outcome: string }[];
  };

  const leads: DemoLead[] = [
    { owner: se, name: "Nusrat Jahan", phone: "01755123401", source: "FACEBOOK_AD", campaign: "Eid Collection", interest: "Maroon kurti, size M", status: "FOLLOW_UP", createdDaysAgo: 2, followUps: [{ inHours: -20, note: "Send the size chart" }], done: [{ daysAgo: 2, outcome: "Asked for price, sent photos" }] },
    { owner: se, name: "Sadia Afrin", phone: "01755123402", source: "MESSENGER", campaign: "Eid Collection", interest: "Three-piece in olive, L", status: "NEGOTIATING", createdDaysAgo: 3, followUps: [{ inHours: -2, note: "Wants 10% off — check with TL" }] },
    { owner: se, name: "Farzana Rahman", source: "INSTAGRAM", interest: "The printed dupatta from Friday's reel", status: "FOLLOW_UP", createdDaysAgo: 1, followUps: [{ inHours: 3, note: "She'll confirm after salary day" }] },
    { owner: se, name: "Tahmina Akter", phone: "01755123404", source: "WHATSAPP", interest: "Plazo set, black", status: "CONTACTED", createdDaysAgo: 1, followUps: [{ inHours: 5 }] },
    { owner: se, name: "Rumana Islam", phone: "01755123405", source: "FACEBOOK_AD", campaign: "Puja Special", interest: "Saree-style kurti", status: "FOLLOW_UP", createdDaysAgo: 4, followUps: [{ inHours: 30, note: "Call after 5 pm" }] },
    { owner: se, name: "Mim Chowdhury", source: "MESSENGER", interest: "Asked about delivery to Sylhet", status: "NEW", createdDaysAgo: 0 },
    { owner: se, name: "Jannatul Ferdous", phone: "01755123407", source: "REFERRAL", interest: "Wedding guest outfit", status: "NEW", createdDaysAgo: 0 },
    { owner: se, name: "Shirin Sultana", phone: "01755123408", source: "FACEBOOK_AD", campaign: "Eid Collection", interest: "Kurti, XL", status: "LOST", lost: ["SIZE_UNAVAILABLE"], createdDaysAgo: 9, done: [{ daysAgo: 8, outcome: "XL out of stock in that colour" }] },
    { owner: se, name: "Lamia Hossain", source: "INSTAGRAM", status: "LOST", lost: ["NO_RESPONSE"], createdDaysAgo: 12 },
    { owner: se, name: "Ayesha Siddika", phone: "01755123410", source: "WHATSAPP", campaign: "Puja Special", status: "LOST", lost: ["PRICE"], createdDaysAgo: 6 },
    { owner: se, name: "Kaniz Fatema", phone: "01755123411", source: "SHOWROOM_WALK_IN", status: "LOST", lost: ["OTHER", "Wanted home trial — we don't offer it"], createdDaysAgo: 15 },
    { owner: tl, name: "Mahbuba Khatun", phone: "01755123420", source: "FACEBOOK_AD", campaign: "Eid Collection", interest: "Two kurtis for her daughters", status: "NEGOTIATING", createdDaysAgo: 2, followUps: [{ inHours: -5, note: "Confirm both sizes" }] },
    { owner: tl, name: "Sabina Yasmin", source: "MESSENGER", status: "CONTACTED", createdDaysAgo: 1, followUps: [{ inHours: 26 }] },
    { owner: tl, name: "Nasrin Begum", phone: "01755123422", source: "REPEAT_CUSTOMER", status: "LOST", lost: ["BOUGHT_ELSEWHERE"], createdDaysAgo: 7 },
    { owner: manager, name: "Corporate order — Dhaka office", phone: "01755123430", source: "OTHER", interest: "30 matching kurtis for an event", status: "NEGOTIATING", createdDaysAgo: 5, followUps: [{ inHours: 48, note: "Send quotation" }] },
  ];

  for (const demo of leads) {
    const createdAt = ago(demo.createdDaysAgo, 2);
    const customer = demo.phone ? await prisma.customer.findUnique({ where: { phone: demo.phone } }) : null;
    const lead = await prisma.lead.create({
      data: {
        name: demo.name,
        phone: demo.phone ?? null,
        customerId: customer?.id ?? null,
        source: demo.source,
        campaign: demo.campaign ?? null,
        interest: demo.interest ?? null,
        status: demo.status,
        lostReason: demo.lost?.[0] ?? null,
        lostNote: demo.lost?.[1] ?? null,
        lostAt: demo.lost ? ago(Math.max(0, demo.createdDaysAgo - 1)) : null,
        createdById: demo.owner.id,
        teamId: demo.owner.teamId,
        createdAt,
      },
    });
    for (const d of demo.done ?? []) {
      await prisma.leadFollowUp.create({ data: { leadId: lead.id, dueAt: ago(d.daysAgo, 1), completedAt: ago(d.daysAgo), completedById: demo.owner.id, outcome: d.outcome, createdById: demo.owner.id, createdAt } });
    }
    for (const f of demo.followUps ?? []) {
      await prisma.leadFollowUp.create({ data: { leadId: lead.id, dueAt: new Date(now + f.inHours * HOUR), note: f.note ?? null, createdById: demo.owner.id, createdAt } });
    }
  }

  // Converted leads: the demo orders an executive/TL already placed, each
  // linked back to the lead it came from (order.leadId).
  const sources = ["FACEBOOK_AD", "MESSENGER", "WHATSAPP", "FACEBOOK_AD", "REPEAT_CUSTOMER"] as const;
  const campaigns = ["Eid Collection", null, null, "Puja Special", null];
  for (const owner of [se, tl]) {
    const orders = await prisma.order.findMany({
      where: { createdById: owner.id, channel: "ONLINE", leadId: null, deletedAt: null, customerId: { not: null } },
      include: { customer: true },
      orderBy: { createdAt: "asc" },
      take: owner.id === se.id ? 5 : 1,
    });
    for (const [i, order] of orders.entries()) {
      const lead = await prisma.lead.create({
        data: {
          name: order.customer!.name,
          phone: order.customer!.phone,
          customerId: order.customerId,
          source: sources[i % sources.length],
          campaign: campaigns[i % campaigns.length],
          status: "CONVERTED",
          convertedAt: order.createdAt,
          createdById: owner.id,
          teamId: owner.teamId,
          createdAt: new Date(order.createdAt.getTime() - DAY),
        },
      });
      await prisma.order.update({ where: { id: order.id }, data: { leadId: lead.id } });
    }
  }

  // Quick-entry counts for three busy days (Dhaka midnight, as UTC).
  const dhakaMidnight = (daysAgo: number) => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(ago(daysAgo));
    return new Date(`${day}T00:00:00+06:00`);
  };
  const counts: { owner: typeof se; daysAgo: number; rows: [DemoLead["source"], string | null, number, number][] }[] = [
    { owner: se, daysAgo: 3, rows: [["MESSENGER", null, 12, 3], ["FACEBOOK_AD", "Eid Collection", 9, 2], ["WHATSAPP", null, 4, 1]] },
    { owner: se, daysAgo: 5, rows: [["MESSENGER", null, 8, 2], ["INSTAGRAM", null, 3, 0]] },
    { owner: tl, daysAgo: 3, rows: [["FACEBOOK_AD", "Eid Collection", 6, 2], ["MESSENGER", null, 5, 1]] },
  ];
  for (const c of counts) {
    await prisma.leadDailyCount.createMany({
      data: c.rows.map(([source, campaign, leadCount, convertedCount]) => ({
        countDate: dhakaMidnight(c.daysAgo),
        userId: c.owner.id,
        teamId: c.owner.teamId,
        source,
        campaign,
        leadCount,
        convertedCount,
        createdById: c.owner.id,
      })),
    });
  }
}

// P4.2 (PRD §4.13 / §4.14) — a month worth judging: Rima and Sumaiya sell
// alongside the demo SE (Sumaiya places the most but a lot comes back, so
// "Delivered value" ranks her lower), targets for this month and last,
// tiered reward rules with a delivered floor, six weeks of check-ins with
// the odd late / half / absent day, and leave in every state.
async function seedTargetsAndAttendanceDemo() {
  if ((await prisma.salesTarget.count()) > 0) return;
  const phones = ["01711000002", "01711000003", "01711000004", "01711000005", "01711000006", "01711000007", "01711000008", "01711000009"];
  const [manager, tl, se, packing, accounts, pos, rima, sumaiya] = await Promise.all(phones.map((phone) => prisma.user.findUniqueOrThrow({ where: { phone } })));
  const DAY = 86_400_000;
  const now = Date.now();
  // Everyone has been here a while, so their earlier days aren't blank on the sheet.
  await prisma.user.updateMany({ where: { phone: { in: phones } }, data: { joinDate: new Date(now - 120 * DAY) } });

  // ── Orders for the two new executives, all inside this Dhaka month ──
  const dayOfMonth = Number(dhakaToday().slice(8, 10));
  const within = (daysAgo: number) => Math.min(daysAgo, dayOfMonth - 1);
  const customers = [
    { name: "Tanjila Haque", phone: "01822000101", owner: rima, district: "Dhaka" },
    { name: "Moushumi Das", phone: "01822000102", owner: rima, district: "Gazipur" },
    { name: "Shamima Nasrin", phone: "01822000103", owner: sumaiya, district: "Chattogram" },
    { name: "Lipi Barua", phone: "01822000104", owner: sumaiya, district: "Sylhet" },
  ];
  for (const c of customers) {
    await prisma.customer.upsert({ where: { phone: c.phone }, update: {}, create: { name: c.name, phone: c.phone, district: c.district, division: c.district === "Gazipur" ? "Dhaka" : c.district, addressDetail: "House 12, Road 4", createdById: c.owner.id, teamId: c.owner.teamId } });
  }
  const variants = (await prisma.productVariant.findMany({
    where: { isActive: true, product: { isActive: true, deletedAt: null } },
    orderBy: { sku: "asc" },
    select: { id: true, stockQty: true, reservedQty: true, priceOverride: true, product: { select: { basePrice: true } } },
  })).filter((v) => v.stockQty - v.reservedQty >= 6 && Number(v.priceOverride ?? v.product.basePrice) > 0);
  if (variants.length < 4) {
    console.warn("Targets demo: not enough stock for the extra executives' orders — skipped them.");
  } else {
    const price = (i: number) => Number(variants[i % variants.length].priceOverride ?? variants[i % variants.length].product.basePrice);
    const plan: [typeof rima, string, number, number, DemoOrderEnd][] = [
      // seller, customer, days ago, qty, where it ended
      [rima, "01822000101", 20, 2, "DELIVERED"],
      [rima, "01822000102", 17, 1, "DELIVERED"],
      [rima, "01822000101", 14, 2, "DELIVERED"],
      [rima, "01822000102", 11, 1, "DELIVERED"],
      [rima, "01822000101", 8, 2, "DELIVERED"],
      [rima, "01822000102", 5, 1, "DELIVERED"],
      [rima, "01822000101", 2, 1, "IN_TRANSIT"],
      [rima, "01822000102", 0, 1, "CONFIRMED"],
      [sumaiya, "01822000103", 21, 3, "DELIVERED"],
      [sumaiya, "01822000104", 19, 2, "RETURNED"],
      [sumaiya, "01822000103", 16, 3, "RETURNED"],
      [sumaiya, "01822000104", 13, 2, "DELIVERED"],
      [sumaiya, "01822000103", 10, 3, "RETURNED"],
      [sumaiya, "01822000104", 7, 3, "DELIVERED"],
      [sumaiya, "01822000103", 4, 2, "RETURNED"],
      [sumaiya, "01822000104", 3, 3, "IN_TRANSIT"],
      [sumaiya, "01822000103", 1, 3, "IN_TRANSIT"],
      [sumaiya, "01822000104", 0, 2, "CONFIRMED"],
    ];
    // Resumable: a run that stopped part-way already placed the first few.
    const placed = await prisma.order.count({ where: { createdById: { in: [rima.id, sumaiya.id] } } });
    for (const [i, [seller, phone, daysAgo, qty, end]] of plan.entries()) {
      if (i < placed) continue;
      await seedDeliveredOrder(phone, variants[i % variants.length].id, qty, price(i), within(daysAgo), { sellerPhone: seller.phone, end });
    }
  }

  // ── Targets: last month and this one (Sumaiya's this month is left for "Copy last month's") ──
  const month = dhakaMonth();
  const lastMonth = shiftMonth(month, -1);
  const byUser = await statsByUser(prisma, month, [se.id, tl.id, rima.id, sumaiya.id]);
  const byTeam = se.teamId ? await statsByTeam(prisma, month, [se.teamId]) : new Map();
  const taka = (paisa = 0) => paisa / 100;
  const roundUp = (v: number) => Math.max(20_000, Math.ceil(v / 5_000) * 5_000);
  const seSales = taka(byUser.get(se.id)?.salesPaisa);
  const rimaSales = taka(byUser.get(rima.id)?.salesPaisa);
  type DemoTarget = { month: string; userId?: string; teamId?: string; orderValue: number; orderCount?: number; note?: string };
  const targets: DemoTarget[] = [
    { month, userId: se.id, orderValue: roundUp(seSales * 1.4), orderCount: Math.max(10, (byUser.get(se.id)?.orderCount ?? 0) + 6), note: "Eid push — stretch target" },
    { month, userId: rima.id, orderValue: Math.max(10_000, Math.floor((rimaSales * 0.95) / 5_000) * 5_000), orderCount: 8 },
    { month, userId: tl.id, orderValue: 40_000 },
    { month: lastMonth, userId: se.id, orderValue: 150_000, orderCount: 30 },
    { month: lastMonth, userId: rima.id, orderValue: 120_000 },
    { month: lastMonth, userId: sumaiya.id, orderValue: 150_000, orderCount: 30 },
    { month: lastMonth, userId: tl.id, orderValue: 60_000 },
  ];
  if (se.teamId) {
    targets.push({ month, teamId: se.teamId, orderValue: roundUp(taka(byTeam.get(se.teamId)?.salesPaisa) * 1.2), orderCount: 40 });
    targets.push({ month: lastMonth, teamId: se.teamId, orderValue: 500_000 });
  }
  for (const t of targets) await prisma.salesTarget.create({ data: { ...t, createdById: manager.id } });

  await prisma.rewardRule.createMany({
    data: [
      { name: "Nearly there", scope: "INDIVIDUAL", metric: "VALUE_TARGET_PERCENT", threshold: 80, minDeliveredRate: 85, rewardAmount: 1_000, createdById: manager.id },
      { name: "Target hit", scope: "INDIVIDUAL", metric: "VALUE_TARGET_PERCENT", threshold: 100, minDeliveredRate: 85, rewardAmount: 3_000, createdById: manager.id },
      { name: "Clean deliveries", scope: "INDIVIDUAL", metric: "DELIVERED_VALUE", threshold: 25_000, minDeliveredRate: 90, rewardNote: "Extra day off, your pick", createdById: manager.id },
      { name: "Team target", scope: "TEAM", metric: "VALUE_TARGET_PERCENT", threshold: 100, rewardAmount: 5_000, rewardNote: "Team dinner", createdById: manager.id },
      { name: "Old flat bonus (replaced)", scope: "INDIVIDUAL", metric: "ORDER_COUNT", threshold: 50, rewardAmount: 500, isActive: false, createdById: manager.id },
    ],
  });

  // ── Leave (decided before attendance, so leave days have no check-in) ──
  const dayAt = (offset: number) => dhakaToday(new Date(now + offset * DAY));
  const workingBack = (fromOffset: number) => {
    let o = fromOffset;
    while (dayKind(dayAt(o), DEFAULT_OFFICE_HOURS) !== "WORKING") o -= 1;
    return o;
  };
  const sick = workingBack(-9);
  const leaves = [
    { user: se, type: "SICK" as const, from: sick - 1, to: sick, reason: "Fever — doctor's note sent on WhatsApp", status: "APPROVED" as const, by: tl },
    { user: se, type: "CASUAL" as const, from: 6, to: 8, reason: "Cousin's wedding in Cumilla", status: "PENDING" as const },
    { user: packing, type: "ANNUAL" as const, from: 12, to: 14, reason: "Family trip to Cox's Bazar", status: "PENDING" as const },
    { user: rima, type: "CASUAL" as const, from: -4, to: -4, reason: "Personal work", status: "REJECTED" as const, by: tl, note: "Eid rush week — please take it after the 10th" },
    { user: sumaiya, type: "CASUAL" as const, from: 0, to: 0, reason: "Child's school admission test", status: "APPROVED" as const, by: tl },
  ];
  const leaveDays = new Map<string, Set<string>>();
  for (const l of leaves) {
    await prisma.leaveRequest.create({
      data: {
        userId: l.user.id,
        type: l.type,
        fromDate: dhakaDayStart(dayAt(l.from)),
        toDate: dhakaDayStart(dayAt(l.to)),
        reason: l.reason,
        status: l.status,
        decidedById: l.by?.id ?? null,
        decidedAt: l.by ? new Date(now + (l.from - 2) * DAY) : null,
        decisionNote: l.note ?? null,
        createdAt: new Date(now + (Math.min(l.from, 0) - 3) * DAY),
      },
    });
    if (l.status === "APPROVED") for (let o = l.from; o <= l.to; o++) leaveDays.set(l.user.id, new Set([...(leaveDays.get(l.user.id) ?? []), dayAt(o)]));
  }

  // ── Six weeks of check-ins for everyone on the roster (not the owner) ──
  const roster = [manager, tl, se, packing, accounts, pos, rima, sumaiya];
  const at = (day: string, minutes: number) => new Date(dhakaDayStart(day).getTime() + minutes * 60_000);
  for (const [ui, person] of roster.entries()) {
    const rows = [];
    for (let offset = -42; offset <= 0; offset++) {
      const day = dayAt(offset);
      if (leaveDays.get(person.id)?.has(day)) continue;
      const kind = dayKind(day, DEFAULT_OFFICE_HOURS);
      const roll = (ui * 7 + (offset + 50) * 13) % 23;
      // Packing covers one Friday a month; everyone else rests.
      if (kind !== "WORKING" && !(person.id === packing.id && offset % 28 === 0)) continue;
      if (roll === 0) continue; // absent
      let inMin = 9 * 60 + 45 + (roll % 5) * 6; // 9:45–10:09
      if (roll === 1 || roll === 2 || roll === 3) inMin = 10 * 60 + 20 + roll * 9; // late
      if (roll === 4) inMin = 12 * 60 + 30; // half day
      let outMin: number | null = 19 * 60 + 40 + (roll % 4) * 10;
      if (offset === -3 && person.id === rima.id) outMin = null; // forgot to check out
      if (offset === 0) {
        // Today: the demo SE hasn't come in yet (try the button); the rest arrived and are still here.
        if (person.id === se.id) continue;
        outMin = null;
        if (at(day, inMin).getTime() > now) continue;
      }
      const checkInAt = at(day, inMin);
      const checkOutAt = outMin === null ? null : at(day, outMin);
      const { status, lateMinutes } = attendanceStatus({ day, checkInAt, checkOutAt }, DEFAULT_OFFICE_HOURS);
      rows.push({ userId: person.id, workDate: dhakaDayStart(day), checkInAt, checkOutAt, status, lateMinutes });
    }
    await prisma.attendance.createMany({ data: rows });
  }
  // One corrected day, so the sheet shows what a manager's fix looks like.
  const fixDay = dayAt(workingBack(-15));
  const fixed = await prisma.attendance.findFirst({ where: { userId: packing.id, workDate: dhakaDayStart(fixDay) } });
  if (fixed) {
    await prisma.attendance.update({
      where: { id: fixed.id },
      data: { checkOutAt: at(fixDay, 20 * 60 + 5), correctedById: manager.id, correctedAt: new Date(now - 14 * DAY), correctionReason: "Stayed late for the courier pickup, phone was off" },
    });
  }
}

// P5.2 go-live: `npm run db:seed:base` (SEED_MODE=base) seeds only what a
// real database needs — permissions and roles, the size/colour/category
// masters, the Steadfast courier, the wallets, default settings and the
// first Admin (from SEED_ADMIN_*) — and no demo people, customers, stock or
// money. Real data then goes in through Settings → Import opening data.
async function seedFirstAdmin(roleIds: Record<RoleName, string>) {
  const admins = await prisma.user.count({ where: { roleId: roleIds.ADMIN, isActive: true } });
  if (admins > 0) {
    console.log("An active Admin already exists — SEED_ADMIN_* not used.");
    return;
  }
  const name = process.env.SEED_ADMIN_NAME?.trim();
  const phone = process.env.SEED_ADMIN_PHONE?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "";
  if (!name || !phone || !/^01[3-9]\d{8}$/.test(phone) || password.length < 8) {
    throw new Error("Set SEED_ADMIN_NAME, SEED_ADMIN_PHONE (01XXXXXXXXX) and SEED_ADMIN_PASSWORD (8+ characters) to create the first Admin.");
  }
  await prisma.user.create({
    data: {
      name,
      phone,
      email: process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() || null,
      passwordHash: await bcrypt.hash(password, 12),
      roleId: roleIds.ADMIN,
      // Changed on first sign-in (PRD §4.1), so the password in the shell history stops working.
      mustChangePassword: true,
    },
  });
  console.log(`First Admin created: ${name} (${phone}). They must change the password at first sign-in.`);
}

async function main() {
  if (process.env.SEED_MODE === "base") {
    const roleIds = await seedPermissionsAndRoles();
    await seedCatalogMasters();
    await seedFirstAdmin(roleIds);
    await seedCouriers(DEMO_COURIERS.filter((c) => c.provider === "STEADFAST"));
    await seedWallets();
    await seedSettings();
    console.log("\nBase seed complete — no demo data. Next: sign in, fill Settings, then Settings → Import opening data.\n");
    return;
  }
  const roleIds = await seedPermissionsAndRoles();
  await seedCatalogMasters();
  await seedCatalogProducts();
  await seedUsers(roleIds);
  await seedCustomers();
  await seedCouriers();
  await seedWallets();
  await seedSettings();
  await seedDemoOrders();
  await seedInventory();
  await seedCourierCosts();
  await seedCourierDemo();
  await seedCourierStatementsDemo();
  await seedFinanceDemo();
  await seedPosDemo();
  await seedReturnsDemo();
  await seedStoreCreditDemo();
  await seedSetsAndPackagingDemo();
  await seedNegativeStockDemo();
  await seedLeadsDemo();
  await seedTargetsAndAttendanceDemo();
  await seedTransfersAndCountsDemo();

  console.log("\nSeed complete.\n");
  console.log("Seeded logins (all use the same password until first change):\n");
  console.log(`  Password: ${DEMO_PASSWORD}\n`);
  for (const user of DEMO_USERS) {
    console.log(
      `  ${ROLE_LABELS[user.role].padEnd(24)} phone: ${user.phone}   email: ${user.email}`,
    );
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
