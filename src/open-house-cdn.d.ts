declare module 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/harness.js' {
  export const STEPS: string[];
  export const VERSION: number;
  export const RELEASE: string;
  export const OUTPUT_KEY: Record<string, string>;
  export function runHarness(opts: {
    photos?: Array<File | Blob | string | { id?: string; name?: string; type?: string; dataUrl: string }>;
    resume?: any;
    fromStep?: string;
    callModel: (args: any) => Promise<any>;
    callImage: (args: any) => Promise<Blob>;
    captureStops?: (args: { state: any }) => Promise<Array<{ photoId: string; room: string; image: string }>>;
    tts?: (text: string, meta?: any) => Promise<Blob>;
    onProgress?: (event: any, state: any) => void;
    options?: {
      maxRetries?: number;
      judgeThreshold?: number;
      modelImageMaxSide?: number;
      judgeTour?: boolean;
    };
    prompts?: Record<string, string>;
    schemas?: Record<string, any>;
  }): Promise<any>;
  export function finalImageFor(state: any, photoId: string): string | null;
}

declare module 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/adapters/gemini.js' {
  export function makeGeminiCallers(opts: {
    ai: any;
    textModel?: string;
    imageModel?: string | string[];
    thinkingLevel?: 'low' | 'medium' | 'high';
    thinkingLevels?: Record<string, 'low' | 'medium' | 'high'>;
    transportRetries?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    log?: (event: any) => void;
  }): {
    callModel: (args: any) => Promise<string>;
    callImage: (args: any) => Promise<Blob>;
  };
}

declare module 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/viewer/viewer.js' {
  export function createViewer(opts: {
    container: HTMLElement;
    layout: any;
    spec?: any;
    narration?: any;
    images?: Record<string, string>;
    order?: string[];
    report?: any;
    options?: {
      sun?: 'golden' | 'day';
      quality?: 'high' | 'low';
      environment?: string;
      autoplayMs?: number;
      glideMs?: number;
      showControls?: boolean;
    };
  }): {
    el: HTMLElement;
    renderer: any;
    scene: any;
    camera: any;
    stops: any[];
    goTo: (index: number) => void;
    next: () => void;
    prev: () => void;
    play: () => void;
    pause: () => void;
    setPhotoreal: (on: boolean) => void;
    setSun: (mode: 'golden' | 'day') => void;
    setImages: (map: Record<string, string>) => void;
    setNarration: (narration: any) => void;
    setReport: (report: any) => void;
    showMade: (open?: boolean) => void;
    captureStops: (opts?: { width?: number; height?: number }) => Promise<Array<{ photoId: string; room: string; image: string }>>;
    resize: (w?: number, h?: number) => void;
    dispose: () => void;
    debug: () => any;
    readonly index: number;
    readonly photoreal: boolean;
    readonly quality: string;
    readonly environment: string;
  };
}

declare module 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/report.js' {
  export function buildReport(state: any): {
    runId: string | null;
    generatedAt: string;
    source: string;
    steps: Array<{
      step: string;
      calls: number;
      modelCalls: number;
      imageCalls: number;
      retries: number;
      failed: number;
      redos: number;
      ms: number;
    }>;
    photos: Array<{
      photoId: string;
      calls: number;
      modelCalls: number;
      imageCalls: number;
      retries: number;
      failed: number;
      scores: number[];
      firstScore: number | null;
      score: number | null;
      tourScore: number | null;
      redone: boolean;
      defects: Array<{ kind: string; severity: string | null; detail: string }>;
    }>;
    totals: {
      calls: number;
      modelCalls: number;
      imageCalls: number;
      retries: number;
      failed: number;
      redoCalls: number;
      photosRedone: number;
      photos: number;
      ms: number;
      meanScore: number | null;
      meanTourScore: number | null;
      threshold: number | null;
      firstCall: string | null;
      lastCall: string | null;
    };
  };
  export function reportMarkdown(report: any): string;
}

declare module 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/export.js' {
  export function downloadTour(state: any, opts?: { title?: string; inlineVendor?: boolean }): Promise<{
    html: string;
    filename: string;
    inlined: boolean;
    bytes: number;
    trace: number;
  }>;
  export function downloadTrace(state: any): {
    json: string;
    filename: string;
    entries: number;
  };
  export function downloadReport(state: any): {
    report: any;
    markdown: string;
    filename: string;
  };
  export function buildTourHtml(state: any, opts?: { title?: string; inlineVendor?: boolean }): Promise<{
    html: string;
    filename: string;
    inlined: boolean;
    bytes: number;
    trace: number;
  }>;
  export function traceJson(state: any): {
    json: string;
    filename: string;
    entries: number;
  };
  export function reportFiles(state: any): {
    report: any;
    markdown: string;
    filename: string;
  };
}
