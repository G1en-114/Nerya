import { BrowserWorkspacePanel } from '../../components/chat/BrowserWorkspacePanel';

/** A browser is usable without creating a conversation or starting an Agent. */
export default function BrowsersPage() {
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="standalone-browser">
    <BrowserWorkspacePanel conversationId="" />
  </div>;
}
