"use client";

import type { SVGProps } from "react";
import paths from "./icon-paths.json";

/** Nerya Outline: shared with the public site by tools/sync-icons.mjs.
 * 24-unit grid, round terminals, open counters and optically balanced bounds.
 * Small icons receive a slight weight correction, not a filled variant.
 * Keep decoration hidden from AT; name the enclosing icon-only button.
 */
export type IconName = keyof typeof paths;
export type IconProps = Omit<SVGProps<SVGSVGElement>, "name"> & { size?: number; title?: string };
export const ICON_NAMES = Object.keys(paths) as IconName[];

export function Icon({ name, size = 18, title, className, children, ...rest }: IconProps & { name: IconName }) {
  const labelled = Boolean(title || rest["aria-label"] || rest["aria-labelledby"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={size <= 16 ? 1.75 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
      aria-label={title || undefined}
      data-nerya-icon={name}
      className={["nerya-icon", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <path d={paths[name]} />
      {children}
    </svg>
  );
}

function glyph(name: IconName) {
  function NeryaIcon(props: IconProps) { return <Icon name={name} {...props} />; }
  NeryaIcon.displayName = `NeryaIcon(${name})`;
  return NeryaIcon;
}

// Backwards-compatible exports: existing controls keep their behaviour.
export const OverviewIcon = glyph("overview");
export const AgentsIcon = glyph("agents");
export const SubagentsIcon = glyph("subagents");
export const SkillsIcon = glyph("skills");
export const TriggersIcon = glyph("bolt");
export const ScriptsIcon = glyph("scripts");
export const PortfolioIcon = glyph("portfolio");
export const OrdersIcon = glyph("orders");
export const StrategiesIcon = glyph("strategies");
export const HistoryIcon = glyph("history");
export const MessagesIcon = glyph("messages");
export const MemoryIcon = glyph("memory");
export const EvolutionIcon = glyph("evolution");
export const SecurityIcon = glyph("shield");
export const NeryaMark = glyph("nerya");
export const ChatIcon = glyph("chat");
export const SettingsIcon = glyph("settings");
export const SearchIcon = glyph("search");
export const BellIcon = glyph("bell");
export const PowerIcon = glyph("power");
export const StarIcon = glyph("star");
export const MoonIcon = glyph("moon");
export const ChevronLeftIcon = glyph("chevronLeft");
export const ChevronRightIcon = glyph("chevronRight");
export const ChevronDownIcon = glyph("chevronDown");
export const ChevronUpIcon = glyph("chevronUp");
export const PlusIcon = glyph("plus");
export const SparkIcon = glyph("spark");
export const SendIcon = glyph("send");
export const StopIcon = glyph("stop");
export const PauseIcon = glyph("pause");
export const CopyIcon = glyph("copy");
export const EditIcon = glyph("edit");
export const TrashIcon = glyph("trash");
export const CheckIcon = glyph("check");
export const XIcon = glyph("x");
export const ShieldCheckIcon = glyph("shield");
export const ShieldXIcon = glyph("shieldX");
export const WrenchIcon = glyph("wrench");
export const RefreshIcon = glyph("refresh");
export const ScriptRunIcon = glyph("play");
export const ChartIcon = glyph("chart");
export const GlobeIcon = glyph("globe");
export const FolderIcon = glyph("folder");
export const FileIcon = glyph("file");
export const DiffIcon = glyph("diff");
export const ImageIcon = glyph("image");
export const FilePlusIcon = glyph("filePlus");
export const FolderPlusIcon = glyph("folderPlus");
export const SaveIcon = glyph("save");
export const LanguagesIcon = glyph("languages");
export const ComposeIcon = glyph("compose");
export const PuzzleIcon = glyph("puzzle");
export const CommandIcon = glyph("command");
export const PanelLeftIcon = glyph("panelLeft");
export const ClockIcon = glyph("clock");

// Shared utilities replace ad-hoc inline SVGs and font-dependent symbols.
export const MoreIcon = glyph("ellipsis");
export const ExternalLinkIcon = glyph("arrowUpRight");
export const ArrowRightIcon = glyph("arrowRight");
export const ArrowLeftIcon = glyph("arrowLeft");
export const ArrowDownIcon = glyph("arrowDown");
export const DownloadIcon = glyph("download");
export const UploadIcon = glyph("upload");
export const SunIcon = glyph("sun");
export const MenuIcon = glyph("menu");
export const CircleIcon = glyph("circle");
export const CircleDotIcon = glyph("circleDot");
export const CircleCheckIcon = glyph("circleCheck");
export const InfoIcon = glyph("info");
export const WarningIcon = glyph("warning");
export const LockIcon = glyph("lock");
export const KeyIcon = glyph("key");
export const AttachmentIcon = glyph("attachment");
export const PinIcon = glyph("pin");
export const BranchIcon = glyph("branch");
export const WorkflowIcon = glyph("workflow");
export const CodeIcon = glyph("code");
export const DocumentIcon = glyph("document");
export const BitcoinIcon = glyph("bitcoin");
export const PredictionIcon = glyph("prediction");
export const CandlesIcon = glyph("candles");
export const BuildingIcon = glyph("building");
export const CornerDownRightIcon = glyph("cornerDownRight");
export const LoaderIcon = glyph("loader");
export const MicrophoneIcon = glyph("microphone");
export const EyeIcon = glyph("eye");
export const MonitorIcon = glyph("monitor");
export const WalletIcon = glyph("wallet");
export const LinkIcon = glyph("link");
export const HelpIcon = glyph("help");

type IconComponent = (props: IconProps) => JSX.Element;
export const NAV_ICONS: Record<string, IconComponent> = {
  "/dashboard": OverviewIcon, "/chat": ChatIcon,
  "/portfolio": PortfolioIcon, "/accounts": SecurityIcon,
  "/orders": OrdersIcon, "/incidents": BellIcon,
  "/strategies": StrategiesIcon, "/agents": AgentsIcon,
  "/skills": SkillsIcon, "/factors": SkillsIcon, "/workflows": WorkflowIcon,
  "/inbox": BellIcon, "/tasks": AgentsIcon,
  "/self-evolution": EvolutionIcon, "/settings": SettingsIcon,
  "/gateway": MessagesIcon, "/web-search": SearchIcon,
  "/browsers": GlobeIcon, "/env-vault": SecurityIcon,
  "/visual-evidence": ImageIcon,
};

/** Backend semantic hints stay independent of SVG geometry. */
export const NAV_ICON_BY_NAME: Record<string, IconComponent> = {
  home: OverviewIcon, chat: ChatIcon, portfolio: PortfolioIcon,
  accounts: SecurityIcon, orders: OrdersIcon, incidents: BellIcon,
  strategy: StrategiesIcon, workflow: WorkflowIcon, inbox: BellIcon,
  settings: SettingsIcon, agents: AgentsIcon, subagents: SubagentsIcon,
  skills: SkillsIcon, scripts: ScriptsIcon, history: HistoryIcon,
  messages: MessagesIcon, memory: MemoryIcon, evolution: EvolutionIcon,
  security: SecurityIcon, globe: GlobeIcon, shield: ShieldCheckIcon,
  search: SearchIcon, browsers: GlobeIcon, vault: SecurityIcon,
  image: ImageIcon, eye: EyeIcon,
};
