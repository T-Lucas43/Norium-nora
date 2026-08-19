import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "./client";

describe("apiErrorMessage", () => {
  it("preserva a explicacao de validacao retornada pelo FastAPI", () => {
    expect(apiErrorMessage({
      detail: [{ loc: ["body", "password"], msg: "Value error, A senha deve ter pelo menos 10 caracteres." }],
    }, "Falha na API do Norium.")).toBe("A senha deve ter pelo menos 10 caracteres.");
  });

  it("mantem a mensagem generica somente quando a API nao forneceu detalhe", () => {
    expect(apiErrorMessage({ detail: [] }, "Falha na API do Norium.")).toBe("Falha na API do Norium.");
  });
});
