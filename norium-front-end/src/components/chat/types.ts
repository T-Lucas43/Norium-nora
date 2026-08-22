export type ChatChannel = "whatsapp";

export interface MsgConteudo {
  id: string;
  remetente: "usuario" | "contato";
  remetenteNome?: string;
  remetenteId?: string;
  texto?: string;
  tipo: "texto" | "audio" | "documento" | "midia" | "sticker";
  arquivoUrl?: string;
  arquivoMime?: string;
  duracaoAudio?: string;
  nomeArquivo?: string;
  horario: string;
  timestamp?: number;
  status?: "erro" | "pendente" | "enviado" | "entregue" | "lido" | "reproduzido";
  reacoes?: Array<{ emoji: string; count: number; fromMe?: boolean; senders?: string[] }>;
  citada?: { id?: string; content?: string; senderName?: string; type?: string } | null;
  canal?: ChatChannel;
  channel?: ChatChannel;
}

export interface AnexoPendente {
  id: string;
  arquivo: Blob;
  nomeArquivo: string;
  mimeType: string;
  tamanho: number;
  tipo: "audio" | "image" | "video" | "document";
  urlPreview: string;
}

export interface ParticipanteGrupo {
  id: string;
  phone: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin?: boolean;
  photoUrl?: string;
}

export interface PerfilMetadados {
  numeroCompleto: string;
  username?: string;
  bioRecado?: string;
  verifiedName?: string;
  isBusiness?: boolean;
  isMyContact?: boolean;
  isBlocked?: boolean;
  statusOnline: boolean;
  photoUrl?: string;
  // Metadados adicionais para Grupos
  participantes?: ParticipanteGrupo[];
  descricaoGrupo?: string;
  criadoPor?: string;
  criadoEm?: number | string;
}

export interface ChatConversa {
  id: string;
  contato: string;
  canal: ChatChannel;
  channel?: ChatChannel;
  ultimoTexto: string;
  horario: string;
  timestampUltimaMsg: number;
  lida: boolean;
  naoLidasCount?: number;
  fixada?: boolean;
  favorita?: boolean;
  silenciada?: boolean;
  arquivada?: boolean;
  esGrupo?: boolean;
  mensagens: MsgConteudo[];
  metadados: PerfilMetadados;
  photoUrl?: string;
}
