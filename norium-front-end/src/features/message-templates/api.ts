import { apiRequest } from "../../core/api/client";

export type MessageChannel = "email" | "whatsapp";
export type MessageTemplate = {
  id: string;
  name: string;
  channel: MessageChannel;
  category: string;
  subject: string;
  body: string;
  builtIn: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type MessageTemplateInput = Pick<MessageTemplate, "name" | "channel" | "category" | "subject" | "body">;

export const messageTemplatesApi = {
  list: (channel?: MessageChannel) => apiRequest<{ templates: MessageTemplate[] }>(`/api/message-templates${channel ? `?channel=${channel}` : ""}`, { cache: "no-store" }),
  create: (body: MessageTemplateInput) => apiRequest<{ template: MessageTemplate }>("/api/message-templates", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: MessageTemplateInput) => apiRequest<{ template: MessageTemplate }>(`/api/message-templates/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  remove: (id: string) => apiRequest<{ deleted: boolean }>(`/api/message-templates/${encodeURIComponent(id)}`, { method: "DELETE" }),
  render: (templateId: string, variables: Record<string, string>) => apiRequest<{ subject: string; body: string; missingVariables: string[] }>("/api/message-templates/render", { method: "POST", body: JSON.stringify({ templateId, variables }) }),
};
