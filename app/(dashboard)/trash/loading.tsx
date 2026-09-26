import { Skeleton } from "@/components/ui/skeleton";

export default function TrashLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-4xl md:p-6">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-4 w-full max-w-md" />
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24" />
        ))}
      </div>
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
