import { preloadPanel } from "../navigation/panelModules";

type PanelTabsProps = {
  label: string;
  tabs: string[];
  activeTab: string;
  allowedTabs?: string[];
  onNavigate: (tab: string) => void;
};

/** Abas internas de telas agrupadas; cada aba mantém a própria rota e permissão. */
export default function PanelTabs({ label, tabs, activeTab, allowedTabs, onNavigate }: PanelTabsProps) {
  const visible = tabs.filter((tab) => !allowedTabs || allowedTabs.includes(tab));
  if (visible.length < 2) return null;
  return (
    <nav className="norium-panel-tabs" aria-label={label}>
      {visible.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`norium-panel-tab ${tab === activeTab ? "is-active" : ""}`}
          aria-current={tab === activeTab ? "page" : undefined}
          onClick={() => onNavigate(tab)}
          onPointerEnter={() => preloadPanel(tab)}
        >
          {tab}
        </button>
      ))}
    </nav>
  );
}
