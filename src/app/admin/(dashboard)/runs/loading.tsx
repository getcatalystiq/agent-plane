import { Skeleton } from "@/components/ui/skeleton";

export default function RunsLoading() {
  return (
    <div>
      <Skeleton className="h-8 w-16 mb-6" />
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {["Run", "Agent", "Tenant", "Status", "Prompt", "Cost", "Turns", "Duration", "Created"].map((h) => (
                <th key={h} className="text-left p-3 font-medium text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }).map((_, i) => (
              <tr key={i} className="border-b border-border">
                <td className="p-3"><Skeleton className="h-4 w-20" /></td>
                <td className="p-3"><Skeleton className="h-4 w-20" /></td>
                <td className="p-3"><Skeleton className="h-4 w-20" /></td>
                <td className="p-3"><Skeleton className="h-5 w-18 rounded-full" /></td>
                <td className="p-3"><Skeleton className="h-4 w-48" /></td>
                <td className="p-3"><Skeleton className="h-4 w-14" /></td>
                <td className="p-3"><Skeleton className="h-4 w-8" /></td>
                <td className="p-3"><Skeleton className="h-4 w-12" /></td>
                <td className="p-3"><Skeleton className="h-4 w-24" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between p-3 border-t border-border">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-48" />
        </div>
      </div>
    </div>
  );
}
