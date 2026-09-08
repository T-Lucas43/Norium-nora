import { BarChart3, Wallet, Activity, ChevronRight } from "lucide-react";
import { reportGroups, type ReportId } from "../../features/reports/reportDocument";
export default function ReportsSidebar({ activeReport, onSelect }: { activeReport: ReportId; onSelect: (id: ReportId) => void }) {
  return <nav className="reports-sidebar" aria-label="Categorias de relatórios">{reportGroups.map((group, index) => { const Icon = [BarChart3, Wallet, Activity][index]; return <section key={group.label}><h2><Icon size={14}/>{group.label}<span>{group.items.length}</span></h2><div>{group.items.map(item => <button key={item.id} type="button" aria-current={activeReport === item.id ? "page" : undefined} onClick={() => onSelect(item.id)}><span>{item.label}</span>{activeReport === item.id && <ChevronRight size={13}/>}</button>)}</div></section>; })}</nav>;
}
