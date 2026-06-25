export type ModelTier = "flash" | "lite" | "nano" | "mini" | "pro" | "standard";
export type ModelVendor = "google" | "openai";

export interface ModelInfo {
  id: string;
  label: string;
  vendor: ModelVendor;
  tier: ModelTier;
  description: string;
  suggestedFor?: string[];
}

export const AI_MODELS: ModelInfo[] = [
  // Google Gemini
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)", vendor: "google", tier: "flash", description: "차세대 Gemini 프리뷰. 속도와 능력의 균형. 기본 모델.", suggestedFor: ["기본", "챗봇", "교수학습 설계"] },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", vendor: "google", tier: "lite", description: "비용 효율 3.1. 대량 분류·요약·추출에 적합." },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", vendor: "google", tier: "flash", description: "고효율 3.5. 코딩·추론·에이전트 워크플로." },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)", vendor: "google", tier: "pro", description: "차세대 강력 추론 프리뷰. 품질 우선." },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", vendor: "google", tier: "pro", description: "강력한 멀티모달과 복합 추론." },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", vendor: "google", tier: "flash", description: "균형형. Pro 대비 낮은 비용·지연." },
  { id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", vendor: "google", tier: "lite", description: "가장 빠르고 저렴한 2.5." },

  // OpenAI GPT (텍스트)
  { id: "openai/gpt-5", label: "GPT-5", vendor: "openai", tier: "standard", description: "강력한 올라운더. 정확성과 뉘앙스." },
  { id: "openai/gpt-5-mini", label: "GPT-5 Mini", vendor: "openai", tier: "mini", description: "저비용·범용 강세." },
  { id: "openai/gpt-5-nano", label: "GPT-5 Nano", vendor: "openai", tier: "nano", description: "빠르고 저렴. 단순/대량 작업." },
  { id: "openai/gpt-5.2", label: "GPT-5.2", vendor: "openai", tier: "standard", description: "복합 추론·문제 해결 강화." },
  { id: "openai/gpt-5.4", label: "GPT-5.4", vendor: "openai", tier: "standard", description: "고급 추론. 다단계 문제·코드·분석." },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini", vendor: "openai", tier: "mini", description: "GPT-5.4 축소판. 균형형." },
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano", vendor: "openai", tier: "nano", description: "GPT-5.4 최저가·최저지연." },
  { id: "openai/gpt-5.4-pro", label: "GPT-5.4 Pro", vendor: "openai", tier: "pro", description: "GPT-5.4 프리미엄 추론." },
  { id: "openai/gpt-5.5", label: "GPT-5.5", vendor: "openai", tier: "standard", description: "최상위 추론·코딩·지시 수행." },
  { id: "openai/gpt-5.5-pro", label: "GPT-5.5 Pro", vendor: "openai", tier: "pro", description: "GPT-5.5 확장 추론." },
];

export const DEFAULT_MODEL_ID = "google/gemini-3-flash-preview";
export const MAX_COMPARE_MODELS = 6;

export function getModelInfo(id: string): ModelInfo | undefined {
  return AI_MODELS.find((m) => m.id === id);
}

export function isValidModel(id: string): boolean {
  return AI_MODELS.some((m) => m.id === id);
}

export const VENDOR_LABEL: Record<ModelVendor, string> = {
  google: "Google",
  openai: "OpenAI",
};

export const TIER_LABEL: Record<ModelTier, string> = {
  flash: "Flash",
  lite: "Lite",
  nano: "Nano",
  mini: "Mini",
  pro: "Pro",
  standard: "표준",
};
