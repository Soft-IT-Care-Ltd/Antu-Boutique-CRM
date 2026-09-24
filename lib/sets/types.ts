// P3.3 — outfit set view types. Client-safe. `cost` fields are stripped at
// the API for roles without product.cost.view (lib/auth/strip-cost-fields.ts).

export type SetComponentVariant = {
  id: string;
  sku: string;
  sizeName: string;
  colorName: string;
  colorHex: string;
  /** stock − reserved */
  available: number;
  price: string;
  weightedAvgCost?: string;
};

export type SetComponentView = {
  id: string;
  productId: string;
  productName: string;
  productCode: string;
  qty: number;
  /** The product's list price, per unit — weights the set price split. */
  listPrice: string;
  thumbPath: string | null;
  variants: SetComponentVariant[];
  /** Most sets this component allows on its best-stocked size/colour. */
  bestSets: number;
};

export type PackagingLine = {
  materialVariantId: string;
  label: string;
  sku: string;
  qty: number;
  available: number;
};

export type SetDetail = {
  id: string;
  name: string;
  description: string | null;
  price: string;
  isActive: boolean;
  components: SetComponentView[];
  packaging: PackagingLine[];
  /** Sets that can be sold on the best combination. */
  availableSets: number;
  /** The component holding availability down (null when there are no components). */
  limitingProduct: string | null;
  /** Cost of one set at average cost across each component's sizes/colours. Stripped for non-cost roles. */
  cost?: string;
};

export type SetListItem = {
  id: string;
  name: string;
  price: string;
  isActive: boolean;
  components: { productName: string; qty: number }[];
  availableSets: number;
  limitingProduct: string | null;
};

/** What the order form and the POS send for a set: the set, how many, and the chosen size/colour of each component product. */
export type SetLineInput = {
  setId: string;
  qty: number;
  unitPrice: number;
  lineDiscount: number;
  choices: { productId: string; variantId: string }[];
  stockOverrideReason?: string | null;
};

/** A set line on an order, as the order screens show it. */
export type OrderSetLineView = {
  id: string;
  setId: string;
  name: string;
  qty: number;
  unitPrice: string;
  lineDiscount: string;
  /** The set's components on this order, by order item. */
  itemIds: string[];
};
