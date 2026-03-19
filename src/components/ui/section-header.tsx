interface SectionHeaderProps {
  title: string;
  children?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ title, children, className }: SectionHeaderProps) {
  return (
    <div className={`flex items-center justify-between mb-3 ${className ?? ""}`}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}
