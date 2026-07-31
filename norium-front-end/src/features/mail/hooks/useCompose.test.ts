import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompose } from "./useCompose";
import type { GmailMessage } from "../types";

const apiJson = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ mailApiRequest: apiJson }));

const msg = { id: "m1", threadId: "t1", subject: "s", snippet: "", fromName: "", fromEmail: "", labels: [] } as unknown as GmailMessage;

function setup(selectedMessage: GmailMessage | null = msg) {
  const options = {
    userId: "u1",
    selectedMessage,
    onError: vi.fn(),
    onSent: vi.fn(),
    onClearSuggestion: vi.fn(),
  };
  return { hook: renderHook(() => useCompose(options)), options };
}

beforeEach(() => {
  apiJson.mockReset();
  apiJson.mockResolvedValue({});
});

describe("sendEmail", () => {
  it("envia com destinatarios separados por virgula e ponto e virgula", async () => {
    const { hook } = setup();
    act(() => { hook.result.current.setCompose({ to: "a@x.com, b@y.com; c@z.com", cc: "", bcc: "", subject: "Oi", body: "corpo", attachments: [] }); });

    await act(async () => { await hook.result.current.sendEmail(); });

    const body = JSON.parse(apiJson.mock.calls[0][1].body);
    expect(apiJson.mock.calls[0][0]).toBe("/api/emails/gmail/send");
    expect(body.to).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
    expect(body.subject).toBe("Oi");
  });

  it("salva rascunho em rota propria e navega para rascunhos", async () => {
    const { hook, options } = setup();
    await act(async () => { await hook.result.current.sendEmail(true); });

    expect(apiJson.mock.calls[0][0]).toBe("/api/emails/gmail/drafts");
    expect(options.onSent).toHaveBeenCalledWith("drafts");
  });

  it("limpa o formulario, fecha o painel e navega para enviados", async () => {
    const { hook, options } = setup();
    act(() => { hook.result.current.setComposeOpen(true); });
    act(() => { hook.result.current.setCompose({ to: "a@x.com", cc: "", bcc: "", subject: "x", body: "y", attachments: [] }); });

    await act(async () => { await hook.result.current.sendEmail(); });

    expect(hook.result.current.compose.to).toBe("");
    expect(hook.result.current.composeOpen).toBe(false);
    expect(options.onClearSuggestion).toHaveBeenCalledWith("compose");
    expect(options.onSent).toHaveBeenCalledWith("sent");
  });

  it("preserva o rascunho digitado quando o envio falha", async () => {
    apiJson.mockRejectedValue(new Error("smtp fora"));
    const { hook, options } = setup();
    act(() => { hook.result.current.setCompose({ to: "a@x.com", cc: "", bcc: "", subject: "importante", body: "texto", attachments: [] }); });

    await act(async () => { await hook.result.current.sendEmail(); });

    expect(options.onError).toHaveBeenCalledWith("smtp fora");
    expect(hook.result.current.compose.subject).toBe("importante");
    expect(hook.result.current.sending).toBe(false);
  });

  it("envia somente os campos de anexo aceitos pela API", async () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.setCompose({
        to: "a@x.com", cc: "", bcc: "", subject: "", body: "",
        attachments: [{ id: "local-1", fileName: "a.pdf", mimeType: "application/pdf", size: 10, dataUrl: "data:x" }],
      });
    });

    await act(async () => { await hook.result.current.sendEmail(); });

    expect(JSON.parse(apiJson.mock.calls[0][1].body).attachments[0]).toEqual({
      fileName: "a.pdf", mimeType: "application/pdf", dataUrl: "data:x",
    });
  });
});

describe("sendReply", () => {
  it("nao envia sem mensagem selecionada", async () => {
    const { hook } = setup(null);
    act(() => { hook.result.current.setReplyText("oi"); });
    await act(async () => { await hook.result.current.sendReply(); });
    expect(apiJson).not.toHaveBeenCalled();
  });

  it("nao envia resposta so com espacos", async () => {
    const { hook } = setup();
    act(() => { hook.result.current.setReplyText("   "); });
    await act(async () => { await hook.result.current.sendReply(); });
    expect(apiJson).not.toHaveBeenCalled();
  });

  it("responde na rota da mensagem e limpa o campo", async () => {
    const { hook, options } = setup();
    act(() => { hook.result.current.setReplyText("segue retorno"); });

    await act(async () => { await hook.result.current.sendReply(); });

    expect(apiJson.mock.calls[0][0]).toBe("/api/emails/gmail/messages/m1/reply");
    expect(hook.result.current.replyText).toBe("");
    expect(options.onSent).toHaveBeenCalledWith("sent");
    expect(options.onClearSuggestion).toHaveBeenCalledWith("reply");
  });

  it("preserva o texto quando a resposta falha", async () => {
    apiJson.mockRejectedValue(new Error("indisponivel"));
    const { hook, options } = setup();
    act(() => { hook.result.current.setReplyText("nao posso perder isso"); });

    await act(async () => { await hook.result.current.sendReply(); });

    expect(options.onError).toHaveBeenCalledWith("indisponivel");
    expect(hook.result.current.replyText).toBe("nao posso perder isso");
  });
});

describe("addFiles", () => {
  it("ignora chamada sem arquivos", async () => {
    const { hook } = setup();
    await act(async () => { await hook.result.current.addFiles(null, "compose"); });
    expect(hook.result.current.compose.attachments).toHaveLength(0);
  });

  it("anexa na redacao e na resposta separadamente", async () => {
    const { hook } = setup();
    const file = new File(["x"], "nota.pdf", { type: "application/pdf" });
    const list = { 0: file, length: 1, item: () => file, [Symbol.iterator]: function* () { yield file; } } as unknown as FileList;

    await act(async () => { await hook.result.current.addFiles(list, "compose"); });
    expect(hook.result.current.compose.attachments).toHaveLength(1);
    expect(hook.result.current.replyAttachments).toHaveLength(0);

    await act(async () => { await hook.result.current.addFiles(list, "reply"); });
    expect(hook.result.current.replyAttachments).toHaveLength(1);
  });

  it("usa octet-stream quando o navegador nao informa o tipo", async () => {
    const { hook } = setup();
    const file = new File(["x"], "sem-tipo", { type: "" });
    const list = { 0: file, length: 1, item: () => file, [Symbol.iterator]: function* () { yield file; } } as unknown as FileList;

    await act(async () => { await hook.result.current.addFiles(list, "compose"); });

    expect(hook.result.current.compose.attachments[0].mimeType).toBe("application/octet-stream");
  });
});
