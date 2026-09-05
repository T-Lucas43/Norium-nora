import { beforeEach, describe, expect, it } from "vitest";
import { clearMailboxCacheForUser, mailboxCacheKey, mailboxSessionCache } from "./mailboxCache";
import type { MailboxSnapshot } from "./types";

const snapshot: MailboxSnapshot = { messages: [], nextPageToken: null, resultSize: 0, cachedAt: 0 };

beforeEach(() => { mailboxSessionCache.clear(); localStorage.clear(); });

describe("mailboxCacheKey", () => {
  it("isola o mesmo usuario entre ambientes e invalida todos ao desconectar", () => {
    localStorage.setItem("norium-workspace-id", "empresa-a");
    const first = mailboxCacheKey("u1", "inbox", "all", "");
    mailboxSessionCache.set(first, snapshot);
    localStorage.setItem("norium-workspace-id", "empresa-b");
    const second = mailboxCacheKey("u1", "inbox", "all", "");
    mailboxSessionCache.set(second, snapshot);
    expect(first).not.toBe(second);
    clearMailboxCacheForUser("u1");
    expect(mailboxSessionCache.size).toBe(0);
  });
  it("gera chaves diferentes por usuario, pasta, filtro e busca", () => {
    const a = mailboxCacheKey("u1", "inbox", "all", "");
    expect(a).not.toBe(mailboxCacheKey("u2", "inbox", "all", ""));
    expect(a).not.toBe(mailboxCacheKey("u1", "sent", "all", ""));
    expect(a).not.toBe(mailboxCacheKey("u1", "inbox", "read", ""));
    expect(a).not.toBe(mailboxCacheKey("u1", "inbox", "all", "nota"));
  });

  it("ignora espacos em volta da busca para nao duplicar entradas", () => {
    expect(mailboxCacheKey("u1", "inbox", "all", "  nota  ")).toBe(mailboxCacheKey("u1", "inbox", "all", "nota"));
  });

  it("reflete a pasta virtual do filtro (unread/starred)", () => {
    expect(mailboxCacheKey("u1", "inbox", "unread", "")).toBe(mailboxCacheKey("u1", "sent", "unread", ""));
  });
});

describe("clearMailboxCacheForUser", () => {
  it("remove somente as entradas do usuario informado", () => {
    mailboxSessionCache.set(mailboxCacheKey("u1", "inbox", "all", ""), snapshot);
    mailboxSessionCache.set(mailboxCacheKey("u1", "sent", "all", ""), snapshot);
    mailboxSessionCache.set(mailboxCacheKey("u2", "inbox", "all", ""), snapshot);

    clearMailboxCacheForUser("u1");

    expect(mailboxSessionCache.size).toBe(1);
    expect(mailboxSessionCache.has(mailboxCacheKey("u2", "inbox", "all", ""))).toBe(true);
  });

  it("nao falha quando nao ha nada para remover", () => {
    expect(() => clearMailboxCacheForUser("inexistente")).not.toThrow();
  });

  it("nao apaga usuario cujo id apenas comeca igual", () => {
    mailboxSessionCache.set(mailboxCacheKey("u1", "inbox", "all", ""), snapshot);
    mailboxSessionCache.set(mailboxCacheKey("u10", "inbox", "all", ""), snapshot);

    clearMailboxCacheForUser("u1");

    expect(mailboxSessionCache.has(mailboxCacheKey("u10", "inbox", "all", ""))).toBe(true);
  });
});
