// Minimal typing for the jsdom API used by tests/conversations-settings.test.tsx (no @types/jsdom).
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { pretendToBeVisual?: boolean; url?: string });
    readonly window: Window & typeof globalThis;
  }
}
