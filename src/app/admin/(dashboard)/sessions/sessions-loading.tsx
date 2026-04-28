import { AdminTable, AdminTableHead, AdminTableRow, Th } from "@/components/ui/admin-table";
import { Skeleton } from "@/components/ui/skeleton";

export function SessionsLoadingSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-8 w-40" />
      </div>
      <AdminTable>
        <AdminTableHead>
          <Th>Session</Th>
          <Th>Agent</Th>
          <Th>Status</Th>
          <Th>Latest Trigger</Th>
          <Th align="right">Messages</Th>
          <Th align="right">Cost</Th>
          <Th>Latest Activity</Th>
          <Th>Created</Th>
        </AdminTableHead>
        <tbody>
          {Array.from({ length: 4 }).map((_, i) => (
            <AdminTableRow key={i}>
              <td className="p-3"><Skeleton className="h-4 w-24" /></td>
              <td className="p-3"><Skeleton className="h-4 w-32" /></td>
              <td className="p-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
              <td className="p-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
              <td className="p-3 text-right"><Skeleton className="h-4 w-8 ml-auto" /></td>
              <td className="p-3 text-right"><Skeleton className="h-4 w-14 ml-auto" /></td>
              <td className="p-3"><Skeleton className="h-4 w-24" /></td>
              <td className="p-3"><Skeleton className="h-4 w-24" /></td>
            </AdminTableRow>
          ))}
        </tbody>
      </AdminTable>
    </div>
  );
}

export default function Loading() {
  return <SessionsLoadingSkeleton />;
}
