// The maker's logo for a model name, on a white disc so coloured and black marks read on both
// themes; a neutral box when the maker is unknown (lib/makers.ts).

import { BoxIcon } from "lucide-react";
import { cn } from "cn";
import { makerOf } from "@/lib/makers";

export function MakerIcon({ model, className }: { model: string; className?: string }) {
  const maker = makerOf(model);
  return (
    <span
      className={cn("inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white ring-1 ring-black/10", className)}
      title={maker?.name}
      data-maker={maker?.id ?? "unknown"}
      aria-hidden
    >
      {maker ? <img src={maker.icon} alt="" className="size-[70%]" draggable={false} /> : <BoxIcon className="size-[60%] text-neutral-500" />}
    </span>
  );
}
