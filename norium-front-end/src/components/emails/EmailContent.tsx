import { useState, useEffect } from "react";
import {
  Archive, Trash2, Mail, Star, MoreHorizontal, ChevronLeft,
  Paperclip, Image, Send, X
} from "lucide-react";
import type { Email } from "./EmailDashboard";
import EmailTabs from "./EmailTabs";
import Button from "../shared/Button";

interface EmailContentProps {
  selectedEmail: Email | null;
  onClose: () => void;
}

export default function EmailContent({ selectedEmail, onClose }: EmailContentProps) {
  const [replyText, setReplyText] = useState("");

  useEffect(() => {
    setReplyText("");
  }, [selectedEmail]);

  if (!selectedEmail) {
    return (
      <main className="flex-1 bg-[var(--background)] flex flex-col items-center justify-center text-[var(--secondary-foreground)] gap-2 h-full">
        <Mail size={32} />
        <p className="text-sm font-medium">Selecione um e-mail para ler</p>
      </main>
    );
  }

  return (
    <main className="flex-1 bg-[var(--background)] flex flex-col min-w-0 h-full overflow-y-auto">
      {/* Barra de Ações */}
      <div className="p-4 border-b border-[var(--border)] flex items-center justify-between sticky top-0 bg-[var(--background)] z-10 shrink-0">
        <div className="flex items-center gap-1 text-[var(--secondary-foreground)]">
          <Button variant="ghost" className="p-2 hover:bg-[var(--hover-background)]"><ChevronLeft size={18} /></Button>
          <Button variant="ghost" className="p-2 hover:bg-[var(--hover-background)]"><Archive size={18} /></Button>
          <Button variant="ghost" className="p-2 hover:bg-[var(--hover-background)]"><Trash2 size={18} /></Button>
          <Button variant="ghost" className="p-2 hover:bg-[var(--hover-background)]"><Mail size={18} /></Button>
          <Button variant="ghost" className="p-2 hover:bg-[var(--hover-background)]"><Star size={18} /></Button>
          <Button variant="ghost" className="p-2 hover:bg-[var(--hover-background)]"><MoreHorizontal size={18} /></Button>
        </div>
        
        <div>
          <Button variant="danger" 
            onClick={onClose} 
            className="p-2 hover:bg-red-500/10 text-[var(--secondary-foreground)] hover:text-red-500"
            title="Fechar e-mail"
           aria-label="Fechar e-mail">
            <span>Fechar</span>
            <X size={16} />
          </Button>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6">
        <div className="flex items-start justify-between">
          <div className="space-y-1.5">
            <h1 className="text-xl font-bold text-[var(--foreground)]">{selectedEmail.subject}</h1>
            <span className="inline-block text-xs font-bold bg-blue-500/10 text-blue-500 px-2.5 py-0.5 rounded-md">
              {selectedEmail.folder}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between bg-[var(--card-background)] p-4 rounded-xl border border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${selectedEmail.avatarColor}`}>
              {selectedEmail.sender.split(" ").map(n => n[0]).join("")}
            </div>
            <div>
              <div className="text-sm font-bold text-[var(--foreground)]">
                {selectedEmail.sender} <span className="text-xs font-medium text-[var(--secondary-foreground)] ml-1">&lt;{selectedEmail.email}&gt;</span>
              </div>
            </div>
          </div>
          <span className="text-xs font-medium text-[var(--secondary-foreground)]">{selectedEmail.dateFull || selectedEmail.time}</span>
        </div>

        <div className="text-sm text-[var(--foreground)] whitespace-pre-line leading-relaxed px-1">
          {selectedEmail.content || "Sem conteúdo disponível."}
        </div>

        {selectedEmail.hasAttachment && (
          <div className="pt-4 border-t border-[var(--border)]">
            <div className="flex items-center justify-between max-w-sm p-3 bg-[var(--card-background)] border border-[var(--border)] rounded-xl shadow-sm">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-500/10 text-red-500 rounded-lg flex items-center justify-center font-bold text-xs shrink-0">PDF</div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-[var(--foreground)] truncate">{selectedEmail.attachmentName}</p>
                  <p className="text-xs font-medium text-[var(--secondary-foreground)]">{selectedEmail.attachmentSize}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        <EmailTabs onSelectPhrase={(phrase) => setReplyText(phrase)} />

        <div className="border border-[var(--border)] rounded-xl bg-[var(--card-background)] overflow-hidden focus-within:border-blue-500 transition mt-4">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Escreva sua resposta aqui..."
            className="w-full min-h-[100px] p-4 bg-transparent outline-none text-sm resize-none text-[var(--foreground)]"
          />
          <div className="p-3 bg-[var(--background)] border-t border-[var(--border)] flex items-center justify-between">
            <div className="flex items-center gap-1 text-[var(--secondary-foreground)]">
              <Button variant="ghost" className="p-2 hover:bg-[var(--hover-background)]"><Paperclip size={16} /></Button>
              <Button variant="ghost" className="p-2 hover:bg-[var(--hover-background)]"><Image size={16} /></Button>
            </div>
            <Button variant="primary" className="bg-blue-600 hover:bg-blue-700 py-2">
              <Send size={14} />
              <span>Enviar</span>
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
