import noraAvatar from "../../assets/nora-avatar.jpeg";

type NoraAvatarProps = {
  className?: string;
  variant?: "default" | "navigation";
};

export default function NoraAvatar({ className = "h-12 w-12", variant = "default" }: NoraAvatarProps) {
  return (
    <img
      src={noraAvatar}
      alt="Nora"
      className={`${className} object-cover object-center ${variant === "navigation" ? "rounded-lg bg-[#05090f]" : "rounded-full border border-blue-400/35 bg-[#05090f] shadow-[0_0_22px_rgba(37,99,235,0.34)]"}`}
      draggable={false}
    />
  );
}
