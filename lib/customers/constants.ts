export const CUSTOMER_TAG_VALUES = ["VIP", "WHOLESALE", "PROBLEM_CUSTOMER"] as const;

export type CustomerTagValue = (typeof CUSTOMER_TAG_VALUES)[number];

export const CUSTOMER_TAG_LABELS: Record<CustomerTagValue, string> = {
  VIP: "VIP",
  WHOLESALE: "Wholesale",
  PROBLEM_CUSTOMER: "Problem customer",
};

// PRD §4.4: "risk flag (e.g. 3+ refused COD deliveries)".
export const RISK_FLAG_REFUSED_COD_THRESHOLD = 3;

// PRD §4.4: division / district / thana / detail. Division is a small,
// genuinely fixed list (8 divisions) so it gets a dropdown for data quality;
// district/thana are free text — Bangladesh has 64 districts and 500+
// upazilas, and the PRD doesn't ask for those as Settings master lists the
// way it does for Size/Colour.
export const BD_DIVISIONS = [
  "Barishal",
  "Chattogram",
  "Dhaka",
  "Khulna",
  "Mymensingh",
  "Rajshahi",
  "Rangpur",
  "Sylhet",
] as const;
