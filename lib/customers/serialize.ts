import "server-only";

import type { Customer } from "@prisma/client";

import type { CustomerTagValue } from "@/lib/customers/constants";
import type { CustomerListItem } from "@/lib/customers/types";

export function serializeCustomerListItem(customer: Customer): CustomerListItem {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    altPhone: customer.altPhone,
    division: customer.division,
    district: customer.district,
    thana: customer.thana,
    tags: customer.tags as CustomerTagValue[],
    createdAt: customer.createdAt.toISOString(),
  };
}
