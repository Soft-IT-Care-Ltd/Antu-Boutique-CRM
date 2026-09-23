import { todayInDhaka } from "@/lib/inventory/constants";

/** First day of the current Dhaka month, YYYY-MM-DD (client- and server-safe). */
export function monthStartInDhaka(): string {
  return `${todayInDhaka().slice(0, 7)}-01`;
}
