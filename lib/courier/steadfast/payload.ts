import type { CreateOrderPayload } from "@/lib/courier/steadfast/client";
import { normalizeSteadfastPhone } from "@/lib/courier/steadfast/status";
import { toNumber } from "@/lib/money";

// Order → Steadfast create_order payload (STEADFAST_INTEGRATION.md §2),
// adapted for Antu: ONE person per order — the customer is the recipient.
// Pure (type-only import of the client), so every mapping rule is unit-tested.
//
//   recipient_name     customer.name (≤ 100)
//   recipient_phone    customer.phone → 01XXXXXXXXX, else the send is blocked
//   alternative_phone  customer.altPhone, only if it is itself a valid BD number
//   recipient_address  address detail, thana, district (≤ 250)
//   cod_amount         what is still due (never negative)
//   note               order.deliveryNote ONLY — the rider reads it. The
//                      order's internalNote is staff-only and never sent.
//   item_description   "Product (Size / Colour) ×qty, …" — size and colour
//                      always survive truncation (the product name is cut first)

type MoneyLike = number | string | { toString(): string };

export type SteadfastSendableOrder = {
  orderNo: string;
  dueAmount: MoneyLike;
  deliveryNote: string | null;
  customer: {
    name: string;
    phone: string;
    altPhone: string | null;
    addressDetail: string | null;
    thana: string | null;
    district: string | null;
  };
  items: { qty: number; productName: string; sizeName: string; colorName: string }[];
};

export type BuildPayloadResult = { ok: true; payload: CreateOrderPayload } | { ok: false; error: string };

const MAX_NAME = 100;
const MAX_ADDRESS = 250;
const MAX_NOTE = 200;
const MAX_ITEMS_TEXT = 250;
const MAX_PRODUCT_NAME = 40;

export function describeItems(items: SteadfastSendableOrder["items"]): string {
  return items
    .filter((i) => i.qty > 0)
    .map((i) => {
      const name = i.productName.length > MAX_PRODUCT_NAME ? `${i.productName.slice(0, MAX_PRODUCT_NAME - 1)}…` : i.productName;
      return `${name} (${i.sizeName} / ${i.colorName}) ×${i.qty}`;
    })
    .join(", ")
    .slice(0, MAX_ITEMS_TEXT);
}

export function buildSteadfastPayload(order: SteadfastSendableOrder): BuildPayloadResult {
  const phone = normalizeSteadfastPhone(order.customer.phone);
  if (!phone) {
    return { ok: false, error: `Invalid phone "${order.customer.phone}" — Steadfast needs an 11-digit BD mobile number (01XXXXXXXXX)` };
  }

  const name = order.customer.name.trim();
  if (!name) return { ok: false, error: "Customer name is missing" };

  const address = [order.customer.addressDetail, order.customer.thana, order.customer.district]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ")
    .slice(0, MAX_ADDRESS);
  if (!address) return { ok: false, error: "Delivery address is missing" };

  const itemDescription = describeItems(order.items);
  if (!itemDescription) return { ok: false, error: "Order has no items to ship" };

  const payload: CreateOrderPayload = {
    invoice: order.orderNo,
    recipient_name: name.slice(0, MAX_NAME),
    recipient_phone: phone,
    recipient_address: address,
    cod_amount: Math.max(0, Math.round(toNumber(order.dueAmount) * 100) / 100),
    item_description: itemDescription,
    delivery_type: 0,
    total_lot: 1,
  };

  const altPhone = normalizeSteadfastPhone(order.customer.altPhone);
  if (altPhone && altPhone !== phone) payload.alternative_phone = altPhone;

  const note = order.deliveryNote?.trim();
  if (note) payload.note = note.slice(0, MAX_NOTE);

  return { ok: true, payload };
}
