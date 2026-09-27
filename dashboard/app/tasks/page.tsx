import { redirect } from "next/navigation";

// The standalone task desk is retired; execution and history live in chat.
export default function TasksPage() {
  redirect("/chat");
}
