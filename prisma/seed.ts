import { PrismaClient, type RoleName } from "@prisma/client";
import bcrypt from "bcryptjs";

import { PERMISSIONS, ROLE_TEMPLATES } from "../lib/auth/permission-definitions";
// Imported, not duplicated: these take a transaction client and are free of
// "server-only", so demo stock moves through the exact code the app uses —
// the DB's stock/ledger consistency trigger would reject anything else.
import { adjustStock, writeOffDamagedStock } from "../lib/inventory/adjustments";
import { recordStockMovement } from "../lib/inventory/ledger";
import { createPurchase } from "../lib/inventory/purchases";

// Mirrors lib/settings/get.ts's ORDER_EDIT_WINDOW_SETTING_KEY — duplicated
// for the same "server-only" reason as buildVariantSku/nextOrderNo above.
const ORDER_EDIT_WINDOW_SETTING_KEY = "order_edit_window_minutes";
const DEFAULT_ORDER_EDIT_WINDOW_MINUTES = 30;

// Mirrors lib/settings/get.ts's PACKING_SLA_HOURS_SETTING_KEY — same reason.
const PACKING_SLA_HOURS_SETTING_KEY = "packing_sla_hours";
const DEFAULT_PACKING_SLA_HOURS = 24;

// Mirrors lib/catalog/sku.ts's buildVariantSku — duplicated instead of
// imported because that module is marked "server-only" (throws outside a
// Next.js RSC context) and this script runs standalone under tsx.
function buildVariantSku(productCode: string, sizeName: string, colorName: string): string {
  const slug = (input: string) => input.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return `PRD-${slug(productCode)}-${slug(sizeName)}-${slug(colorName)}`;
}

// Mirrors lib/orders/order-number.ts's generateOrderNumber — duplicated for
// the same "server-only" reason as buildVariantSku above. Demo orders MUST
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

const SIZES = ["Free", "S", "M", "L", "XL", "XXL"];

const COLORS: Array<{ name: string; hexCode: string }> = [
  { name: "Black", hexCode: "#000000" },
  { name: "White", hexCode: "#FFFFFF" },
  { name: "Maroon", hexCode: "#800000" },
  { name: "Navy Blue", hexCode: "#000080" },
  { name: "Red", hexCode: "#D7263D" },
  { name: "Mustard Yellow", hexCode: "#E1AD01" },
  { name: "Pink", hexCode: "#F4A6C6" },
  { name: "Emerald Green", hexCode: "#046A38" },
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
];

async function seedPermissionsAndRoles() {
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
    await prisma.rolePermission.deleteMany({ where: { roleId } });
    const keys = ROLE_TEMPLATES[roleName];
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
  for (const [index, name] of SIZES.entries()) {
    await prisma.size.upsert({
      where: { name },
      update: { sortOrder: index },
      create: { name, sortOrder: index },
    });
  }

  for (const [index, color] of COLORS.entries()) {
    await prisma.color.upsert({
      where: { name: color.name },
      update: { hexCode: color.hexCode, sortOrder: index },
      create: { name: color.name, hexCode: color.hexCode, sortOrder: index },
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
    code: "SAREE01",
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
    code: "KURTI12",
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
    code: "3PC05",
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
    code: "WEST02",
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
            sku: buildVariantSku(demo.code, size.name, color.name),
            weightedAvgCost: variant.cost,
            lowStockThreshold: variant.threshold ?? null,
            priceOverride: variant.priceOverride ?? null,
          },
        });
        if (variant.stock !== 0) {
          await recordStockMovement(tx, {
            variantId: created.id,
            type: "ADJUSTMENT",
            qty: variant.stock,
            unitCost: variant.cost,
            referenceType: "OPENING_BALANCE",
            actorId: null,
            note: "Opening balance (seed)",
          });
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

async function seedCouriers() {
  for (const courier of DEMO_COURIERS) {
    const row = await prisma.courierCompany.upsert({
      where: { name: courier.name },
      update: { contact: courier.contact, provider: courier.provider ?? null },
      create: { name: courier.name, contact: courier.contact, provider: courier.provider ?? null },
    });
    for (const zone of courier.zones) {
      await prisma.courierZone.upsert({
        where: { courierId_zone: { courierId: row.id, zone: zone.zone } },
        update: { charge: zone.charge, codChargePercent: zone.codChargePercent, returnCharge: zone.returnCharge },
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
    where: { product: { code: "KURTI12" }, size: { name: "M" }, color: { name: "Maroon" } },
  });
  const sareeVariant = await prisma.productVariant.findFirstOrThrow({
    where: { product: { code: "SAREE01" }, size: { name: "Free" }, color: { name: "Navy Blue" } },
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
    variantFor("SAREE01", "Free", "Maroon"),
    variantFor("SAREE01", "Free", "Black"),
    variantFor("KURTI12", "M", "Maroon"),
    variantFor("KURTI12", "L", "Maroon"),
    variantFor("KURTI12", "L", "Mustard Yellow"),
    variantFor("3PC05", "L", "Pink"),
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
            { variantId: sareeMaroon.id, qty: 4, unitCost: 2300 },
            { variantId: sareeBlack.id, qty: 2, unitCost: 2300 },
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
            { variantId: kurtiMM.id, qty: 6, unitCost: 720 },
            { variantId: kurtiLM.id, qty: 4, unitCost: 720 },
            { variantId: kurtiLMustard.id, qty: 5, unitCost: 760 },
            { variantId: threePcPink.id, qty: 3, unitCost: 1650 },
          ],
        },
        manager.id,
      );

      await adjustStock(tx, { variantId: kurtiMM.id, qty: -1, reason: "Monthly stock count — one short against the ledger" }, admin.id);
      await writeOffDamagedStock(tx, { variantId: sareeMaroon.id, qty: 1, reason: "Dye bleed along the border, not sellable" }, manager.id);
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

// Parcel weight per unit in grams. WEST02 is deliberately left blank so the
// send dialog's "some items have no weight" warning has something to show.
const VARIANT_WEIGHTS_GRAMS: Record<string, number> = { SAREE01: 650, KURTI12: 250, "3PC05": 480 };

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
    lines: [{ code: "KURTI12", size: "M", color: "Mustard Yellow", qty: 1, unitPrice: 1450 }],
    zone: "INSIDE_CITY",
    deliveryNote: "Call before coming — office hours only, 10am–6pm.",
    internalNote: "Customer is a repeat buyer; gave 50 tk discount last time.",
    hoursAgo: 5,
  },
  {
    stage: "PACKED",
    customerPhone: "01511998877",
    lines: [
      { code: "3PC05", size: "M", color: "Emerald Green", qty: 1, unitPrice: 2950 },
      { code: "WEST02", size: "S", color: "White", qty: 1, unitPrice: 990 },
    ],
    zone: "OUTSIDE_CITY",
    advance: 500,
    hoursAgo: 3,
  },
  {
    stage: "HANDED_TO_COURIER",
    customerPhone: "01711998800",
    lines: [{ code: "SAREE01", size: "Free", color: "Navy Blue", qty: 1, unitPrice: 4200 }],
    zone: "OUTSIDE_CITY",
    advance: 1000,
    hoursAgo: 20,
  },
  {
    stage: "IN_TRANSIT",
    customerPhone: "01911223344",
    lines: [{ code: "KURTI12", size: "L", color: "Maroon", qty: 1, unitPrice: 1450 }],
    zone: "INSIDE_CITY",
    deliveryNote: "Leave with the guard if not home.",
    hoursAgo: 30,
  },
  {
    stage: "APPROVAL_PENDING",
    customerPhone: "01611556677",
    lines: [{ code: "3PC05", size: "L", color: "Pink", qty: 1, unitPrice: 2750 }],
    zone: "OUTSIDE_CITY",
    hoursAgo: 52,
  },
  {
    stage: "DELIVERED",
    customerPhone: "01812345678",
    lines: [{ code: "SAREE01", size: "Free", color: "Navy Blue", qty: 1, unitPrice: 4200 }],
    zone: "INSIDE_CITY",
    advance: 1200,
    hoursAgo: 75,
  },
  {
    stage: "RETURNED",
    customerPhone: "01511998877",
    lines: [{ code: "KURTI12", size: "M", color: "Mustard Yellow", qty: 2, unitPrice: 1450 }],
    zone: "OUTSIDE_CITY",
    hoursAgo: 96,
  },
  {
    stage: "PARTIAL_DELIVERED",
    customerPhone: "01911223344",
    lines: [
      { code: "KURTI12", size: "L", color: "Maroon", qty: 1, unitPrice: 1450 },
      { code: "3PC05", size: "M", color: "Emerald Green", qty: 1, unitPrice: 2950 },
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
}

async function main() {
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
