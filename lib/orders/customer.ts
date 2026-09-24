// P3.1 — only a walk-in (POS) sale may be anonymous. The DB CHECK
// orders_customer_required_online_chk guarantees every ONLINE order has its
// one person, and courier, packing and COD code only ever handle ONLINE
// orders — so they read the customer through here instead of inventing a
// fallback for a case that can't happen. Client-safe (no server-only).

export const WALK_IN_CUSTOMER_LABEL = "Walk-in customer";

export function onlineOrderCustomer<C>(order: { orderNo: string; customer: C | null }): C {
  if (!order.customer) throw new Error(`Order ${order.orderNo} has no customer — only a walk-in sale may be anonymous`);
  return order.customer;
}
