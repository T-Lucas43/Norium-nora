import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import "./workspace.css";

export default function WorkspaceHeader({ title, description, icon: Icon, children }: {
  title: string;
  description: string;
  icon: LucideIcon;
  children?: ReactNode;
}) {
  return <header className="workspace-header">
    <div className="workspace-heading">
      <span className="workspace-icon">
        <Icon size={23} strokeWidth={1.7} />
      </span>
      <div><h1>{title}</h1><p>{description}</p></div>
    </div>
    {children && <div className="workspace-actions">{children}</div>}
  </header>;
}
