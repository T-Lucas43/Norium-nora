import { RotateCw, Filter } from "lucide-react";
import type { Email } from "./EmailDashboard";

interface EmailListProps {
  emails: Email[];
  selectedEmail: Email | null;
  setSelectedEmail: (email: Email) => void;
  activeFolder: string;
}

export default function EmailList({ emails, selectedEmail, setSelectedEmail, activeFolder }: EmailListProps) {
  return (
    <section className={`bg-[var(--background)] border-r border-[var(--border)] flex flex-col shrink-0 h-full transition-all duration-300 ${
      selectedEmail ? "w-[400px]" : "flex-1"
    }`}>
      <div className="p-4 border-b border-[var(--border)]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-[var(--foreground)]">{activeFolder}</h1>
            <span className="text-xs text-[var(--secondary-foreground)] font-medium">12 não lidos</span>
          </div>
          <div className="flex items-center gap-1 text-[var(--secondary-foreground)]">
            <button className="p-2 hover:bg-[var(--hover-background)] rounded-lg transition"><RotateCw size={16} /></button>
            <button className="p-2 hover:bg-[var(--hover-background)] rounded-lg transition flex items-center gap-1 text-sm font-medium"><Filter size={16} /> Filtro</button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)]">
        {emails?.map((email) => (
          <div
            key={email.id}
            onClick={() => setSelectedEmail(email)}
            className={`p-4 cursor-pointer transition relative ${
              selectedEmail?.id === email.id 
                ? "bg-blue-500/10 border-l-2 border-blue-500" 
                : "hover:bg-[var(--hover-background)]"
            }`}
          >
            {email.unread && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2 w-2 h-2 bg-blue-500 rounded-full" />
            )}
            
            <div className="flex gap-3">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${email.avatarColor}`}>
                {email.sender.split(" ").map(n => n[0]).join("")}
              </div>
              <div className="flex-1 min-w-0 pr-3">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-sm font-bold text-[var(--foreground)] truncate">{email.sender}</span>
                  <span className="text-xs text-[var(--secondary-foreground)] font-medium shrink-0">{email.time}</span>
                </div>
                <h2 className="text-xs font-bold text-[var(--foreground)] mb-1 truncate">{email.subject}</h2>
                <p className="text-xs text-[var(--secondary-foreground)] line-clamp-2 leading-relaxed">{email.preview}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
