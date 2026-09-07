import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import AutomationFlowPreview from "./AutomationFlowPreview";

it("shows saved nodes and connections beyond the old fixed canvas and opens block details", () => {
  render(<AutomationFlowPreview flow={{ nodes: [
    { id: "trigger", kind: "trigger", title: "Novo contato", description: "Quando um contato chegar", icon: "zap", x: 0, y: 0 },
    { id: "action", kind: "action", title: "Criar tarefa", description: "Criar uma tarefa de acompanhamento", icon: "check", x: 1600, y: 600 },
  ], connections: [{ source: "trigger", target: "action" }] }} />);
  expect(screen.getByText("2 blocos · 1 conexões")).toBeInTheDocument();
  expect(screen.getByText("Novo contato → Criar tarefa")).toBeInTheDocument();
  expect(Number(document.querySelector("svg.flow-preview-connections")?.getAttribute("width"))).toBeGreaterThan(1600);
  fireEvent.click(screen.getByRole("button", { name: "Ação: Criar tarefa" }));
  expect(screen.getByText("Ação · Criar tarefa")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Aumentar zoom" }));
  expect(screen.getByLabelText("Zoom do fluxo")).toHaveTextContent("30%");
});

it("explains an empty flow without inventing blocks", () => {
  render(<AutomationFlowPreview flow={{ nodes: [], connections: [] }} />);
  expect(screen.getByText("Este fluxo ainda não tem blocos")).toBeInTheDocument();
});
