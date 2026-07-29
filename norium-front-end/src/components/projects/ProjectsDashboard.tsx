import { useState } from "react";
import ProjectsSidebar from "./ProjectsSidebar";
import ProjectsGrid from "./ProjectsGrid";

export type Projeto = {
  id: number;
  title: string;
  client: string;
  description: string;
  progress: number;
  dueDate: string;
  status: "Em andamento" | "Planejamento" | "Concluído";
  iconType: "rocket" | "cart" | "chart" | "user" | "phone" | "check";
  badgeColor: string;
  iconBgColor: string;
  iconColor: string;
  team: string[];
};

const mockProjetos: Projeto[] = [
  {
    id: 1,
    title: "Projeto Orion",
    client: "ACME Corp",
    description: "Desenvolvimento da nova plataforma de gestão empresarial.",
    progress: 68,
    dueDate: "30 Mai 2025",
    status: "Em andamento",
    iconType: "rocket",
    badgeColor: "bg-blue-50 text-blue-600",
    iconBgColor: "bg-sky-50",
    iconColor: "text-sky-500",
    team: ["https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100", "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100", "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100"]
  },
  {
    id: 2,
    title: "E-commerce NovaEra",
    client: "NovaEra Ltda.",
    description: "Plataforma de e-commerce com integração de pagamentos.",
    progress: 42,
    dueDate: "15 Jun 2025",
    status: "Em andamento",
    iconType: "cart",
    badgeColor: "bg-blue-50 text-blue-600",
    iconBgColor: "bg-emerald-50",
    iconColor: "text-emerald-500",
    team: ["https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100", "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100"]
  },
  {
    id: 3,
    title: "Campanha Q2",
    client: "ACME Corp",
    description: "Campanha de marketing digital para lançamento de produto.",
    progress: 75,
    dueDate: "28 Mai 2025",
    status: "Em andamento",
    iconType: "chart",
    badgeColor: "bg-blue-50 text-blue-600",
    iconBgColor: "bg-orange-50",
    iconColor: "text-orange-500",
    team: ["https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100", "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=100", "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=100"]
  },
  {
    id: 4,
    title: "Redesign Site Institucional",
    client: "ACME Corp",
    description: "Redesenho completo do site institucional com nova identidade visual.",
    progress: 12,
    dueDate: "10 Jul 2025",
    status: "Planejamento",
    iconType: "user",
    badgeColor: "bg-sky-50 text-sky-600",
    iconBgColor: "bg-pink-50",
    iconColor: "text-pink-500",
    team: ["https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100", "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100"]
  },
  {
    id: 5,
    title: "App Mobile",
    client: "NovaEra Ltda.",
    description: "Desenvolvimento do aplicativo para iOS e Android.",
    progress: 8,
    dueDate: "20 Ago 2025",
    status: "Planejamento",
    iconType: "phone",
    badgeColor: "bg-sky-50 text-sky-600",
    iconBgColor: "bg-blue-50",
    iconColor: "text-blue-500",
    team: ["https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100", "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=100", "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100"]
  },
  {
    id: 6,
    title: "Migração de Sistema",
    client: "ACME Corp",
    description: "Migração completa de servidores e dados para nova infraestrutura.",
    progress: 100,
    dueDate: "12 Abr 2025",
    status: "Concluído",
    iconType: "check",
    badgeColor: "bg-emerald-50 text-emerald-600",
    iconBgColor: "bg-emerald-50",
    iconColor: "text-emerald-500",
    team: ["https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100", "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100", "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=100", "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100"]
  }
];

export default function ProjectsDashboard() {
  const [projetos] = useState<Projeto[]>(mockProjetos);
  const [activeFilter, setActiveFilter] = useState("Todos os projetos");

  const projetosFiltrados = projetos.filter((p) => {
    if (activeFilter === "Em andamento") return p.status === "Em andamento";
    if (activeFilter === "Planejamento") return p.status === "Planejamento";
    if (activeFilter === "Concluídos") return p.status === "Concluído";
    return true;
  });

  return (
    <div className="flex h-full w-full bg-[var(--background)] antialiased overflow-hidden text-[var(--foreground)]">
      <ProjectsSidebar 
        activeFilter={activeFilter} 
        setActiveFilter={setActiveFilter} 
        projetos={projetos} 
      />
      <ProjectsGrid 
        projetos={projetosFiltrados} 
      />
    </div>
  );
}
