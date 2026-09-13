export const STUDIO_TEMPLATES = [
  { id: "plano-projeto", title: "Plano do projeto", description: "Objetivos, entregas e um caminho para a equipe.", layout: "plan", sections: ["Objetivo e escopo", "Plano de ação", "Riscos e decisões"] },
  { id: "brainstorming", title: "Brainstorming", description: "Explore possibilidades e conecte boas ideias.", layout: "ideas", sections: ["Desafio", "Ideias", "Próximos passos"] },
  { id: "lista-afazeres", title: "Lista de afazeres", description: "Organize atividades e acompanhe as conclusões.", layout: "tasks", sections: ["A fazer", "Em andamento", "Concluído"] },
  { id: "anotacoes-reuniao", title: "Anotações de reunião", description: "Da pauta às decisões, tudo no mesmo lugar.", layout: "meeting", sections: ["Pauta", "Discussão e decisões", "Encaminhamentos"] },
  { id: "status-projeto", title: "Status do projeto", description: "Compartilhe avanços, riscos e próximos marcos.", layout: "status", sections: ["Progresso", "Pontos de atenção", "Próximas entregas"] },
  { id: "retrospectiva", title: "Retrospectiva", description: "Aprenda com o ciclo e combine melhorias.", layout: "retro", sections: ["Continuar", "Parar", "Começar"] },
] as const;

export function studioTemplateTitle(id: string) {
  return STUDIO_TEMPLATES.find((template) => template.id === id)?.title || ({ livre: "Quadro livre", "mapa-mental": "Mapa mental", swot: "Análise SWOT", jornada: "Jornada" }[id]) || id;
}

