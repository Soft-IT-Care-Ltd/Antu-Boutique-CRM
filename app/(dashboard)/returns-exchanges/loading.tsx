import { Skeleton } from "@/components/ui/skeleton";

export default function ReturnsExchangesLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-5xl md:p-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-9 w-full max-w-xl" />
      <Skeleton className="h-9 w-full max-w-sm" />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-32 w-full" />
      ))}
    </div>
  );
}
