import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-6xl md:p-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-full max-w-md" />
      <div className="flex flex-col gap-4 md:flex-row">
        <Skeleton className="h-10 w-full md:h-96 md:w-52" />
        <div className="flex flex-1 flex-col gap-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}
