import { redirect } from "next/navigation";

// Keep old bookmarks working without maintaining a second settings surface.
export default function DesktopPage() {
  redirect("/settings#access");
}
