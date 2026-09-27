import { MessagesIcon } from "../icons";

/** Source is conveyed by geometry and an accessible label, not color alone. */
export function ConversationSourceIcon({ source, size = 16, className = "" }: {
  source?: string; size?: number; className?: string;
}) {
  if (source !== "mcp" && source !== "tunnel") {
    return <MessagesIcon size={size} className={className} aria-label="Chat" />;
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    role="img" aria-label={source === "mcp" ? "MCP" : "Tunnel"} className={className}>
    {source === "mcp" ? <>
      <path d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4" />
    </> : <>
      <circle cx="5" cy="6" r="2.5" /><circle cx="19" cy="18" r="2.5" />
      <path d="M7.5 6H15a4 4 0 0 1 0 8H9a2 2 0 0 0 0 4h7.5m-5-8 2 2-2 2" />
    </>}
  </svg>;
}
