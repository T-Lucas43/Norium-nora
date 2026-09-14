import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { getModuleIconAsset } from "./moduleIconAssets";
import "./workspace.css";

export default function WorkspaceHeader({ title, description, icon: Icon, children }: {
  title: string;
  description: string;
  icon: LucideIcon;
  children?: ReactNode;
}) {
  const iconAsset = getModuleIconAsset(title);

  return <header className="workspace-header">
    <div className="workspace-heading">
      <span className="workspace-icon">
        {iconAsset
          ? <img src={iconAsset} className="workspace-icon-image norium-suite-icon" alt="" />
          : <Icon size={23} strokeWidth={1.7} />}
      </span>
      <div><h1>{title}</h1><p>{description}</p></div>
    </div>
    {children && <div className="workspace-actions">{children}</div>}
  </header>;
}
