import { ArrowRight, BrainCircuit, CalendarDays, CircleCheckBig, Mail, Sparkles } from "lucide-react";
import type { DashboardMetrics } from "./Dashboard";
import NoraAvatar from "../layout/NoraAvatar";

type NoraPanelProps = {
  metrics: DashboardMetrics;
  onOpenNora: () => void;
  onNavigate: (tab: string) => void;
};

export default function NoraPanel({ metrics, onOpenNora, onNavigate }: NoraPanelProps) {
  return (
    <section className="dashboard-nora-shell relative overflow-hidden rounded-3xl border p-7 text-white backdrop-blur-xl">
      <div className="dashboard-glow-cyan absolute -right-24 -top-24 h-60 w-60 rounded-full blur-3xl" />
      <div className="dashboard-glow-blue absolute -bottom-24 -left-24 h-60 w-60 rounded-full blur-3xl" />
      <NoraAvatar className="absolute right-5 top-5 h-14 w-14 opacity-95 drop-shadow-2xl sm:right-7 sm:top-7 sm:h-20 sm:w-20" />

      <div className="relative z-10 pr-14 sm:pr-24">
        <div className="dashboard-chip mb-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold">
          <Sparkles size={16} />
          Nora pronta para agir
        </div>

        <h2 className="text-3xl font-black leading-tight">O que deseja resolver agora?</h2>

        <p className="mt-4 text-sm font-semibold leading-6 text-white/90">
          Posso responder e-mails, organizar a agenda, criar tarefas e resumir seus canais conectados.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            onClick={onOpenNora}
            className="dashboard-primary-action rounded-2xl px-5 py-3 text-sm font-bold text-white hover:scale-105"
          >
            Conversar
          </button>

          <button
            onClick={() => onNavigate("Central")}
            className="dashboard-secondary-action flex items-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold"
          >
            Abrir central
            <ArrowRight size={17} />
          </button>
        </div>

        <div className="mt-6 grid gap-3">
          <div className="dashboard-tile flex items-center gap-3 rounded-2xl p-4">
            <BrainCircuit />
            <div>
              <strong>IA operacional</strong>
              <p className="text-sm text-white/80">Nora integrada aos agentes</p>
            </div>
          </div>

          <button
            onClick={() => onNavigate("E-mails")}
            className="dashboard-tile flex items-center gap-3 rounded-2xl p-4 text-left"
          >
            <Mail />
            <div>
              <strong>{metrics.emails} eventos de e-mail</strong>
              <p className="text-sm text-white/80">Gmail sincronizado</p>
            </div>
          </button>

          <button
            onClick={() => onNavigate("Agenda")}
            className="dashboard-tile flex items-center gap-3 rounded-2xl p-4 text-left"
          >
            <CalendarDays />
            <div>
              <strong>{metrics.calendar} eventos de agenda</strong>
              <p className="text-sm text-white/80">Compromissos recentes</p>
            </div>
          </button>

          <button
            onClick={() => onNavigate("Tarefas")}
            className="dashboard-tile flex items-center gap-3 rounded-2xl p-4 text-left"
          >
            <CircleCheckBig />
            <div>
              <strong>{metrics.tasks} eventos de tarefas</strong>
              <p className="text-sm text-white/80">Kanban em movimento</p>
            </div>
          </button>
        </div>
      </div>
    </section>
  );
}
