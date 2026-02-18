import React from "react";
import Link from "next/link";

const PAGE_SIZE_OPTIONS = [10, 20, 50];

function PaginationBtn({ href, children }: { href: string | null; children: React.ReactNode }) {
  const cls = "inline-flex items-center justify-center h-7 w-7 rounded border border-border text-xs font-medium transition-colors";
  if (!href) return <span className={`${cls} text-muted-foreground opacity-40 cursor-not-allowed`}>{children}</span>;
  return <Link href={href} className={`${cls} hover:bg-muted`}>{children}</Link>;
}

export function PaginationBar({
  page,
  pageSize,
  total,
  buildHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number, pageSize: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/20 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>Rows per page:</span>
        {PAGE_SIZE_OPTIONS.map((ps) => (
          <Link
            key={ps}
            href={buildHref(1, ps)}
            className={`px-2 py-0.5 rounded text-xs ${pageSize === ps ? "bg-primary text-primary-foreground font-medium" : "hover:bg-muted"}`}
          >
            {ps}
          </Link>
        ))}
        <span className="ml-2">{total} total</span>
      </div>

      <div className="flex items-center gap-1">
        <PaginationBtn href={page > 1 ? buildHref(1, pageSize) : null}>«</PaginationBtn>
        <PaginationBtn href={page > 1 ? buildHref(page - 1, pageSize) : null}>‹</PaginationBtn>
        <span className="px-3 text-xs text-muted-foreground">Page {page} of {totalPages}</span>
        <PaginationBtn href={page < totalPages ? buildHref(page + 1, pageSize) : null}>›</PaginationBtn>
        <PaginationBtn href={page < totalPages ? buildHref(totalPages, pageSize) : null}>»</PaginationBtn>
      </div>
    </div>
  );
}

export function parsePaginationParams(
  pageParam: string | undefined,
  pageSizeParam: string | undefined,
  defaultPageSize = 20,
) {
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(pageSizeParam)) ? Number(pageSizeParam) : defaultPageSize;
  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}
