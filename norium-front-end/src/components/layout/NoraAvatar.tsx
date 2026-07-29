import noraAvatar from "../../assets/nora-brand.png";

type NoraAvatarProps = {
  className?: string;
};

export default function NoraAvatar({ className = "h-12 w-12" }: NoraAvatarProps) {
  return (
    <img
      src={noraAvatar}
      alt="Nora"
      className={`${className} rounded-full border border-blue-400/35 bg-[#05090f] object-cover object-center shadow-[0_0_22px_rgba(37,99,235,0.34)]`}
      draggable={false}
    />
  );
}
