// Who makes a model, from its name: the library family (before ":" and after "namespace/") is
// matched against a fixed table, for the logo next to the name. Brand marks are used to identify
// the models (nominative use); the SVGs come from @lobehub/icons-static-svg (MIT) and only the
// ones listed here reach the bundle. A name that matches nothing gets no maker (generic icon).

import ai2 from "@lobehub/icons-static-svg/icons/ai2-color.svg";
import baai from "@lobehub/icons-static-svg/icons/baai.svg";
import cohere from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import dolphin from "@lobehub/icons-static-svg/icons/dolphin.svg";
import google from "@lobehub/icons-static-svg/icons/google-color.svg";
import huggingface from "@lobehub/icons-static-svg/icons/huggingface-color.svg";
import ibm from "@lobehub/icons-static-svg/icons/ibm.svg";
import internlm from "@lobehub/icons-static-svg/icons/internlm-color.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import lg from "@lobehub/icons-static-svg/icons/lg-color.svg";
import liquid from "@lobehub/icons-static-svg/icons/liquid.svg";
import meta from "@lobehub/icons-static-svg/icons/meta-color.svg";
import microsoft from "@lobehub/icons-static-svg/icons/microsoft-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import nous from "@lobehub/icons-static-svg/icons/nousresearch.svg";
import nvidia from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import snowflake from "@lobehub/icons-static-svg/icons/snowflake-color.svg";
import stability from "@lobehub/icons-static-svg/icons/stability-color.svg";
import tii from "@lobehub/icons-static-svg/icons/tii-color.svg";
import upstage from "@lobehub/icons-static-svg/icons/upstage-color.svg";
import xai from "@lobehub/icons-static-svg/icons/xai.svg";
import yi from "@lobehub/icons-static-svg/icons/yi-color.svg";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg";

export type MakerId =
  | "meta"
  | "google"
  | "alibaba"
  | "deepseek"
  | "mistral"
  | "microsoft"
  | "openai"
  | "cohere"
  | "ibm"
  | "nvidia"
  | "huggingface"
  | "zhipu"
  | "moonshot"
  | "tii"
  | "ai2"
  | "stability"
  | "upstage"
  | "01ai"
  | "lg"
  | "liquid"
  | "nous"
  | "baai"
  | "snowflake"
  | "internlm"
  | "minimax"
  | "xai"
  | "dolphin";

export interface Maker {
  id: MakerId;
  name: string;
  /** URL of the logo (SVG). */
  icon: string;
}

export const MAKERS: Record<MakerId, Maker> = {
  meta: { id: "meta", name: "Meta", icon: meta },
  google: { id: "google", name: "Google", icon: google },
  alibaba: { id: "alibaba", name: "Alibaba (Qwen)", icon: qwen },
  deepseek: { id: "deepseek", name: "DeepSeek", icon: deepseek },
  mistral: { id: "mistral", name: "Mistral AI", icon: mistral },
  microsoft: { id: "microsoft", name: "Microsoft", icon: microsoft },
  openai: { id: "openai", name: "OpenAI", icon: openai },
  cohere: { id: "cohere", name: "Cohere", icon: cohere },
  ibm: { id: "ibm", name: "IBM", icon: ibm },
  nvidia: { id: "nvidia", name: "NVIDIA", icon: nvidia },
  huggingface: { id: "huggingface", name: "Hugging Face", icon: huggingface },
  zhipu: { id: "zhipu", name: "Zhipu AI", icon: zhipu },
  moonshot: { id: "moonshot", name: "Moonshot AI", icon: kimi },
  tii: { id: "tii", name: "TII", icon: tii },
  ai2: { id: "ai2", name: "Ai2", icon: ai2 },
  stability: { id: "stability", name: "Stability AI", icon: stability },
  upstage: { id: "upstage", name: "Upstage", icon: upstage },
  "01ai": { id: "01ai", name: "01.AI", icon: yi },
  lg: { id: "lg", name: "LG AI Research", icon: lg },
  liquid: { id: "liquid", name: "Liquid AI", icon: liquid },
  nous: { id: "nous", name: "Nous Research", icon: nous },
  baai: { id: "baai", name: "BAAI", icon: baai },
  snowflake: { id: "snowflake", name: "Snowflake", icon: snowflake },
  internlm: { id: "internlm", name: "InternLM", icon: internlm },
  minimax: { id: "minimax", name: "MiniMax", icon: minimax },
  xai: { id: "xai", name: "xAI", icon: xai },
  dolphin: { id: "dolphin", name: "Cognitive Computations", icon: dolphin },
};

// First match wins: fine-tunes and derivatives before the base families they mention.
const RULES: readonly (readonly [RegExp, MakerId])[] = [
  [/^dolphin/, "dolphin"],
  [/^(nous-hermes|hermes)/, "nous"],
  [/^(wizardlm|wizardcoder|wizard-math)/, "microsoft"],
  [/^(nemotron|llama3-chatqa|minitron)/, "nvidia"],
  [/^(llama|codellama|meta-llama)/, "meta"],
  [/gemma/, "google"],
  [/^(qwen|qwq|codeqwen|marco-o1)/, "alibaba"],
  [/^deepseek/, "deepseek"],
  [/^(mistral|mixtral|codestral|mathstral|devstral|magistral|ministral|pixtral|voxtral)/, "mistral"],
  [/^(phi|orca)/, "microsoft"],
  [/^gpt-oss/, "openai"],
  [/^(command-|aya)/, "cohere"],
  [/^granite/, "ibm"],
  [/^(smollm|smolvlm|zephyr|starcoder|bloom)/, "huggingface"],
  [/^(glm|codegeex|chatglm)/, "zhipu"],
  [/^kimi/, "moonshot"],
  [/^falcon/, "tii"],
  [/^(olmo|tulu|molmo)/, "ai2"],
  [/^stable/, "stability"],
  [/^solar/, "upstage"],
  [/^yi(-|$)/, "01ai"],
  [/^exaone/, "lg"],
  [/^lfm/, "liquid"],
  [/^bge-/, "baai"],
  [/^snowflake-arctic/, "snowflake"],
  [/^internlm/, "internlm"],
  [/^minimax/, "minimax"],
  [/^grok/, "xai"],
];

/** "ns/llama3.2:3b" → "llama3.2" (lower-case). */
export function familyOf(model: string): string {
  const noTag = model.split(":")[0] ?? "";
  const parts = noTag.split("/");
  return (parts[parts.length - 1] ?? "").trim().toLowerCase();
}

export function makerOf(model: string): Maker | null {
  const family = familyOf(model);
  if (!family) return null;
  for (const [re, id] of RULES) if (re.test(family)) return MAKERS[id];
  return null;
}
