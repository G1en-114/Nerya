import { ChatView } from "../../components/chat/ChatView";

export const metadata = {
  title: "Chat · Nerya",
};

export default function ChatPage({ searchParams }: { searchParams?: { draft?: string | string[] } }) {
  // Explicit handoffs may target the same /chat route. Remount only for a new
  // draft so the composer consumes it once, without creating or sending a turn.
  const draftKey = typeof searchParams?.draft === "string" ? searchParams.draft : undefined;
  return (
    <div className="h-full">
      <ChatView key={draftKey} sessionId={undefined} />
    </div>
  );
}
