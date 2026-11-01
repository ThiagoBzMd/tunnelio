// The conversation's title at the top of the chat, with its menu: pin/unpin, delete.

import { useNavigate } from "react-router";
import { ChevronDownIcon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useT } from "@/i18n";
import type { Conversation } from "@/stores/chat";
import { historyStore } from "@/stores/history";
import { useSettings } from "@/stores/react";
import { settingsStore } from "@/stores/settings";

export function ConversationTitle({ conv }: { conv: Conversation }) {
  const { t } = useT();
  const navigate = useNavigate();
  const pinned = useSettings((s) => s.settings.pinned_conversations.includes(conv.id));
  const remove = async () => {
    if (!(await historyStore.getState().deletePrivate(conv.device_id, conv.id))) {
      toast.error(t("sidebar.deleteFailed"));
      return;
    }
    if (pinned) void settingsStore.getState().setPinned(conv.id, false);
    navigate("/");
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 max-w-[60vw] min-w-0 gap-1 rounded-lg px-2 text-[15px] font-normal md:max-w-[28rem]" aria-label={t("chat.conversationOptions")} data-testid="conversation-title">
          <span className="truncate">{conv.title || t("chat.untitled")}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuItem onSelect={() => void settingsStore.getState().setPinned(conv.id, !pinned)} data-testid="conversation-title-pin">
          {pinned ? <PinOffIcon /> : <PinIcon />}
          {pinned ? t("sidebar.unpin") : t("sidebar.pin")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void remove()} data-testid="conversation-title-delete">
          <Trash2Icon />
          {t("common.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
