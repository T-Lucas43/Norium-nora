import ReactMarkdown from "react-markdown";
import { Children, type ReactNode } from "react";
import { mentionParts } from "./teamChatConversations";

export default function TeamMessageText({ text, mentions }: { text: string; mentions: unknown }) {
  function mark(children: ReactNode) { return Children.map(children, (child) => typeof child === "string" ? mentionParts(child, mentions).map((part, index) => index % 2 ? <span key={index} className="team-chat-mention-token">{part}</span> : part) : child); }
  return <div className="team-v3-markdown"><ReactMarkdown components={{ img: ({ alt }) => <span>{alt || "Imagem externa omitida"}</span>, p: ({ children }) => <p>{mark(children)}</p>, li: ({ children }) => <li>{mark(children)}</li>, strong: ({ children }) => <strong>{mark(children)}</strong>, a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{mark(children)}</a> }}>{text}</ReactMarkdown></div>;
}
