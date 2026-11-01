// Per-model generation settings (temperature, top-p, top-k, max reply tokens, repeat penalty,
// seed): empty = the model's default; "Default" forgets everything for the model. Values are
// checked against SPEC §8.3 before they are kept, so the tray never sees an invalid one.

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { useSettings } from "@/stores/react";
import { settingsStore } from "@/stores/settings";
import { ModelOptionFields, OPTION_LABEL, optionTexts, readOptionFields, type OptionTexts } from "./ModelOptionFields";

export function ModelOptionsDialog({ model, open, onOpenChange }: { model: string; open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="model-options-dialog">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{t("models.optionsTitle", { model })}</DialogTitle>
          <DialogDescription>{t("models.optionsHint")}</DialogDescription>
        </DialogHeader>
        {open ? <Form key={model} model={model} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Form({ model, onClose }: { model: string; onClose(): void }) {
  const { t } = useT();
  const stored = useSettings((s) => s.settings.model_options[model]);
  const [values, setValues] = useState<OptionTexts>(() => optionTexts(stored));

  const save = async () => {
    const read = readOptionFields(values);
    if ("invalid" in read) {
      toast.error(t("models.optionsInvalid", { field: t(OPTION_LABEL[read.invalid.key]), min: read.invalid.min, max: read.invalid.max }));
      return;
    }
    await settingsStore.getState().setModelOptions(model, read.options);
    toast.success(Object.keys(read.options).length > 0 ? t("models.optionsSaved") : t("models.optionsReset"));
    onClose();
  };
  const reset = async () => {
    await settingsStore.getState().setModelOptions(model, null);
    toast.success(t("models.optionsReset"));
    onClose();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-3"
    >
      <ModelOptionFields values={values} onChange={setValues} />
      <DialogFooter className="gap-2 sm:justify-between">
        <Button type="button" variant="outline" onClick={() => void reset()} data-testid="model-options-default">
          {t("models.optionsDefault")}
        </Button>
        <Button type="submit" data-testid="model-options-save">
          {t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}
