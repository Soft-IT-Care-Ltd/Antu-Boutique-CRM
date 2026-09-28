import { Badge } from "@/components/ui/badge";
import { TRANSFER_STATUS_LABELS, type TransferStatusValue } from "@/lib/transfers/constants";
import { TRANSFER_STATUS_TONE } from "@/lib/ui/status-tone";

export function TransferStatusBadge({ status }: { status: TransferStatusValue }) {
  return <Badge variant={TRANSFER_STATUS_TONE[status]}>{TRANSFER_STATUS_LABELS[status]}</Badge>;
}
