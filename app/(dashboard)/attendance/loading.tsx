import { Skeleton } from "@/components/ui/skeleton";

export default function AttendanceLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-8 w-full max-w-sm" />
      <Skeleton className="h-36 w-full" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
