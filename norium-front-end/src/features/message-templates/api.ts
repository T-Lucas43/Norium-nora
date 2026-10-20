import { apiRequest } from "../../core/api/client";
import { requestScope } from "../../core/api/sessionScope";

export type MessageChannel = "email" | "whatsapp" | "team";
export type MessageTemplate = {
  id: string;
  name: string;
  channel: MessageChannel;
  category: string;
  subject: string;
  body: string;
  shortcut?: string;
  channels?: MessageChannel[];
  builtIn: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type MessageTemplateInput = Pick<MessageTemplate, "name" | "channel" | "category" | "subject" | "body" | "shortcut" | "channels">;

function announceChange<T>(operation: Promise<T>): Promise<T> {
  const scope = requestScope();
  return operation.then(result => { if (requestScope() === scope) window.dispatchEvent(new Event("norium:message-templates-changed")); return result; });
}

export const messageTemplatesApi = {
  list: (channel?: MessageChannel) => apiRequest<{ templates: MessageTemplate[] }>(`/api/message-templates${channel ? `?channel=${channel}` : ""}`, { cache: "no-store" }),
  create: (body: MessageTemplateInput) => announceChange(apiRequest<{ template: MessageTemplate }>("/api/message-templates", { method: "POST", body: JSON.stringify(body) })),
  update: (id: string, body: MessageTemplateInput) => announceChange(apiRequest<{ template: MessageTemplate }>(`/api/message-templates/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) })),
  remove: (id: string) => announceChange(apiRequest<{ deleted: boolean }>(`/api/message-templates/${encodeURIComponent(id)}`, { method: "DELETE" })),
  render: (templateId: string, variables: Record<string, string>) => apiRequest<{ subject: string; body: string; missingVariables: string[] }>("/api/message-templates/render", { method: "POST", body: JSON.stringify({ templateId, variables }) }),
};
