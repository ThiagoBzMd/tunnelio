// The six generation settings as text fields (empty = the model's own default), shared by the
// model settings window and the agent editor. Values are checked with `readOptionFields` before
// they are kept, so the computer never sees an invalid one (SPEC §8.3).

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT, type TKey } from "@/i18n";
import { MODEL_OPTION_FIELDS, parseOptionInput, type ModelOptionKey, type ModelOptions } from "@/lib/model-options";

export const OPTION_LABEL: Record<ModelOptionKey, TKey> = {
  temperature: "models.temperature",
  top_p: "models.topP",
  top_k: "models.topK",
  num_predict: "models.numPredict",
  repeat_penalty: "models.repeatPenalty",
  seed: "models.seed",
};
const HINT: Record<ModelOptionKey, TKey> = {
  temperature: "models.temperatureHint",
  top_p: "models.topPHint",
  top_k: "models.topKHint",
  num_predict: "models.numPredictHint",
  repeat_penalty: "models.repeatPenaltyHint",
  seed: "models.seedHint",
};

export type OptionTexts = Record<ModelOptionKey, string>;

export function optionTexts(options: ModelOptions | undefined): OptionTexts {
  const out = {} as OptionTexts;
  for (const f of MODEL_OPTION_FIELDS) out[f.key] = options?.[f.key] !== undefined ? String(options[f.key]) : "";
  return out;
}

/** The texts as options, or the first field that is out of range. */
export function readOptionFields(texts: OptionTexts): { options: ModelOptions } | { invalid: (typeof MODEL_OPTION_FIELDS)[number] } {
  const options: ModelOptions = {};
  for (const f of MODEL_OPTION_FIELDS) {
    const parsed = parseOptionInput(f, texts[f.key]);
    if (parsed === "invalid") return { invalid: f };
    if (parsed !== null) options[f.key] = parsed;
  }
  return { options };
}

export function ModelOptionFields({ values, onChange, idPrefix = "model-option", columns = 2 }: { values: OptionTexts; onChange(values: OptionTexts): void; idPrefix?: string; columns?: 2 | 3 }) {
  const { t } = useT();
  return (
    <div className={columns === 3 ? "grid grid-cols-2 gap-3 lg:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
      {MODEL_OPTION_FIELDS.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label htmlFor={`${idPrefix}-${f.key}`}>{t(OPTION_LABEL[f.key])}</Label>
          <Input
            id={`${idPrefix}-${f.key}`}
            value={values[f.key]}
            onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
            placeholder={t("models.optionsDefault").toLowerCase()}
            inputMode={f.integer ? "numeric" : "decimal"}
            autoComplete="off"
            className="font-mono"
            data-testid={`${idPrefix}-${f.key}`}
          />
          <p className="text-[11px] text-muted-foreground">{t(HINT[f.key])}</p>
        </div>
      ))}
    </div>
  );
}
