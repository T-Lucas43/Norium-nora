import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import AuthLayout from "./AuthLayout";

beforeEach(() => { localStorage.removeItem("norium-theme"); document.documentElement.classList.remove("dark"); });
describe("Auth layout", () => {
  it("uses the official brand and preserves legal and Nora content", () => {
    localStorage.setItem("norium-theme", "claro");
    render(<AuthLayout><h1>Entrar</h1></AuthLayout>);
    expect(screen.getByRole("main")).toHaveAttribute("data-auth-theme", "claro");
    expect(screen.getAllByAltText("Norium")).toHaveLength(2);
    expect(screen.getByRole("navigation", { name: "Documentos legais" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Sobre o Norium" })).toHaveTextContent("A Nora prepara, você aprova.");
  });
  it("follows a stored theme change without modifying it", () => {
    localStorage.setItem("norium-theme", "escuro");
    render(<AuthLayout>Formulário</AuthLayout>);
    expect(screen.getByRole("main")).toHaveClass("dark");
    act(() => { localStorage.setItem("norium-theme", "claro"); window.dispatchEvent(new Event("norium-theme-change")); });
    expect(screen.getByRole("main")).not.toHaveClass("dark");
    expect(localStorage.getItem("norium-theme")).toBe("claro");
  });
  it("keeps wide plan selection without removing its legal links", () => {
    render(<AuthLayout wide>Planos</AuthLayout>);
    expect(screen.getByRole("main")).toHaveClass("is-wide");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Termos de Uso" })).toBeInTheDocument();
  });
});
