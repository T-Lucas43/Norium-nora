export function digitsOnly(value: string, maximum = 15) {
  return value.replace(/\D/g, "").slice(0, maximum);
}

export function formatCpf(value: string) {
  const digits = digitsOnly(value, 11);
  return digits
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}

export function isValidCpf(value: string) {
  const digits = digitsOnly(value, 11);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (length: number) => {
    const sum = digits.slice(0, length).split("").reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return Number(digits[length]) === (remainder === 10 ? 0 : remainder);
  };
  return check(9) && check(10);
}

export function formatPhone(value: string) {
  const digits = digitsOnly(value, 15);
  const hasBrazilCode = digits.startsWith("55") && digits.length > 11;
  const local = (hasBrazilCode ? digits.slice(2) : digits).slice(0, 11);
  if (!local) return hasBrazilCode ? "+55" : "";
  if (local.length < 3) return `${hasBrazilCode ? "+55 " : ""}(${local}`;
  const area = local.slice(0, 2);
  const number = local.slice(2);
  const split = number.length > 8 ? 5 : 4;
  const formatted = number.length > split ? `${number.slice(0, split)}-${number.slice(split)}` : number;
  return `${hasBrazilCode ? "+55 " : ""}(${area}) ${formatted}`.trimEnd();
}

export function isValidPhone(value: string) {
  const length = digitsOnly(value).length;
  return length >= 8 && length <= 15;
}

export function validateSchedulingField(type: string, value: string, required = false, maximum = 500) {
  const trimmed = value.trim();
  if (required && !trimmed) return "Campo obrigatório.";
  if (!trimmed) return "";
  if (value.length > maximum) return `Use no máximo ${maximum} caracteres.`;
  if (type === "cpf" && !isValidCpf(value)) return "Informe um CPF válido.";
  if (type === "phone" && !isValidPhone(value)) return "Informe um telefone válido, com DDD.";
  if (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Informe um e-mail válido.";
  return "";
}
