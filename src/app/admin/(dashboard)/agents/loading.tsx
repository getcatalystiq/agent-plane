import { Skeleton } from "@/components/ui/skeleton";

export default function AgentsLoading() {
  return (
    <div>
      <Skeleton className="h-8 w-20 mb-6" />
      <div className="rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {["Name", "Description", "Tenant", "Model", "Toolkits", "Runs", "Last Run", "Created"].map((h) => (
                <th key={h} className="text-left p-3 font-medium text-muted-foreground">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="border-b border-border">
                <td className="p-3"><Skeleton className="h-4 w-24" /></td>
                <td className="p-3"><Skeleton className="h-4 w-40" /></td>
                <td className="p-3"><Skeleton className="h-4 w-20" /></td>
                <td className="p-3"><Skeleton className="h-4 w-32" /></td>
                <td className="p-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                <td className="p-3"><Skeleton className="h-4 w-8" /></td>
                <td className="p-3"><Skeleton className="h-4 w-24" /></td>
                <td className="p-3"><Skeleton className="h-4 w-20" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
