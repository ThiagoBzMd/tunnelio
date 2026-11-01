// The icon gallery an agent picks from (the app's own icon set, a fixed list so only these are
// bundled) and the skill categories with their icons and colours.

import {
  BabyIcon,
  BookOpenIcon,
  BotIcon,
  BoxIcon,
  BrainIcon,
  BriefcaseIcon,
  BrushIcon,
  BugIcon,
  Building2Icon,
  CalculatorIcon,
  CalendarIcon,
  CameraIcon,
  CatIcon,
  ChartLineIcon,
  CodeIcon,
  CoffeeIcon,
  DatabaseIcon,
  DramaIcon,
  DumbbellIcon,
  FeatherIcon,
  FilmIcon,
  FlaskConicalIcon,
  GavelIcon,
  GlobeIcon,
  GraduationCapIcon,
  HammerIcon,
  HeartPulseIcon,
  ImageIcon,
  LandmarkIcon,
  LanguagesIcon,
  LeafIcon,
  LightbulbIcon,
  MailIcon,
  MapIcon,
  MessageCircleIcon,
  MicroscopeIcon,
  MusicIcon,
  NewspaperIcon,
  PaletteIcon,
  PenLineIcon,
  PillIcon,
  PlaneIcon,
  PuzzleIcon,
  RocketIcon,
  ScaleIcon,
  ScanIcon,
  ScrollTextIcon,
  SearchIcon,
  ShieldIcon,
  ShoppingBagIcon,
  ShoppingCartIcon,
  SparklesIcon,
  SquareTerminalIcon,
  StethoscopeIcon,
  TargetIcon,
  TelescopeIcon,
  UtensilsIcon,
  WalletIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { createElement } from "react";
import type { SkillCategory } from "@/protocol/constants";

export const AGENT_ICONS: Record<string, LucideIcon> = {
  bot: BotIcon,
  sparkles: SparklesIcon,
  brain: BrainIcon,
  lightbulb: LightbulbIcon,
  feather: FeatherIcon,
  "pen-line": PenLineIcon,
  "book-open": BookOpenIcon,
  "graduation-cap": GraduationCapIcon,
  languages: LanguagesIcon,
  "message-circle": MessageCircleIcon,
  mail: MailIcon,
  newspaper: NewspaperIcon,
  code: CodeIcon,
  "square-terminal": SquareTerminalIcon,
  bug: BugIcon,
  database: DatabaseIcon,
  "chart-line": ChartLineIcon,
  calculator: CalculatorIcon,
  wallet: WalletIcon,
  briefcase: BriefcaseIcon,
  scale: ScaleIcon,
  gavel: GavelIcon,
  landmark: LandmarkIcon,
  "building-2": Building2Icon,
  stethoscope: StethoscopeIcon,
  "heart-pulse": HeartPulseIcon,
  pill: PillIcon,
  scan: ScanIcon,
  microscope: MicroscopeIcon,
  "flask-conical": FlaskConicalIcon,
  telescope: TelescopeIcon,
  globe: GlobeIcon,
  plane: PlaneIcon,
  map: MapIcon,
  camera: CameraIcon,
  image: ImageIcon,
  palette: PaletteIcon,
  brush: BrushIcon,
  music: MusicIcon,
  film: FilmIcon,
  drama: DramaIcon,
  puzzle: PuzzleIcon,
  calendar: CalendarIcon,
  "shopping-cart": ShoppingCartIcon,
  utensils: UtensilsIcon,
  coffee: CoffeeIcon,
  dumbbell: DumbbellIcon,
  leaf: LeafIcon,
  baby: BabyIcon,
  cat: CatIcon,
  target: TargetIcon,
  rocket: RocketIcon,
  zap: ZapIcon,
  shield: ShieldIcon,
  wrench: WrenchIcon,
  hammer: HammerIcon,
  search: SearchIcon,
};

export const AGENT_ICON_NAMES = Object.keys(AGENT_ICONS);

/** Unknown or empty names (another app version) fall back to the robot. */
export function agentIcon(name: string | null | undefined): LucideIcon {
  return (name && AGENT_ICONS[name]) || BotIcon;
}

/** The icon itself (looked up in the fixed table above, never made up during render). */
export function AgentGlyph({ name, className }: { name: string | null | undefined; className?: string }) {
  return createElement(agentIcon(name), className ? { className } : {});
}

/** A skill category's icon in its colour; no category: a scroll. */
export function CategoryGlyph({ category, className }: { category: string; className?: string }) {
  const meta = SKILL_CATEGORY_META[category as SkillCategory];
  return createElement(meta?.icon ?? ScrollTextIcon, { className: [className, meta?.color ?? "text-muted-foreground"].filter(Boolean).join(" ") });
}

export interface CategoryMeta {
  icon: LucideIcon;
  /** Tailwind text colour of the icon. */
  color: string;
}

export const SKILL_CATEGORY_META: Record<SkillCategory, CategoryMeta> = {
  ideas: { icon: LightbulbIcon, color: "text-amber-500" },
  travel: { icon: PlaneIcon, color: "text-orange-500" },
  learning: { icon: GraduationCapIcon, color: "text-sky-500" },
  writing: { icon: PenLineIcon, color: "text-violet-500" },
  shopping: { icon: ShoppingBagIcon, color: "text-fuchsia-500" },
  code: { icon: SquareTerminalIcon, color: "text-rose-500" },
  misc: { icon: BoxIcon, color: "text-blue-500" },
  roleplay: { icon: DramaIcon, color: "text-red-500" },
  finance: { icon: ChartLineIcon, color: "text-orange-600" },
};
