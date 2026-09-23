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
  zones: Array<{ zone: "INSIDE_CITY" | "SUB_CITY" | "OUTSIDE_CITY"; charge: number; codChargePercent: number; returnCharge: number }>;
};

const DEMO_COURIERS: DemoCourier[] = [
  {
    name: "Steadfast Courier",
    contact: "16374",
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
      update: { contact: courier.contact },
      create: { name: courier.name, contact: courier.contact },
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
        wallet: "bKash Personal",
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
}

async function main() {
  const roleIds = await seedPermissionsAndRoles();
  await seedCatalogMasters();
  await seedCatalogProducts();
  await seedUsers(roleIds);
  await seedCustomers();
  await seedCouriers();
  await seedSettings();
  await seedDemoOrders();
  await seedInventory();

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
