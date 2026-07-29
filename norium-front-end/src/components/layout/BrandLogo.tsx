import logoTextDark from "../../assets/logo.png";
import logoTextWhite from "../../assets/logo-text-white.png";

type BrandLogoProps = {
  className?: string;
};

export default function BrandLogo({ className = "h-11 w-[116px]" }: BrandLogoProps) {
  return (
    <span className={`norium-brand-logo ${className}`}>
      <img src={logoTextDark} alt="Norium" className="norium-brand-logo-light" />
      <img src={logoTextWhite} alt="Norium" className="norium-brand-logo-dark" />
    </span>
  );
}
