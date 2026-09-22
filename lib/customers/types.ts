import type { CustomerTagValue } from "@/lib/customers/constants";

export type CustomerListItem = {
  id: string;
  name: string;
  phone: string;
  altPhone: string | null;
  division: string | null;
  district: string | null;
  thana: string | null;
  tags: CustomerTagValue[];
  createdAt: string;
};

export type CustomerStats = {
  lifetimeOrders: number;
  lifetimeValue: string;
  returnsExchangesCount: number;
  averageOrderValue: string;
  lastOrderDate: string | null;
  refusedCodCount: number;
  riskFlag: boolean;
};

export type CustomerDetail = CustomerListItem & {
  addressDetail: string | null;
  notes: string | null;
  createdBy: { id: string; name: string } | null;
  updatedAt: string;
  stats: CustomerStats;
};
