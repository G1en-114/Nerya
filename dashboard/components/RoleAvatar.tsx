import { resolve } from "../lib/roleAvatars";

// The native demo adapter changes only this base path, never the role mapping.
const AVATAR_BASE_PATH = "/branding/agents";

export type RoleAvatarProps = {
  role?: string;
  size?: number;
  /** Empty alt is appropriate when the adjacent visible label names the agent. */
  alt?: string;
  className?: string;
};

export function RoleAvatar({ role = "lead", size = 28, alt, className = "" }: RoleAvatarProps) {
  const key = resolve(role);
  const label = alt ?? (role.trim() || key);
  const pixels = Number.isFinite(size) && size > 0 ? size : 28;
  return <img src={`${AVATAR_BASE_PATH}/${key}.png`} alt={label} aria-hidden={label === "" ? true : undefined}
    data-avatar-role={key} width={pixels} height={pixels} draggable={false}
    className={`native-role-avatar ${className}`.trim()}
    style={{ display: "block", width: pixels, height: pixels, maxWidth: "none", flexShrink: 0, borderRadius: "50%", objectFit: "cover" }} />;
}
