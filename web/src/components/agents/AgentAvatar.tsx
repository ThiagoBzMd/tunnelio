// An agent's icon in a round frame (the chat's empty screen, the menus, the editor), and a
// skill's category icon in its colour.

import { cn } from "cn";
import { AgentGlyph, CategoryGlyph } from "@/lib/agent-icons";

const SIZES = { sm: "size-6 [&_svg]:size-3.5", md: "size-9 [&_svg]:size-[18px]", lg: "size-14 [&_svg]:size-7" } as const;

export function AgentAvatar({ icon, size = "sm", className }: { icon: string | null | undefined; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full border bg-background text-foreground/80", SIZES[size], className)} aria-hidden>
      <AgentGlyph name={icon} />
    </span>
  );
}

export function SkillIcon({ category, className }: { category: string; className?: string }) {
  return <CategoryGlyph category={category} className={cn("size-4 shrink-0", className)} />;
}
