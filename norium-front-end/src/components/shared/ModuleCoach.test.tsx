import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ModuleCoach from "./ModuleCoach";

describe("ModuleCoach", () => {
  it("reuses the Norium module icon in the contextual screen guide", () => {
    const { container } = render(<ModuleCoach module="Automacoes" onAskNora={vi.fn()} />);

    expect(container.querySelector("img.norium-module-coach__icon-image")).not.toBeNull();
    expect(container.querySelector(".norium-module-coach__icon svg")).toBeNull();
  });
});
