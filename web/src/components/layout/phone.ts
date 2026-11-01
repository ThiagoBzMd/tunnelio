// The phone look (below the `md` breakpoint): header buttons become soft round buttons, pickers
// become pills and bottom sheets. Desktop classes are untouched.

/** A header button that turns into a round button on a soft background on a phone. */
export const phoneRoundButton =
  "max-md:size-10 max-md:rounded-full max-md:bg-muted/80 max-md:text-foreground max-md:shadow-[0_1px_8px_rgba(0,0,0,0.06)] max-md:hover:bg-muted max-md:[&_svg]:size-[22px]";

/** A round button on a phone-only surface (sheets, the settings page): no breakpoint needed. */
export const roundButton = "size-10 rounded-full bg-muted/80 text-foreground shadow-[0_1px_8px_rgba(0,0,0,0.06)] hover:bg-muted [&_svg]:size-[22px]";

/** The grey surface of a phone sheet or page; the white cards of rows sit on it. */
export const phoneSurface = "bg-sidebar dark:bg-background";
export const phoneCard = "overflow-hidden rounded-2xl bg-background dark:bg-card";

/** A row of a phone card: tall, a hairline between rows, an optional chevron at the end. */
export const phoneRow =
  "flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left text-[16px] transition-colors not-last:border-b not-last:border-border/70 hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0";

/** The small muted title above a phone card ("Account", "Appearance"). */
export const phoneCardLabel = "px-4 pt-3 pb-2 text-[14px] text-muted-foreground";
