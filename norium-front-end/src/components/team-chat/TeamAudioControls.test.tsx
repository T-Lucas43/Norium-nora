import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TeamAudioControls from "./TeamAudioControls";

describe("TeamAudioControls", () => {
  it("cycles audio playback speed from 1x to 1.5x and 2x", () => {
    const { container } = render(<TeamAudioControls src="blob:test-audio" label="Áudio de teste" />);
    const audio = container.querySelector("audio") as HTMLAudioElement;
    const speed = screen.getByRole("button", { name: "Velocidade do áudio 1x" });
    fireEvent.click(speed);
    expect(audio.playbackRate).toBe(1.5);
    expect(screen.getByRole("button", { name: "Velocidade do áudio 1.5x" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Velocidade do áudio 1.5x" }));
    expect(audio.playbackRate).toBe(2);
  });
});
