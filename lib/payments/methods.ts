import "server-only";

import type { Db } from "@/lib/db/tx";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_VALUES, type PaymentMethodValue } from "@/lib/orders/constants";
import { parseEnabledPaymentMethods, PAYMENT_METHODS_SETTING_KEY, type SelectableMethod } from "@/lib/payments/method-settings";
import { WalletError } from "@/lib/wallets/service";

export async function getEnabledPaymentMethods(db: Db): Promise<SelectableMethod[]> {
  const row = await db.setting.findUnique({ where: { key: PAYMENT_METHODS_SETTING_KEY } });
  return parseEnabledPaymentMethods(row?.value ?? null);
}

/**
 * Refuses NEW money by a method switched off in Settings. Payments already
 * recorded keep their method (an edit that leaves the method alone is not
 * checked), and refunds go back the way the money came, so neither calls this.
 * A WalletError, so every payment route already turns it into a 400.
 */
export async function assertPaymentMethodEnabled(db: Db, method: PaymentMethodValue): Promise<void> {
  if (!(PAYMENT_METHOD_VALUES as readonly string[]).includes(method)) return;
  const enabled = await getEnabledPaymentMethods(db);
  if (!enabled.includes(method as SelectableMethod)) {
    throw new WalletError(`${PAYMENT_METHOD_LABELS[method]} is switched off in Settings → Payment methods.`);
  }
}
