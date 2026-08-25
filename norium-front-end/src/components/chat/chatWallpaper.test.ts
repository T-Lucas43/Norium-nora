import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  chatWallpaperStorageKey,
  persistChatWallpaper,
  readChatWallpaper,
  removeChatWallpaper,
  useChatWallpaper,
} from "./chatWallpaper";

describe("preferência de fundo das conversas", () => {
  beforeEach(() => window.localStorage.clear());

  it("mantém imagens separadas por usuário e restaura o padrão sem afetar os demais", () => {
    const first = { dataUrl: "data:image/png;base64,AAAA", fileName: "praia.png", updatedAt: 1 };
    const second = { dataUrl: "data:image/jpeg;base64,BBBB", fileName: "cidade.jpg", updatedAt: 2 };

    persistChatWallpaper("usuario-1", first);
    persistChatWallpaper("usuario-2", second);

    expect(readChatWallpaper("usuario-1")).toEqual(first);
    expect(readChatWallpaper("usuario-2")).toEqual(second);
    expect(chatWallpaperStorageKey("usuario-1")).not.toBe(chatWallpaperStorageKey("usuario-2"));

    removeChatWallpaper("usuario-1");
    expect(readChatWallpaper("usuario-1")).toBeNull();
    expect(readChatWallpaper("usuario-2")).toEqual(second);
  });

  it("ignora preferências adulteradas que não são imagens locais", () => {
    window.localStorage.setItem(chatWallpaperStorageKey("usuario-1"), JSON.stringify({
      dataUrl: "https://example.com/tracker.png",
      fileName: "externa.png",
    }));

    expect(readChatWallpaper("usuario-1")).toBeNull();
  });

  it("descarta o processamento pendente quando o usuário muda", async () => {
    const secondUserPreference = { dataUrl: "data:image/png;base64,BBBB", fileName: "usuario-2.png", updatedAt: 2 };
    persistChatWallpaper("usuario-2", secondUserPreference);
    const { result, rerender } = renderHook(
      ({ userId }) => useChatWallpaper(userId),
      { initialProps: { userId: "usuario-1" } },
    );
    const image = new File(["imagem do primeiro usuário"], "usuario-1.png", { type: "image/png" });

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.selectFile(image);
    });
    rerender({ userId: "usuario-2" });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(result.current.preference).toEqual(secondUserPreference));
    expect(readChatWallpaper("usuario-1")).toBeNull();
    expect(result.current.saving).toBe(false);
  });
});
