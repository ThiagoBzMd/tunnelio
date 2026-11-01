// Chat: thread + composer, with the device picker, the thinking toggle and the model menu in the
// row under the box (desktop) or, on a phone, a model pill inside the box that opens a sheet with
// all three (ModelSheet.tsx). A conversation is bound to one device at creation time; the tray keeps its
// history (SPEC §9) — except an anonymous one (the ghost, top right of a new chat): `mode:
// "incognito"`, nothing is written on the computer and the shell draws the anonymous frame. A new
// chat shows the greeting: on a phone high on the screen with the composer at the bottom, on a
// desktop greeting and composer together in the middle. An agent (the sliders button next to "+")
// brings its model, settings, thinking and instructions; a new chat with one shows the agent
// instead of the greeting (SPEC §9.4). With an agent chain (rev. 1.9) the last agent of the chain
// answers with its model and settings, after the earlier ones (stores/chain.ts).

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Loader2Icon } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { startIncognitoChat } from "@/app/actions";
import { resolveConversation } from "@/app/conversations";
import { Composer, type ImageSupport } from "@/components/chat/Composer";
import { ConversationTitle } from "@/components/chat/ConversationTitle";
import { AgentIntro, Greeting, IncognitoButton } from "@/components/chat/EmptyChat";
import { MessageList } from "@/components/chat/MessageList";
import { ModelMenu } from "@/components/chat/ModelMenu";
import { ModelSheet } from "@/components/chat/ModelSheet";
import { DevicePicker } from "@/components/chat/Pickers";
import { ThinkToggle } from "@/components/chat/ThinkToggle";
import { SetupChips, ToolsMenu } from "@/components/chat/ToolsMenu";
import { useChatAgent } from "@/components/chat/useChatAgent";
import { ScreenHeader } from "@/components/layout/ScreenHeader";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { composeMessage } from "@/lib/documents/compose";
import type { ExtractedDocument } from "@/lib/documents/types";
import { hasCustomOptions } from "@/lib/model-options";
import { useWide } from "@/lib/useWide";
import { LIMITS } from "@/protocol/constants";
import { ChatSendError, chatStore, toWire, validateSend } from "@/stores/chat";
import { modelsStore, selectSupportsVision } from "@/stores/models";
import { useAuth, useChat, useDevices, useModels, useSessions, useSettings, useUi } from "@/stores/react";
import { settingsStore } from "@/stores/settings";
import { uiStore } from "@/stores/ui";

export function ChatScreen() {
  const { t } = useT();
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const wide = useWide();

  const conversations = useChat((s) => s.conversations);
  const streaming = useChat((s) => s.streaming);
  const chatError = useChat((s) => s.error);
  const devices = useDevices((s) => s.devices);
  const order = useDevices((s) => s.order);
  const devicesLoaded = useDevices((s) => s.loaded);
  const sessions = useSessions((s) => s.sessions);
  const settings = useSettings((s) => s.settings);
  const pairingsKeyPresent = useAuth((s) => s.pairingsKeyPresent);

  const conv = conversationId ? conversations[conversationId] : undefined;
  // Resolution state keyed by the route param; reset during render when the param changes.
  const [resolve, setResolve] = useState<{ id: string | undefined; resolving: boolean; notFound: boolean }>({ id: conversationId, resolving: Boolean(conversationId), notFound: false });
  if (resolve.id !== conversationId) setResolve({ id: conversationId, resolving: Boolean(conversationId), notFound: false });
  const resolving = resolve.resolving;
  const notFound = resolve.notFound;

  // Deep link / reload: load the conversation from the device (the tray's history).
  useEffect(() => {
    if (!conversationId) {
      chatStore.getState().select(null);
      return;
    }
    let cancelled = false;
    resolveConversation(conversationId)
      .then((ok) => {
        if (cancelled) return;
        if (ok) chatStore.getState().select(conversationId);
        setResolve({ id: conversationId, resolving: false, notFound: !ok });
      })
      .catch(() => {
        if (!cancelled) setResolve({ id: conversationId, resolving: false, notFound: true });
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Device/model for a NEW conversation; locked to the conversation otherwise.
  const pairedOnline = useMemo(() => order.filter((id) => devices[id]?.paired && devices[id]?.online), [order, devices]);
  const draftDevice = settings.default_device_id && devices[settings.default_device_id] ? settings.default_device_id : (pairedOnline[0] ?? order[0] ?? null);
  const deviceId = conv ? conv.device_id : draftDevice;
  const device = deviceId ? devices[deviceId] : undefined;
  const [model, setModel] = useState<string | null>(null);
  const reachable = Boolean(device?.paired && device.online);
  const chatAgent = useChatAgent(conv, deviceId, reachable);
  const agent = chatAgent.agent;
  // An agent brings its own model (and its settings and thinking).
  // The agent that writes the reply: the last of the chain, else the chat's agent.
  const replying = chatAgent.final;
  const currentModel = replying ? replying.model : conv ? (model ?? conv.model) : (model ?? settings.default_model);
  // Anonymous mode: the draft flag (the ghost) until the conversation exists, then its own.
  const incognitoDraft = useUi((s) => s.incognitoDraft);
  const incognito = conv ? Boolean(conv.incognito) : incognitoDraft;
  useEffect(() => {
    uiStore.getState().setIncognitoFrame(incognito);
    return () => uiStore.getState().setIncognitoFrame(false);
  }, [incognito]);

  // Load the model list of the active device once it is reachable.
  const session = deviceId ? sessions[deviceId] : undefined;
  useEffect(() => {
    if (!deviceId || !device?.paired || !device.online) return;
    void modelsStore.getState().list(deviceId).then((list) => {
      if (!model && list.length > 0 && !settings.default_model) setModel(list[0]?.name ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, device?.paired, device?.online]);

  const sessionStatus = session?.status ?? "idle";
  // If the first list failed (e.g. handshake retry) and the session is ready now, list again.
  const modelsEntry = useModels((s) => (deviceId ? s.byDevice[deviceId] : undefined));
  useEffect(() => {
    if (deviceId && sessionStatus === "ready" && !modelsEntry?.loading && modelsEntry?.loaded_at == null) {
      void modelsStore.getState().list(deviceId).catch(() => undefined);
    }
  }, [deviceId, sessionStatus, modelsEntry?.loading, modelsEntry?.loaded_at]);
  // show_model (fetched once per device+model, cached): "vision" and `context_length`.
  // Images: the device must forward them ("images" capability) AND the model must see.
  const deviceImages = session?.device_info ? session.device_info.capabilities.includes("images") : null;
  const incognitoSupported = Boolean(session?.device_info?.capabilities.includes("incognito"));
  const vision = useModels((s) => (deviceId && currentModel ? selectSupportsVision(s, deviceId, currentModel) : null));
  const contextMax = useModels((s) => (deviceId && currentModel ? (s.byDevice[deviceId]?.info[currentModel]?.context_length ?? null) : null));
  // `think` is only sent to models that advertise it (Ollama rejects it on the others); the
  // per-model settings (SPEC §8.3) travel as `options` when the user set any.
  const canThink = useModels((s) => Boolean(deviceId && currentModel && s.byDevice[deviceId]?.info[currentModel]?.capabilities?.includes("thinking")));
  const storedOptions = useSettings((s) => (currentModel ? s.settings.model_options[currentModel] : undefined));
  const modelOptions = replying ? replying.options : storedOptions;
  const think = replying ? (replying.think ?? false) : settings.think;
  useEffect(() => {
    if (!deviceId || !currentModel || sessionStatus !== "ready") return;
    if (modelsStore.getState().byDevice[deviceId]?.info[currentModel]) return;
    void modelsStore.getState().show(deviceId, currentModel);
  }, [deviceId, currentModel, sessionStatus]);
  const imageSupport: ImageSupport = deviceImages === false ? "hidden" : deviceImages === null || vision === null ? "checking" : vision ? "enabled" : "disabled";
  const canSee: boolean | null = imageSupport === "enabled" ? true : imageSupport === "checking" ? null : false;
  const maxImages = Math.min(LIMITS.MAX_IMAGES_PER_MESSAGE, session?.device_info?.limits.max_images_per_message ?? LIMITS.MAX_IMAGES_PER_MESSAGE);
  const historyChars = useMemo(() => (conv ? toWire(conv.messages).reduce((n, m) => n + m.content.length, 0) : 0), [conv]);

  const ollamaStatus = session?.device_info?.ollama.status;
  let disabledReason: string | null = null;
  if (!devicesLoaded) disabledReason = t("common.loading");
  else if (!deviceId) disabledReason = t("chat.noDevices");
  else if (!device?.paired) disabledReason = pairingsKeyPresent ? t("chat.deviceNotPaired") : t("chat.deviceNotPairedUnlock");
  else if (!device.online) disabledReason = t("chat.deviceOffline", { name: device.name });
  else if (sessionStatus === "needs-pairing") disabledReason = t("chat.needsPairing");
  else if (sessionStatus === "error") disabledReason = session?.error?.message ?? t("chat.sessionError");
  else if (ollamaStatus && ollamaStatus !== "running") disabledReason = t("chat.ollamaNotRunning");
  else if (!currentModel) disabledReason = t("chat.pickModelFirst");
  else if (chatAgent.missingAgent) disabledReason = t("agents.modelMissing", { agent: chatAgent.missingAgent.name, model: chatAgent.missingAgent.model, device: device.name });

  useEffect(() => {
    if (chatError) {
      toast.error(chatError);
      chatStore.getState().clearError();
    }
  }, [chatError]);

  /** Compose (documents → blocks + page images), check, then stream. False keeps the draft. */
  const send = async (text: string, photos: string[], documents: ExtractedDocument[]): Promise<boolean> => {
    if (!deviceId || !currentModel) return false;
    let content = text;
    let images = photos;
    if (documents.length > 0) {
      try {
        const composed = await composeMessage(text, photos, documents, { vision: canSee === true, maxImages });
        content = composed.content;
        images = composed.images;
      } catch {
        toast.error(t("chat.docFailed", { name: documents[0]?.name ?? "" }));
        return false;
      }
    }
    try {
      validateSend(conv?.messages ?? [], deviceId, currentModel, content, images, chatAgent.finalSystem);
    } catch (e) {
      if (e instanceof ChatSendError) {
        if (e.code === "E_TOO_LONG") toast.error(documents.length > 0 ? t("chat.tooLongDoc") : t("chat.tooLongChat"));
        else if (e.code === "E_TOO_LARGE") toast.error(t("chat.tooLargeMessage"));
        else if (e.code !== "E_EMPTY") toast.error(e.message);
        return false;
      }
      throw e;
    }
    let id = conv?.id;
    if (!id) {
      const created = chatStore.getState().create({ device_id: deviceId, model: currentModel, ...(incognito ? { incognito: true } : {}) });
      id = created.id;
      navigate(`/chat/${id}`, { replace: true });
    } else if (conv && conv.model !== currentModel) {
      chatStore.getState().upsert({ ...conv, model: currentModel });
    }
    void chatStore
      .getState()
      .send(id, content, {
        ...(canThink ? { think } : {}),
        ...(chatAgent.finalSystem ? { system: chatAgent.finalSystem } : {}),
        ...(agent ? { agent_id: agent.id } : {}),
        ...(chatAgent.before.length > 0
          ? {
              chain: chatAgent.before.map(({ agent: a, system }) => ({
                agent_id: a.id,
                name: a.name,
                model: a.model,
                system,
                ...(a.options && hasCustomOptions(a.options) ? { options: a.options } : {}),
                ...(a.think !== undefined ? { think: a.think } : {}),
              })),
            }
          : {}),
        ...(chatAgent.chatSkillIds.length > 0 ? { skill_ids: chatAgent.chatSkillIds } : {}),
        ...(modelOptions && hasCustomOptions(modelOptions) ? { options: modelOptions } : {}),
        ...(images.length > 0 ? { images } : {}),
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
    return true;
  };

  const messages = conv?.messages ?? [];
  const isStreamingHere = Boolean(streaming && conv && streaming.conversation_id === conv.id);
  const loading = resolving && !conv;

  const empty = !loading && !notFound && messages.length === 0;

  const pickDevice = (id: string) => void settingsStore.getState().update({ default_device_id: id });
  const pickModel = (name: string) => {
    setModel(name);
    void settingsStore.getState().update({ default_model: name });
  };
  const setThink = (v: boolean) => void settingsStore.getState().update({ think: v });

  const composer = (
    <Composer
      key="composer"
      dashed={incognito}
      placeholder={messages.length === 0 ? t("chat.placeholderEmpty") : t("chat.placeholder")}
      leading={wide ? <DevicePicker value={deviceId} onChange={pickDevice} disabled={Boolean(conv)} /> : undefined}
      trailing={
        wide ? (
          <>
            {canThink && !agent ? <ThinkToggle think={settings.think} disabled={Boolean(disabledReason)} onChange={setThink} /> : null}
            <ModelMenu deviceId={deviceId} value={currentModel} disabled={Boolean(agent)} onChange={pickModel} />
          </>
        ) : undefined
      }
      tools={
        <>
          <ToolsMenu deviceId={deviceId} chat={chatAgent} disabled={!reachable || isStreamingHere} />
          {wide ? null : (
            <ModelSheet
              deviceId={deviceId}
              deviceLocked={Boolean(conv)}
              onDeviceChange={pickDevice}
              model={currentModel}
              onModelChange={pickModel}
              disabled={Boolean(agent)}
              think={canThink && !agent ? { on: settings.think, onChange: setThink } : null}
            />
          )}
          <SetupChips chat={chatAgent} disabled={isStreamingHere} />
        </>
      }
      disabled={Boolean(disabledReason)}
      disabledReason={disabledReason}
      streaming={isStreamingHere}
      stalled={Boolean(streaming?.stalled) && isStreamingHere}
      images={imageSupport}
      dictation={settings.dictation}
      vision={canSee}
      historyChars={historyChars}
      contextMax={contextMax}
      onSend={send}
      onStop={() => void chatStore.getState().abort()}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-screen">
      <ScreenHeader actions={!conv && !incognito ? <IncognitoButton supported={incognitoSupported} onStart={() => startIncognitoChat(navigate)} /> : undefined}>
        {conv && !conv.incognito ? <ConversationTitle conv={conv} /> : null}
      </ScreenHeader>

      {/* One parent for every state, the composer always its second child: it never remounts. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", empty && "md:justify-center md:pb-[10vh]")}>
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" />
          </div>
        ) : notFound ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="font-medium">{t("chat.notFound")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{t("chat.notFoundHint")}</p>
            <Button variant="outline" asChild>
              <Link to="/">{t("chat.new")}</Link>
            </Button>
          </div>
        ) : empty && agent ? (
          <AgentIntro icon={agent.icon} name={agent.name} description={agent.description} hint={null} />
        ) : empty ? (
          <Greeting incognito={incognito} hint={deviceId ? null : t("chat.emptyHintNoDevice")} />
        ) : (
          <MessageList messages={messages} streaming={isStreamingHere} />
        )}
        {composer}
        {empty && incognito ? (
          <p className="mx-auto max-w-md px-6 pb-4 text-center text-[13px] text-muted-foreground" data-testid="incognito-hint">
            {t("chat.incognitoHint")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

