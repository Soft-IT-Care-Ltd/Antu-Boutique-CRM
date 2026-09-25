import { Skeleton } from "@/components/ui/skeleton";

export default function ReportLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-full max-w-lg" />
      <Skeleton className="h-24 w-full" />
      <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
