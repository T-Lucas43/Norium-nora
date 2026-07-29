import { Mail, Star, AlertCircle, Send, File, Trash2, AlertOctagon, Folder, Plus } from "lucide-react";

interface EmailSidebarProps {
  activeFolder: string;
  setActiveFolder: (folder: string) => void;
}

export default function EmailSidebar({ activeFolder, setActiveFolder }: EmailSidebarProps) {
  return (
    <aside className="w-64 bg-[var(--background)] border-r border-[var(--border)] p-4 flex flex-col justify-between shrink-0 h-full overflow-y-auto">
      <div>
        {/* Botão Novo E-mail */}
        <button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 transition mb-6 shadow-sm">
          <Plus size={18} />
          <span>Novo e-mail</span>
        </button>

        {/* Categorias Principais */}
        <nav className="space-y-1 mb-6">
          {[
            { label: "Caixa de entrada", icon: Mail, count: 12 },
            { label: "Com estrela", icon: Star },
            { label: "Importante", icon: AlertCircle },
            { label: "Enviados", icon: Send },
            { label: "Rascunhos", icon: File, count: 3 },
            { label: "Lixeira", icon: Trash2 },
            { label: "Spam", icon: AlertOctagon },
          ].map((item) => (
            <button
              key={item.label}
              onClick={() => setActiveFolder(item.label)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm font-medium transition ${
                activeFolder === item.label
                  ? "bg-blue-500/10 text-blue-500"
                  : "text-[var(--secondary-foreground)] hover:bg-[var(--hover-background)]"
              }`}
            >
              <div className="flex items-center gap-3">
                <item.icon size={18} className={activeFolder === item.label ? "text-blue-500" : "text-[var(--secondary-foreground)]"} />
                <span>{item.label}</span>
              </div>
              {item.count && (
                <span className={`text-xs px-2 py-0.5 rounded-md font-bold ${activeFolder === item.label ? "bg-blue-500 text-white" : "bg-[var(--card-background)] text-[var(--secondary-foreground)]"}`}>
                  {item.count}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* Seção Pastas */}
        <div>
          <div className="flex items-center justify-between px-3 mb-2">
            <span className="text-xs font-bold text-[var(--secondary-foreground)] uppercase tracking-wider">Pastas</span>
          </div>
          <div className="space-y-1">
            {["Financeiro", "Clientes", "Projetos", "Marketing", "Pessoal"].map((folder) => (
              <button key={folder} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-[var(--secondary-foreground)] hover:bg-[var(--hover-background)] transition">
                <Folder size={18} className="text-[var(--secondary-foreground)]" />
                <span>{folder}</span>
              </button>
            ))}
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-blue-500 hover:bg-blue-500/10 transition mt-1">
              <Plus size={18} />
              <span>Nova pasta</span>
            </button>
          </div>
        </div>
      </div>

      {/* Indicador de Armazenamento */}
      <div className="bg-[var(--card-background)] p-3 rounded-xl border border-[var(--border)]">
        <div className="flex justify-between text-xs font-semibold text-[var(--secondary-foreground)] mb-1.5">
          <span>Armazenamento</span>
          <span className="text-[var(--foreground)]">7,3 GB de 15 GB</span>
        </div>
        <div className="w-full bg-[var(--background)] h-2 rounded-full overflow-hidden border border-[var(--border)]">
          <div className="bg-blue-600 h-full rounded-full" style={{ width: "48%" }}></div>
        </div>
      </div>
    </aside>
  );
}
