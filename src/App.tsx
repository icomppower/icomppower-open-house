/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI } from '@google/genai';
import {
  runHarness,
  STEPS,
  finalImageFor,
} from 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/harness.js';
import { makeGeminiCallers } from 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/adapters/gemini.js';
import { createViewer } from 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/viewer/viewer.js';
import {
  buildReport,
  reportMarkdown,
} from 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/report.js';
import {
  downloadTour,
  downloadTrace,
  downloadReport,
} from 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72/src/export.js';
import {
  Upload,
  Play,
  FileJson,
  Download,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  RotateCcw,
  Trash2,
  Eye,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Layers,
  Home,
  FileText,
  Activity,
} from 'lucide-react';

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/icomppower/open-house@3f38f72';

const STEP_DESCRIPTIONS: Record<string, string> = {
  prepare: 'Read photo dimensions and create model-sized copies (originals untouched)',
  ingest: 'Analyze photos into architectural spec.json (rooms, materials, objects, light)',
  layout: 'Place rooms in metres, levels, openings, furniture, and one camera per photo',
  enhance: 'Plan and render golden-hour staging edits for every photo while keeping structure intact',
  judge: 'Independent scoring (1–5) of every enhanced photo and 3D tour stop; auto-redo below threshold',
  narrate: 'Compose architectural walkthrough intro and one realtor line per room',
};

interface UploadedPhoto {
  id: string;
  name: string;
  file?: File;
  dataUrl: string;
}

interface LogEntry {
  id: string;
  at: string;
  step: string | null;
  type: string;
  message: string;
  photoId?: string | null;
  isError?: boolean;
  isRetry?: boolean;
}

function createBridgedGenAI() {
  const clientKey = process.env.GEMINI_API_KEY || 'server-proxy';
  const ai = new GoogleGenAI({ apiKey: clientKey });
  const origGenerateContent = ai.models.generateContent.bind(ai.models);

  ai.models.generateContent = async (params: any) => {
    try {
      const response = await fetch('/api/gemini/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await response.json();
        if (!response.ok) {
          const err: any = new Error(data.message || `Gemini API Error (${response.status})`);
          err.status = data.status || response.status;
          err.code = data.code;
          err.error = data.error;
          throw err;
        }
        return data as any;
      }
    } catch (err: any) {
      // If the error came directly from Gemini on the server, rethrow it immediately
      if (err && (err.status || err.code || err.error)) {
        throw err;
      }
      // Otherwise (e.g. static preview without Express route), fall back to direct SDK call
    }
    return origGenerateContent(params);
  };

  return ai;
}

function triggerJsonDownload(data: any, filename: string) {
  try {
    const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    console.error('Failed to trigger download:', filename, e);
  }
}

function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function App() {
  // Smoke test state
  const [smokeStatus, setSmokeStatus] = useState<'idle' | 'running' | 'ok' | 'error'>('idle');
  const [smokeOutput, setSmokeOutput] = useState<string>('');
  const [smokeMs, setSmokeMs] = useState<number | null>(null);

  // Photos & Upload state
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [loadingSamplePhotos, setLoadingSamplePhotos] = useState(false);

  // Harness & Pipeline state
  const [runState, setRunState] = useState<any | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isRecordedRun, setIsRecordedRun] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [checkpoints, setCheckpoints] = useState<Record<string, string>>({});
  const [resumeFromStep, setResumeFromStep] = useState<string>('judge');
  const [exportNote, setExportNote] = useState<string>('');
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({
    prepare: true,
    ingest: true,
    layout: true,
    enhance: true,
    judge: true,
    narrate: true,
  });

  // Viewer refs
  const viewerContainerRef = useRef<HTMLDivElement | null>(null);
  const viewerInstanceRef = useRef<any | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const savedRunInputRef = useRef<HTMLInputElement | null>(null);

  // Live timer tick while pipeline is running
  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => setNowTick(Date.now()), 250);
    return () => clearInterval(interval);
  }, [isRunning]);

  // Expose window.__oh for debugging / automated inspection
  useEffect(() => {
    (window as any).__oh = {
      get state() {
        return runState;
      },
      get viewer() {
        return viewerInstanceRef.current;
      },
      STEPS,
      logs,
    };
  }, [runState, logs]);

  const appendLog = (entry: Omit<LogEntry, 'id' | 'at'> & { at?: string }) => {
    setLogs((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        at: entry.at || new Date().toISOString(),
        ...entry,
      },
    ]);
  };

  // Mount or update the 3D viewer whenever layout / enhance / judge / narration changes
  const syncViewerWithState = (st: any) => {
    if (!st || !st.outputs || !st.outputs.layout || !viewerContainerRef.current) return;

    const imagesMap: Record<string, string> = {};
    if (st.inputs && Array.isArray(st.inputs.photos)) {
      for (const p of st.inputs.photos) {
        const img = finalImageFor(st, p.id);
        if (img) imagesMap[p.id] = img;
      }
    }

    const reportObj = Array.isArray(st.trace) && st.trace.length > 0 ? buildReport(st) : null;

    if (!viewerInstanceRef.current) {
      try {
        viewerInstanceRef.current = createViewer({
          container: viewerContainerRef.current,
          layout: st.outputs.layout,
          spec: st.outputs.spec || null,
          narration: st.outputs.narration || null,
          images: imagesMap,
          order: (st.inputs?.photos || []).map((p: any) => p.id),
          report: reportObj,
        });
      } catch (err: any) {
        appendLog({
          step: 'layout',
          type: 'viewer:error',
          message: `3D viewer initialization warning: ${err?.message || String(err)}`,
          isError: true,
        });
      }
    } else {
      try {
        viewerInstanceRef.current.setImages(imagesMap);
        if (st.outputs.narration) {
          viewerInstanceRef.current.setNarration(st.outputs.narration);
        }
        if (reportObj) {
          viewerInstanceRef.current.setReport(reportObj);
        }
      } catch (err) {
        console.warn('Viewer update warning:', err);
      }
    }
  };

  // Clean up viewer on unmount
  useEffect(() => {
    return () => {
      if (viewerInstanceRef.current) {
        try {
          viewerInstanceRef.current.dispose();
        } catch {
          // ignore
        }
        viewerInstanceRef.current = null;
      }
    };
  }, []);

  // Re-mount viewer when layout object changes
  useEffect(() => {
    if (runState?.outputs?.layout) {
      syncViewerWithState(runState);
    }
  }, [runState?.id, runState?.outputs?.layout, runState?.outputs?.enhance, runState?.outputs?.judge, runState?.outputs?.narration]);

  // ---------------------------------------------------------------------------
  // FIRST: Smoke test calling gemini-4-argon with responseMimeType: 'application/json' and thinkingLevel: 'low'
  // ---------------------------------------------------------------------------
  const handleSmokeTest = async () => {
    setSmokeStatus('running');
    setSmokeOutput('Calling gemini-4-argon (responseMimeType: "application/json", thinkingLevel: "low")...');
    setSmokeMs(null);
    const t0 = performance.now();

    try {
      const ai = createBridgedGenAI();
      const res = await ai.models.generateContent({
        model: 'gemini-4-argon',
        contents: 'Return only the JSON object {"ok":true}',
        config: {
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingLevel: 'low' as any },
        },
      });
      const elapsed = Math.round(performance.now() - t0);
      setSmokeMs(elapsed);
      const rawText = typeof (res as any).text === 'function' ? (res as any).text() : res.text;
      setSmokeOutput(
        typeof rawText === 'string' && rawText.trim()
          ? rawText
          : JSON.stringify(res, null, 2)
      );
      setSmokeStatus('ok');
    } catch (err: any) {
      const elapsed = Math.round(performance.now() - t0);
      setSmokeMs(elapsed);
      const errorDetail = {
        message: err?.message || String(err),
        status: err?.status ?? null,
        code: err?.code ?? null,
        error: err?.error ?? null,
        stack: err?.stack ?? null,
      };
      setSmokeOutput(JSON.stringify(errorDetail, null, 2));
      setSmokeStatus('error');
    }
  };

  // ---------------------------------------------------------------------------
  // Photo Picker & Sample Photos
  // ---------------------------------------------------------------------------
  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files ? Array.from(e.target.files) : [];
    if (!fileList.length) return;

    const loaded: UploadedPhoto[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const dataUrl = await fileToDataUrl(f);
      loaded.push({
        id: `p${photos.length + i + 1}`,
        name: f.name,
        file: f,
        dataUrl,
      });
    }

    setPhotos((prev) =>
      [...prev, ...loaded].map((item, idx) => ({
        ...item,
        id: `p${idx + 1}`,
      }))
    );
    e.target.value = '';
  };

  const handleRemovePhoto = (index: number) => {
    setPhotos((prev) =>
      prev
        .filter((_, idx) => idx !== index)
        .map((item, idx) => ({ ...item, id: `p${idx + 1}` }))
    );
  };

  const handleLoadSamplePhotos = async () => {
    setLoadingSamplePhotos(true);
    try {
      const manifestRes = await fetch(`${CDN_BASE}/fixtures/manifest.json`);
      const manifest = await manifestRes.json();
      const loaded: UploadedPhoto[] = [];
      for (let i = 0; i < manifest.photos.length; i++) {
        const entry = manifest.photos[i];
        const imgRes = await fetch(`${CDN_BASE}/fixtures/${entry.file}`);
        const blob = await imgRes.blob();
        const dataUrl = await fileToDataUrl(blob);
        loaded.push({
          id: entry.id || `p${i + 1}`,
          name: entry.file.split('/').pop() || `p${i + 1}.jpg`,
          dataUrl,
        });
      }
      setPhotos(loaded);
    } catch (err: any) {
      appendLog({
        step: null,
        type: 'sample:error',
        message: `Could not load sample photos: ${err?.message || String(err)}`,
        isError: true,
      });
    } finally {
      setLoadingSamplePhotos(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Load Saved Run (without calling the model)
  // ---------------------------------------------------------------------------
  const applyLoadedState = (loaded: any) => {
    if (viewerInstanceRef.current) {
      try {
        viewerInstanceRef.current.dispose();
      } catch {
        // ignore
      }
      viewerInstanceRef.current = null;
    }

    setIsRecordedRun(true);
    setRunState(loaded);

    if (loaded?.inputs?.photos && Array.isArray(loaded.inputs.photos)) {
      setPhotos(
        loaded.inputs.photos.map((p: any, idx: number) => ({
          id: p.id || `p${idx + 1}`,
          name: p.name || `p${idx + 1}.jpg`,
          dataUrl: p.dataUrl,
        }))
      );
    }

    const restoredLogs: LogEntry[] = [];
    if (Array.isArray(loaded?.log)) {
      for (const l of loaded.log) {
        restoredLogs.push({
          id: `${l.at}_${Math.random().toString(36).slice(2, 7)}`,
          at: l.at || loaded.createdAt || new Date().toISOString(),
          step: l.step || null,
          type: 'log',
          message: l.message,
        });
      }
    }
    if (Array.isArray(loaded?.trace)) {
      for (const t of loaded.trace) {
        if (t.attempt > 1 || t.validator !== 'pass') {
          restoredLogs.push({
            id: `${t.id || Math.random()}`,
            at: t.startedAt || new Date().toISOString(),
            step: t.step || null,
            type: t.validator === 'pass' ? 'retry:pass' : 'retry',
            photoId: t.photoId || null,
            message:
              t.validator === 'pass'
                ? `Attempt ${t.attempt} passed validation (${t.ms} ms)`
                : `Attempt ${t.attempt} rejected: ${Array.isArray(t.validator) ? t.validator.join('; ') : t.validator}`,
            isRetry: true,
          });
        }
      }
    }
    setLogs(restoredLogs);
    setExportNote(`Loaded saved run ${loaded.id || ''} (${loaded.createdAt || 'recorded'})`);
  };

  const handleLoadSavedRunFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      applyLoadedState(parsed);
    } catch (err: any) {
      setExportNote(`Failed to parse state JSON: ${err?.message || String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  // ---------------------------------------------------------------------------
  // Run Harness Pipeline (with live progress + automatic checkpoint-<step>.json downloads)
  // ---------------------------------------------------------------------------
  const executeHarnessRun = async (opts: { resumeState?: any; fromStep?: string } = {}) => {
    if (!opts.resumeState && photos.length === 0) return;

    setIsRunning(true);
    setIsRecordedRun(false);
    setExportNote('');

    if (!opts.resumeState) {
      if (viewerInstanceRef.current) {
        try {
          viewerInstanceRef.current.dispose();
        } catch {
          // ignore
        }
        viewerInstanceRef.current = null;
      }
      setLogs([]);
      setCheckpoints({});
    }

    const ai = createBridgedGenAI();

    const logAdapterEvent = (ev: any) => {
      if (ev.type === 'transport-retry') {
        appendLog({
          step: null,
          type: 'transport-retry',
          message: `Transport retry ${ev.attempt}/${ev.of} for ${ev.label} (waiting ${ev.delay}ms): ${ev.error}`,
          isRetry: true,
        });
      } else if (ev.type === 'image-model-fallback') {
        appendLog({
          step: 'enhance',
          type: 'image-model-fallback',
          message: `Image model fallback from ${ev.from} → ${ev.to}: ${ev.error}`,
          isRetry: true,
        });
      } else {
        appendLog({
          step: null,
          type: ev.type || 'adapter',
          message: JSON.stringify(ev),
        });
      }
    };

    const { callModel, callImage } = makeGeminiCallers({
      ai,
      textModel: 'gemini-4-argon',
      thinkingLevels: { layout: 'low', ingest: 'medium', narrate: 'low' },
      log: logAdapterEvent,
    });

    const captureStops = async ({ state: st }: { state: any }) => {
      try {
        syncViewerWithState(st);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (viewerInstanceRef.current && typeof viewerInstanceRef.current.captureStops === 'function') {
          return await viewerInstanceRef.current.captureStops({ width: 960, height: 720 });
        }
      } catch (err: any) {
        appendLog({
          step: 'judge',
          type: 'capture:warn',
          message: `Could not capture 3D stops: ${err?.message || String(err)}`,
        });
      }
      return [];
    };

    let latestStateRef: any = opts.resumeState || null;
    let downloadedErrorStep: string | null = null;

    const saveCheckpoint = (stepName: string, st: any) => {
      if (!st) return;
      const filename = `checkpoint-${stepName}.json`;
      const serialized = JSON.stringify(st, null, 2);
      setCheckpoints((prev) => ({ ...prev, [stepName]: serialized }));
      triggerJsonDownload(serialized, filename);
      appendLog({
        step: stepName,
        type: 'checkpoint',
        message: `Saved ${filename}`,
      });
    };

    const onProgress = (ev: any, st: any) => {
      latestStateRef = st;
      // Clone top-level state reference so React re-renders live
      setRunState({
        ...st,
        steps: { ...st.steps },
        outputs: { ...st.outputs },
        trace: Array.isArray(st.trace) ? [...st.trace] : [],
        log: Array.isArray(st.log) ? [...st.log] : [],
      });

      if (ev.type === 'retry') {
        appendLog({
          at: ev.at,
          step: ev.step || null,
          photoId: ev.photoId || null,
          type: 'retry',
          message: `Retry ${ev.attempt}/${ev.of}${ev.photoId ? ` (${ev.photoId})` : ''} — ${Array.isArray(ev.errors) ? ev.errors.join('; ') : ev.errors}`,
          isRetry: true,
        });
      } else if (ev.type === 'step:error') {
        appendLog({
          at: ev.at,
          step: ev.step || null,
          type: 'step:error',
          message: ev.message || `${ev.step} failed`,
          isError: true,
        });
        const errStep = ev.step || 'error';
        downloadedErrorStep = errStep;
        saveCheckpoint(errStep, st);
      } else if (ev.type === 'step:done') {
        appendLog({
          at: ev.at,
          step: ev.step || null,
          type: 'step:done',
          message: ev.message || `${ev.step} completed`,
        });
        if (ev.step) {
          saveCheckpoint(ev.step, st);
        }
        if (ev.step === 'layout' || ev.step === 'enhance' || ev.step === 'judge' || ev.step === 'narrate') {
          syncViewerWithState(st);
        }
      } else if (ev.message) {
        appendLog({
          at: ev.at,
          step: ev.step || null,
          photoId: ev.photoId || null,
          type: ev.type,
          message: ev.message,
        });
      }
    };

    try {
      const finishedState = await runHarness(
        opts.resumeState
          ? {
              resume: opts.resumeState,
              fromStep: opts.fromStep,
              callModel,
              callImage,
              captureStops,
              onProgress,
            }
          : {
              photos: photos.map((p) => ({ name: p.name, dataUrl: p.dataUrl })),
              callModel,
              callImage,
              captureStops,
              onProgress,
            }
      );
      setRunState({ ...finishedState });
      syncViewerWithState(finishedState);
    } catch (err: any) {
      const errState = err?.state || latestStateRef;
      const failedStep = err?.step || 'error';
      if (errState) {
        setRunState({ ...errState });
        if (downloadedErrorStep !== failedStep) {
          saveCheckpoint(failedStep, errState);
        }
      }
      appendLog({
        step: failedStep,
        type: 'run:error',
        message: `Run stopped at ${failedStep}: ${err?.message || String(err)}`,
        isError: true,
      });
    } finally {
      setIsRunning(false);
    }
  };

  // Computed report from state.trace + state.outputs.judge
  const report = useMemo(() => {
    if (!runState) return null;
    try {
      return buildReport(runState);
    } catch {
      return null;
    }
  }, [runState]);

  const reportMd = useMemo(() => {
    if (!report) return '';
    try {
      return reportMarkdown(report);
    } catch {
      return '';
    }
  }, [report]);

  // Step telemetry helper
  const getStepMetrics = (stepName: string) => {
    const stepRec = runState?.steps?.[stepName] || { status: 'pending' };
    const traceEntries = Array.isArray(runState?.trace)
      ? runState.trace.filter((t: any) => t.step === stepName)
      : [];
    const retries = traceEntries.filter((t: any) => t.attempt > 1).length;
    const maxAttempt = traceEntries.reduce((max: number, t: any) => Math.max(max, t.attempt || 1), 0);
    const traceMs = traceEntries.reduce((acc: number, t: any) => acc + (t.ms || 0), 0);

    let elapsedMs: number | null = null;
    if (stepRec.status === 'running' && stepRec.startedAt) {
      elapsedMs = Math.max(0, nowTick - new Date(stepRec.startedAt).getTime());
    } else if (stepRec.startedAt && stepRec.finishedAt) {
      elapsedMs = Math.max(0, new Date(stepRec.finishedAt).getTime() - new Date(stepRec.startedAt).getTime());
    } else if (traceMs > 0) {
      elapsedMs = traceMs;
    }

    const stepLogs = logs.filter((l) => l.step === stepName || (stepName === 'enhance' && l.type === 'image-model-fallback'));

    return {
      status: stepRec.status || 'pending',
      error: stepRec.error || null,
      attempts: stepRec.attempts || (maxAttempt > 0 ? maxAttempt : stepRec.status === 'done' ? 1 : 0),
      retries,
      callCount: traceEntries.length,
      elapsedMs,
      stepLogs,
    };
  };

  const toggleStepExpand = (step: string) => {
    setExpandedSteps((prev) => ({ ...prev, [step]: !prev[step] }));
  };

  // Exports
  const handleDownloadTourHtml = async () => {
    if (!runState) return;
    try {
      setExportNote('Building self-contained Tour HTML...');
      const built = await downloadTour(runState, { title: 'Open House Tour' });
      setExportNote(
        `Downloaded ${built.filename} (${(built.bytes / 1e6).toFixed(2)} MB · ${built.trace} traced calls)`
      );
    } catch (err: any) {
      setExportNote(`Export failed: ${err?.message || String(err)}`);
    }
  };

  const handleDownloadTraceJson = () => {
    if (!runState) return;
    const t = downloadTrace(runState);
    setExportNote(`Downloaded ${t.filename} (${t.entries} trace entries)`);
  };

  const handleDownloadReportMd = () => {
    if (!runState) return;
    const r = downloadReport(runState);
    setExportNote(`Downloaded ${r.filename}`);
  };

  const handleDownloadOutputJson = () => {
    if (!runState) return;
    triggerJsonDownload(runState, 'output.json');
    setExportNote('Downloaded output.json');
  };

  const activePhotosList: Array<{ id: string; name: string; dataUrl: string }> =
    runState?.inputs?.photos || photos;

  return (
    <div className="min-h-screen bg-[#16120e] text-[#f2ebe0] flex flex-col">
      {/* Top Navigation Bar (Strict 3-Zone Contract) */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-8 px-4 sm:px-8 py-3.5 bg-[#16120e]/95 backdrop-blur-md border-b border-[#382f26]">
        <a
          href="#top"
          className="text-2xl tracking-tight font-serif-display text-[#f2ebe0] whitespace-nowrap shrink-0"
        >
          Open House
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[#b3a796]">
          <a
            href="#upload-screen"
            className="hover:text-[#f2ebe0] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            1. Upload
          </a>
          <a
            href="#pipeline-screen"
            className="hover:text-[#f2ebe0] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            2. Pipeline
          </a>
          <a
            href="#tour-screen"
            className="hover:text-[#f2ebe0] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            3. Tour
          </a>
          <a
            href="#report-screen"
            className="hover:text-[#f2ebe0] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            4. Report
          </a>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <input
            ref={savedRunInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleLoadSavedRunFile}
            className="hidden"
            id="load-saved-run-input"
          />
          <button
            type="button"
            onClick={() => savedRunInputRef.current?.click()}
            className="px-4 py-2 text-xs font-semibold rounded-lg border border-[#c9a063]/60 text-[#f2ebe0] bg-[#211b15] hover:bg-[#2a231c] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Load saved run
          </button>
        </div>
      </header>

      <main id="top" className="flex-1 w-full max-w-[1280px] mx-auto px-4 sm:px-8 py-6 space-y-10">
        {/* Recorded Run Banner when a saved state JSON is loaded */}
        {isRecordedRun && runState && (
          <div
            data-testid="recorded-run-banner"
            className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5 rounded-xl bg-[#211b15] border border-[#c9a063]/60 text-[#f2ebe0]"
          >
            <div className="flex items-center gap-3 text-sm font-medium">
              <FileJson className="w-4 h-4 text-[#c9a063] shrink-0" />
              <span className="font-mono text-[#c9a063]">
                Recorded run · {runState.createdAt}
              </span>
              <span aria-hidden="true" className="text-[#b3a796]">
                ·
              </span>
              <span className="text-[#b3a796] text-xs">
                State ID: {runState.id || 'saved'} · {runState.inputs?.photos?.length || 0} photos · No model calls made
              </span>
            </div>
            <button
              type="button"
              onClick={() => savedRunInputRef.current?.click()}
              className="text-xs text-[#c9a063] hover:underline whitespace-nowrap shrink-0 cursor-pointer"
            >
              Load another JSON
            </button>
          </div>
        )}

        {/* FIRST: Smoke Test Panel */}
        <section
          aria-label="Smoke test"
          className="rounded-xl bg-[#211b15] border border-[#382f26] p-5 sm:p-6 space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs text-[#b3a796]">
                Pre-flight verification · <code className="text-[#f2ebe0]">gemini-4-argon</code> ·{' '}
                <code className="text-[#f2ebe0]">responseMimeType: &apos;application/json&apos;</code> ·{' '}
                <code className="text-[#f2ebe0]">thinkingLevel: &apos;low&apos;</code>
              </div>
              <h1 className="text-2xl sm:text-3xl font-serif-display text-[#f2ebe0] tracking-tight">
                Gemini 4 Argon Smoke Test
              </h1>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                data-testid="smoke-test-button"
                onClick={handleSmokeTest}
                disabled={smokeStatus === 'running'}
                className="px-5 py-2.5 rounded-lg bg-[#c9a063] text-[#16120e] font-semibold text-sm hover:bg-[#d6b075] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {smokeStatus === 'running' ? 'Running smoke test…' : 'Smoke test'}
              </button>
            </div>
          </div>

          {smokeStatus !== 'idle' && (
            <div className="space-y-2 pt-2 border-t border-[#382f26]">
              <div className="flex items-center gap-2 text-xs text-[#b3a796] tabular-nums">
                <span className="font-semibold text-[#f2ebe0]">
                  Status: {smokeStatus === 'ok' ? '200 OK' : smokeStatus === 'error' ? 'Error' : 'Calling model'}
                </span>
                {smokeMs !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{smokeMs} ms</span>
                  </>
                )}
              </div>
              <pre
                data-testid="smoke-test-result"
                className={`p-3.5 rounded-lg text-xs font-mono overflow-x-auto whitespace-pre-wrap border ${
                  smokeStatus === 'error'
                    ? 'bg-[#2b1615] border-[#7a3b3b] text-[#f7c6c2]'
                    : 'bg-[#16120e] border-[#382f26] text-[#f2ebe0]'
                }`}
              >
                {smokeOutput}
              </pre>
            </div>
          )}
        </section>

        {/* SCREEN 1: UPLOAD */}
        <section
          id="upload-screen"
          className="rounded-xl bg-[#211b15] border border-[#382f26] p-5 sm:p-6 space-y-5"
        >
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs text-[#b3a796]">
                01 · Source Photography
              </div>
              <h2 className="text-2xl sm:text-3xl font-serif-display text-[#f2ebe0]">
                Upload Home Photos
              </h2>
              <p className="text-sm text-[#b3a796] max-w-2xl">
                Pick phone photos of a home to generate an architectural specification, a walkable 3D layout, and golden-hour staged enhancements judged by Gemini 4 Argon.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 shrink-0">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFilesSelected}
                className="hidden"
                id="photo-picker-input"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2.5 rounded-lg border border-[#382f26] bg-[#2a231c] hover:border-[#c9a063] text-sm font-medium text-[#f2ebe0] inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-4 h-4 text-[#c9a063]" />
                <span>Select photos</span>
              </button>

              <button
                type="button"
                onClick={handleLoadSamplePhotos}
                disabled={loadingSamplePhotos || isRunning}
                className="px-4 py-2.5 rounded-lg border border-[#382f26] bg-[#16120e] hover:border-[#c9a063]/60 text-sm font-medium text-[#b3a796] hover:text-[#f2ebe0] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {loadingSamplePhotos ? 'Loading sample photos…' : 'Use 6 sample photos'}
              </button>

              <button
                type="button"
                onClick={() => savedRunInputRef.current?.click()}
                className="px-4 py-2.5 rounded-lg border border-[#382f26] bg-[#16120e] hover:border-[#c9a063]/60 text-sm font-medium text-[#b3a796] hover:text-[#f2ebe0] inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FileJson className="w-4 h-4 text-[#c9a063]" />
                <span>Load saved run</span>
              </button>

              <button
                type="button"
                data-testid="build-tour-button"
                onClick={() => executeHarnessRun()}
                disabled={photos.length === 0 || isRunning}
                className="px-5 py-2.5 rounded-lg bg-[#c9a063] text-[#16120e] font-semibold text-sm hover:bg-[#d6b075] disabled:opacity-40 inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{isRunning ? 'Building tour…' : 'Build my tour'}</span>
              </button>
            </div>
          </div>

          {/* Thumbnails Grid */}
          {photos.length === 0 ? (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border border-dashed border-[#382f26] hover:border-[#c9a063]/60 rounded-xl p-10 text-center cursor-pointer transition-colors bg-[#16120e]/60"
            >
              <Upload className="w-7 h-7 text-[#c9a063] mx-auto mb-2" />
              <p className="text-sm font-medium text-[#f2ebe0]">
                Tap to pick room photos from your phone or computer
              </p>
              <p className="text-xs text-[#b3a796] mt-1">
                Supports JPEG, PNG, WebP · Or click &ldquo;Use 6 sample photos&rdquo; or &ldquo;Load saved run&rdquo; above
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-[#b3a796] tabular-nums">
                <span>{photos.length} photo{photos.length === 1 ? '' : 's'} queued for tour</span>
                {!isRunning && (
                  <button
                    type="button"
                    onClick={() => setPhotos([])}
                    className="text-[#b3a796] hover:text-[#f2ebe0] underline cursor-pointer"
                  >
                    Clear all
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
                {photos.map((photo, index) => (
                  <figure
                    key={`${photo.id}_${index}`}
                    className="group relative rounded-lg overflow-hidden bg-[#16120e] border border-[#382f26]"
                  >
                    <img
                      src={photo.dataUrl}
                      alt={photo.name}
                      referrerPolicy="no-referrer"
                      className="w-full aspect-4/3 object-cover block"
                    />
                    {!isRunning && (
                      <button
                        type="button"
                        onClick={() => handleRemovePhoto(index)}
                        title="Remove photo"
                        className="absolute top-1.5 right-1.5 w-7 h-7 rounded-md bg-[#16120e]/85 text-[#f2ebe0] hover:text-[#f7c6c2] flex items-center justify-center opacity-90 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <figcaption className="px-2.5 py-1.5 text-xs text-[#b3a796] truncate font-mono">
                      <span className="text-[#f2ebe0] font-semibold">{photo.id}</span> · {photo.name}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* SCREEN 2: PIPELINE */}
        <section
          id="pipeline-screen"
          className="rounded-xl bg-[#211b15] border border-[#382f26] p-5 sm:p-6 space-y-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs text-[#b3a796]">
                02 · Six-Step Harness Execution &amp; Checkpoints
              </div>
              <h2 className="text-2xl sm:text-3xl font-serif-display text-[#f2ebe0]">
                Pipeline Progress &amp; Quality Judge
              </h2>
              <p className="text-sm text-[#b3a796]">
                Every completed step and any error automatically downloads <code className="text-[#f2ebe0]">checkpoint-&lt;step&gt;.json</code>.
              </p>
            </div>

            {runState && (
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <label htmlFor="resume-step-select" className="text-xs text-[#b3a796]">
                  Resume from:
                </label>
                <select
                  id="resume-step-select"
                  value={resumeFromStep}
                  onChange={(e) => setResumeFromStep(e.target.value)}
                  disabled={isRunning}
                  className="px-3 py-2 text-xs font-mono rounded-lg bg-[#16120e] border border-[#382f26] text-[#f2ebe0]"
                >
                  {STEPS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => executeHarnessRun({ resumeState: runState, fromStep: resumeFromStep })}
                  disabled={isRunning}
                  className="px-3.5 py-2 rounded-lg border border-[#c9a063]/60 bg-[#2a231c] hover:bg-[#c9a063] hover:text-[#16120e] text-xs font-semibold text-[#f2ebe0] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Resume from step</span>
                </button>
              </div>
            )}
          </div>

          {/* 6 Live Step Cards */}
          <div className="space-y-4">
            {STEPS.map((stepName, idx) => {
              const metrics = getStepMetrics(stepName);
              const isExpanded = expandedSteps[stepName] ?? true;
              const hasCheckpoint = Boolean(checkpoints[stepName] || (runState && (metrics.status === 'done' || metrics.status === 'error')));

              return (
                <div
                  key={stepName}
                  data-step-card={stepName}
                  className={`rounded-xl border transition-colors ${
                    metrics.status === 'running'
                      ? 'bg-[#2a231c] border-[#c9a063]'
                      : metrics.status === 'done'
                      ? 'bg-[#16120e] border-[#382f26]'
                      : metrics.status === 'error'
                      ? 'bg-[#261614] border-[#7a3b3b]'
                      : 'bg-[#16120e]/70 border-[#382f26]/70'
                  }`}
                >
                  {/* Step Card Header */}
                  <div className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                      <div className="mt-0.5 sm:mt-0 shrink-0">
                        {metrics.status === 'done' && (
                          <CheckCircle2 className="w-5 h-5 text-[#8ec07c]" />
                        )}
                        {metrics.status === 'running' && (
                          <Clock className="w-5 h-5 text-[#c9a063]" />
                        )}
                        {metrics.status === 'error' && (
                          <XCircle className="w-5 h-5 text-[#e67e73]" />
                        )}
                        {metrics.status === 'pending' && (
                          <Clock className="w-5 h-5 text-[#b3a796]/50" />
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-xl font-serif-display text-[#f2ebe0] tracking-tight">
                            0{idx + 1}. {stepName}
                          </h3>
                          <span className="text-xs text-[#b3a796]">·</span>
                          <span
                            className={`text-xs font-mono font-medium ${
                              metrics.status === 'done'
                                ? 'text-[#8ec07c]'
                                : metrics.status === 'running'
                                ? 'text-[#c9a063]'
                                : metrics.status === 'error'
                                ? 'text-[#e67e73]'
                                : 'text-[#b3a796]'
                            }`}
                          >
                            {metrics.status}
                          </span>
                        </div>
                        <p className="text-xs text-[#b3a796] mt-0.5">
                          {STEP_DESCRIPTIONS[stepName] || stepName}
                        </p>
                      </div>
                    </div>

                    {/* Step Telemetry: Attempt, Retries, Elapsed Time, Checkpoint Download */}
                    <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-[#b3a796] tabular-nums shrink-0">
                      <span>
                        Attempt: <strong className="text-[#f2ebe0]">{metrics.attempts || (metrics.status === 'running' ? 1 : 0)}</strong>
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        Retries: <strong className="text-[#f2ebe0]">{metrics.retries}</strong>
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        Elapsed: <strong className="text-[#f2ebe0]">{formatMs(metrics.elapsedMs)}</strong>
                      </span>

                      {hasCheckpoint && (
                        <>
                          <span aria-hidden="true">·</span>
                          <button
                            type="button"
                            onClick={() =>
                              triggerJsonDownload(
                                checkpoints[stepName] || runState,
                                `checkpoint-${stepName}.json`
                              )
                            }
                            className="text-[#c9a063] hover:underline inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>checkpoint-{stepName}.json</span>
                          </button>
                        </>
                      )}

                      <button
                        type="button"
                        onClick={() => toggleStepExpand(stepName)}
                        className="p-1 text-[#b3a796] hover:text-[#f2ebe0] cursor-pointer"
                        aria-label={`Toggle ${stepName} details`}
                      >
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Step Expanded Body */}
                  {isExpanded && (
                    <div className="px-4 sm:px-5 pb-5 pt-2 border-t border-[#382f26]/80 space-y-4">
                      {/* Error banner if step failed */}
                      {metrics.error && (
                        <div className="p-3 rounded-lg bg-[#2b1615] border border-[#7a3b3b] text-xs font-mono text-[#f7c6c2]">
                          Error: {metrics.error.message}
                        </div>
                      )}

                      {/* Step-specific Retries & Adapter Events Log */}
                      {metrics.stepLogs.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-xs text-[#b3a796]">Step events &amp; retries log</div>
                          <div className="max-h-36 overflow-y-auto rounded-lg bg-[#211b15] border border-[#382f26] p-2.5 font-mono text-xs space-y-1">
                            {metrics.stepLogs.map((l) => (
                              <div
                                key={l.id}
                                className={
                                  l.isError
                                    ? 'text-[#e67e73]'
                                    : l.isRetry
                                    ? 'text-[#e0b35a]'
                                    : 'text-[#b3a796]'
                                }
                              >
                                <span className="opacity-60">[{l.at.slice(11, 19)}]</span>{' '}
                                {l.message}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* STEP 1: prepare output */}
                      {stepName === 'prepare' && runState?.outputs?.prepare?.photos && (
                        <div className="text-xs text-[#b3a796] flex flex-wrap gap-x-4 gap-y-1 font-mono tabular-nums">
                          {runState.outputs.prepare.photos.map((p: any) => (
                            <span key={p.id}>
                              <strong className="text-[#f2ebe0]">{p.id}</strong>:{' '}
                              {p.width ? `${p.width}×${p.height}` : 'native'}
                              {p.scaled ? ` → ${p.modelWidth}×${p.modelHeight}` : ''}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* STEP 2: ingest output (spec.json summary) */}
                      {stepName === 'ingest' && runState?.outputs?.spec && (
                        <div className="space-y-2 text-xs">
                          <div className="text-[#b3a796]">
                            Extracted <strong className="text-[#f2ebe0]">{runState.outputs.spec.rooms?.length || 0} rooms</strong> ·{' '}
                            <strong className="text-[#f2ebe0]">{runState.outputs.spec.photos?.length || 0} mapped photos</strong>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                            {(runState.outputs.spec.rooms || []).map((room: any) => (
                              <div
                                key={room.id}
                                className="p-3 rounded-lg bg-[#211b15] border border-[#382f26] space-y-1"
                              >
                                <div className="font-semibold text-[#f2ebe0]">
                                  {room.name} <span className="font-mono text-[#b3a796]">({room.id})</span>
                                </div>
                                {room.materials && (
                                  <div className="text-[#b3a796]">
                                    Floor: {room.materials.floor || '—'} · Walls: {room.materials.walls || '—'}
                                  </div>
                                )}
                                {Array.isArray(room.objects) && room.objects.length > 0 && (
                                  <div className="text-[#b3a796] truncate">
                                    Objects: {room.objects.map((o: any) => `${o.kind || o.name} (${o.count || 1})`).join(', ')}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* STEP 3: layout output */}
                      {stepName === 'layout' && runState?.outputs?.layout && (
                        <div className="text-xs text-[#b3a796] flex flex-wrap gap-x-4 gap-y-1 font-mono tabular-nums">
                          <span>
                            Environment: <strong className="text-[#f2ebe0]">{runState.outputs.layout.environment || 'garden'}</strong>
                          </span>
                          <span>·</span>
                          <span>
                            Levels: <strong className="text-[#f2ebe0]">{runState.outputs.layout.levels?.length || 0}</strong>
                          </span>
                          <span>·</span>
                          <span>
                            Rooms: <strong className="text-[#f2ebe0]">{runState.outputs.layout.rooms?.length || 0}</strong>
                          </span>
                          <span>·</span>
                          <span>
                            Openings: <strong className="text-[#f2ebe0]">{runState.outputs.layout.openings?.length || 0}</strong>
                          </span>
                          <span>·</span>
                          <span>
                            Furniture items: <strong className="text-[#f2ebe0]">{runState.outputs.layout.furniture?.length || 0}</strong>
                          </span>
                          <span>·</span>
                          <span>
                            Cameras: <strong className="text-[#f2ebe0]">{runState.outputs.layout.cameras?.length || 0}</strong>
                          </span>
                        </div>
                      )}

                      {/* STEP 4 & 5: Before / After Photos & Judge Scores */}
                      {(stepName === 'enhance' || stepName === 'judge') &&
                        runState?.outputs?.enhance?.items && (
                          <div className="space-y-4 pt-1">
                            <div className="text-xs text-[#b3a796]">
                              {stepName === 'judge'
                                ? 'Independent Judge Verdicts, Before/After Comparisons & Redos'
                                : 'Before / After Golden-Hour Photo Edits'}
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                              {activePhotosList.map((origPhoto: any) => {
                                const enhanceItem = runState.outputs.enhance?.items?.[origPhoto.id];
                                const firstAttempt = enhanceItem?.attempts?.[0];
                                const finalImg = finalImageFor(runState, origPhoto.id) || firstAttempt?.image;
                                const judgePhoto = runState.outputs.judge?.photos?.[origPhoto.id];
                                const judgeFinal = runState.outputs.judge?.final?.[origPhoto.id];
                                const verdicts = judgePhoto?.verdicts || [];
                                const latestVerdict = verdicts[verdicts.length - 1];
                                const firstVerdict = verdicts[0];
                                const tourShot = runState.outputs.judge?.tour?.shots?.[origPhoto.id];
                                const threshold = runState.outputs.judge?.summary?.threshold ?? 4;

                                if (!firstAttempt && !finalImg) return null;

                                return (
                                  <div
                                    key={origPhoto.id}
                                    className="rounded-xl bg-[#211b15] border border-[#382f26] p-3.5 space-y-3"
                                  >
                                    {/* Photo Header + Judge Score Summary */}
                                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                      <div className="font-mono font-semibold text-[#f2ebe0]">
                                        {origPhoto.id} · {origPhoto.name}
                                      </div>
                                      {judgeFinal && (
                                        <div className="flex items-center gap-2 font-mono tabular-nums">
                                          <span
                                            className={
                                              judgeFinal.overall >= threshold
                                                ? 'text-[#8ec07c] font-semibold'
                                                : 'text-[#e67e73] font-semibold'
                                            }
                                          >
                                            Judge: {judgeFinal.overall}/5
                                          </span>
                                          {verdicts.length > 1 && (
                                            <span className="text-[#e0b35a]">
                                              · Redone (1st: {firstVerdict?.overall}/5)
                                            </span>
                                          )}
                                          {judgeFinal.overall < threshold && (
                                            <span className="text-[#e67e73]">· Flagged</span>
                                          )}
                                        </div>
                                      )}
                                    </div>

                                    {/* Before / After Side-by-Side Images */}
                                    <div className="grid grid-cols-2 gap-2.5">
                                      <figure className="space-y-1">
                                        <img
                                          src={origPhoto.dataUrl}
                                          alt={`${origPhoto.id} before`}
                                          referrerPolicy="no-referrer"
                                          className="w-full aspect-4/3 object-cover rounded-lg border border-[#382f26]"
                                        />
                                        <figcaption className="text-[11px] text-[#b3a796] font-mono">
                                          Before (Original)
                                        </figcaption>
                                      </figure>

                                      <figure className="space-y-1">
                                        {finalImg ? (
                                          <img
                                            src={finalImg}
                                            alt={`${origPhoto.id} after golden-hour edit`}
                                            referrerPolicy="no-referrer"
                                            className="w-full aspect-4/3 object-cover rounded-lg border border-[#c9a063]/50"
                                          />
                                        ) : (
                                          <div className="w-full aspect-4/3 rounded-lg border border-[#382f26] bg-[#16120e] flex items-center justify-center text-xs text-[#b3a796]">
                                            Pending
                                          </div>
                                        )}
                                        <figcaption className="text-[11px] text-[#c9a063] font-mono">
                                          After (Golden-Hour{judgeFinal?.source === 'redo' ? ' · Redo' : ''})
                                        </figcaption>
                                      </figure>
                                    </div>

                                    {/* Enhance Plan summary */}
                                    {firstAttempt?.plan?.editPrompt && (
                                      <p className="text-xs text-[#b3a796] line-clamp-2">
                                        <strong className="text-[#f2ebe0]">Edit plan:</strong>{' '}
                                        {firstAttempt.plan.editPrompt}
                                      </p>
                                    )}

                                    {/* Detailed Judge Sub-Scores & Defects */}
                                    {latestVerdict && (
                                      <div className="pt-2 border-t border-[#382f26] space-y-1.5 text-xs">
                                        {latestVerdict.scores && (
                                          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-[#b3a796] tabular-nums">
                                            {Object.entries(latestVerdict.scores).map(([k, val]: [string, any]) => (
                                              <span key={k}>
                                                {k}: <strong className="text-[#f2ebe0]">{val}/5</strong>
                                              </span>
                                            ))}
                                          </div>
                                        )}

                                        {Array.isArray(latestVerdict.defects) && latestVerdict.defects.length > 0 ? (
                                          <ul className="space-y-0.5 text-[11px] text-[#e0b35a] list-disc list-inside">
                                            {latestVerdict.defects.map((d: any, di: number) => (
                                              <li key={di}>
                                                <span className="font-mono">[{d.kind}{d.severity ? `, ${d.severity}` : ''}]</span>{' '}
                                                {d.detail}
                                              </li>
                                            ))}
                                          </ul>
                                        ) : (
                                          <div className="text-[11px] text-[#8ec07c]">
                                            No defects reported on final image
                                          </div>
                                        )}

                                        {tourShot && (
                                          <div className="pt-2 flex items-center gap-3 border-t border-[#382f26]/60">
                                            <img
                                              src={tourShot.image}
                                              alt={`${origPhoto.id} 3D tour render`}
                                              referrerPolicy="no-referrer"
                                              className="w-20 aspect-4/3 object-cover rounded border border-[#382f26] shrink-0"
                                            />
                                            <div className="text-[11px] text-[#b3a796] space-y-0.5 font-mono tabular-nums">
                                              <div>
                                                3D Tour Stop Score:{' '}
                                                <strong className="text-[#f2ebe0]">
                                                  {tourShot.verdict?.overall ?? '—'}/5
                                                </strong>
                                              </div>
                                              {tourShot.verdict?.defects?.length > 0 && (
                                                <div className="text-[#e0b35a] truncate max-w-xs">
                                                  {tourShot.verdict.defects.map((d: any) => d.detail).join('; ')}
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                      {/* STEP 6: narrate output */}
                      {stepName === 'narrate' && runState?.outputs?.narration && (
                        <div className="space-y-2 text-xs">
                          {runState.outputs.narration.intro && (
                            <p className="text-sm italic font-serif-display text-[#f2ebe0] text-base">
                              &ldquo;{runState.outputs.narration.intro}&rdquo;
                            </p>
                          )}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {(runState.outputs.narration.lines || []).map((line: any, i: number) => (
                              <div
                                key={`${line.room}_${i}`}
                                className="p-2.5 rounded-lg bg-[#211b15] border border-[#382f26]"
                              >
                                <span className="font-mono font-semibold text-[#c9a063] mr-2">
                                  {line.room}:
                                </span>
                                <span className="text-[#f2ebe0]">{line.text}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* SCREEN 3: TOUR */}
        <section
          id="tour-screen"
          className="rounded-xl bg-[#211b15] border border-[#382f26] p-5 sm:p-6 space-y-5"
        >
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs text-[#b3a796]">
                03 · Interactive 3D Walkthrough &amp; Golden-Hour Crossfade
              </div>
              <h2 className="text-2xl sm:text-3xl font-serif-display text-[#f2ebe0]">
                Walkable 3D Home Tour
              </h2>
              <p className="text-sm text-[#b3a796]">
                Drag to look around · Step between rooms · Toggle <strong className="text-[#f2ebe0]">Photoreal</strong> inside the viewer bar to crossfade to the golden-hour enhanced photo at each camera stop.
              </p>
            </div>
          </div>

          {/* Viewer Mount Container */}
          <div className="relative rounded-xl overflow-hidden border border-[#382f26] bg-[#16120e] min-h-[360px]">
            <div ref={viewerContainerRef} data-testid="tour-viewer-container" className="w-full" />
            {!runState?.outputs?.layout && (
              <div className="flex flex-col items-center justify-center py-24 px-4 text-center space-y-2">
                <Home className="w-8 h-8 text-[#c9a063]/70" />
                <p className="text-sm font-medium text-[#f2ebe0]">
                  3D Tour Viewer initializes automatically as soon as the <code className="font-mono">layout</code> step finishes
                </p>
                <p className="text-xs text-[#b3a796]">
                  Upload photos and click &ldquo;Build my tour&rdquo;, or click &ldquo;Load saved run&rdquo; to inspect a recorded state JSON.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* SCREEN 4: REPORT ("How it was made" + Downloads) */}
        <section
          id="report-screen"
          className="rounded-xl bg-[#211b15] border border-[#382f26] p-5 sm:p-6 space-y-6"
        >
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div className="space-y-1">
              <div className="text-xs text-[#b3a796]">
                04 · Trace-Verified Provenance &amp; Exports
              </div>
              <h2 className="text-2xl sm:text-3xl font-serif-display text-[#f2ebe0]">
                How It Was Made
              </h2>
              <p className="text-sm text-[#b3a796]">
                Built strictly via <code className="text-[#f2ebe0]">buildReport(state)</code> from <code className="text-[#f2ebe0]">state.trace</code> and judge verdicts. No model-written summary is quoted.
              </p>
            </div>

            {/* 4 Required Export Downloads */}
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <button
                type="button"
                data-testid="download-tour-btn"
                onClick={handleDownloadTourHtml}
                disabled={!runState?.outputs?.layout}
                className="px-4 py-2 rounded-lg bg-[#c9a063] text-[#16120e] font-semibold text-xs hover:bg-[#d6b075] disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download tour HTML</span>
              </button>

              <button
                type="button"
                data-testid="download-trace-btn"
                onClick={handleDownloadTraceJson}
                disabled={!runState}
                className="px-3.5 py-2 rounded-lg border border-[#382f26] bg-[#2a231c] hover:border-[#c9a063] text-xs font-mono text-[#f2ebe0] disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-[#c9a063]" />
                <span>trace.json</span>
              </button>

              <button
                type="button"
                data-testid="download-report-btn"
                onClick={handleDownloadReportMd}
                disabled={!runState}
                className="px-3.5 py-2 rounded-lg border border-[#382f26] bg-[#2a231c] hover:border-[#c9a063] text-xs font-mono text-[#f2ebe0] disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-[#c9a063]" />
                <span>report.md</span>
              </button>

              <button
                type="button"
                data-testid="download-output-btn"
                onClick={handleDownloadOutputJson}
                disabled={!runState}
                className="px-3.5 py-2 rounded-lg border border-[#382f26] bg-[#2a231c] hover:border-[#c9a063] text-xs font-mono text-[#f2ebe0] disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-[#c9a063]" />
                <span>output.json</span>
              </button>
            </div>
          </div>

          {exportNote && (
            <div className="text-xs font-mono text-[#c9a063] bg-[#16120e] px-3.5 py-2 rounded-lg border border-[#382f26]">
              {exportNote}
            </div>
          )}

          {!report ? (
            <div className="p-8 rounded-xl bg-[#16120e] border border-[#382f26] text-center text-sm text-[#b3a796]">
              Run the pipeline or load a saved state JSON to generate the trace-verified report.
            </div>
          ) : (
            <div className="space-y-6">
              {/* Totals Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 font-mono tabular-nums">
                <div className="p-3 rounded-lg bg-[#16120e] border border-[#382f26]">
                  <div className="text-[11px] text-[#b3a796]">Total Calls</div>
                  <div className="text-lg font-semibold text-[#f2ebe0]">{report.totals.calls}</div>
                </div>
                <div className="p-3 rounded-lg bg-[#16120e] border border-[#382f26]">
                  <div className="text-[11px] text-[#b3a796]">Model / Image</div>
                  <div className="text-lg font-semibold text-[#f2ebe0]">
                    {report.totals.modelCalls} / {report.totals.imageCalls}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-[#16120e] border border-[#382f26]">
                  <div className="text-[11px] text-[#b3a796]">Retries</div>
                  <div className="text-lg font-semibold text-[#f2ebe0]">{report.totals.retries}</div>
                </div>
                <div className="p-3 rounded-lg bg-[#16120e] border border-[#382f26]">
                  <div className="text-[11px] text-[#b3a796]">Failed Validation</div>
                  <div className="text-lg font-semibold text-[#f2ebe0]">{report.totals.failed}</div>
                </div>
                <div className="p-3 rounded-lg bg-[#16120e] border border-[#382f26]">
                  <div className="text-[11px] text-[#b3a796]">Photos Redone</div>
                  <div className="text-lg font-semibold text-[#f2ebe0]">
                    {report.totals.photosRedone} ({report.totals.redoCalls} calls)
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-[#16120e] border border-[#382f26]">
                  <div className="text-[11px] text-[#b3a796]">Judge Mean</div>
                  <div className="text-lg font-semibold text-[#c9a063]">
                    {report.totals.meanScore !== null ? `${report.totals.meanScore}/5` : '—'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-[#16120e] border border-[#382f26]">
                  <div className="text-[11px] text-[#b3a796]">Tour Mean</div>
                  <div className="text-lg font-semibold text-[#c9a063]">
                    {report.totals.meanTourScore !== null ? `${report.totals.meanTourScore}/5` : '—'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-[#16120e] border border-[#382f26]">
                  <div className="text-[11px] text-[#b3a796]">Model Time</div>
                  <div className="text-lg font-semibold text-[#f2ebe0]">{formatMs(report.totals.ms)}</div>
                </div>
              </div>

              {/* Per-Step & Per-Photo Tables */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Per Step Table */}
                <div className="space-y-2 overflow-x-auto">
                  <h3 className="text-lg font-serif-display text-[#f2ebe0]">Per Step</h3>
                  <table className="w-full text-xs font-mono tabular-nums border-collapse">
                    <thead>
                      <tr className="border-b border-[#382f26] text-[#b3a796] text-left">
                        <th className="py-2 pr-3">Step</th>
                        <th className="py-2 px-2">Calls</th>
                        <th className="py-2 px-2">Model</th>
                        <th className="py-2 px-2">Image</th>
                        <th className="py-2 px-2">Retries</th>
                        <th className="py-2 px-2">Failed</th>
                        <th className="py-2 px-2">Redos</th>
                        <th className="py-2 pl-2 text-right">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.steps.map((s) => (
                        <tr key={s.step} className="border-b border-[#382f26]/60">
                          <td className="py-2 pr-3 font-semibold text-[#f2ebe0]">{s.step}</td>
                          <td className="py-2 px-2">{s.calls}</td>
                          <td className="py-2 px-2">{s.modelCalls}</td>
                          <td className="py-2 px-2">{s.imageCalls}</td>
                          <td className="py-2 px-2">{s.retries}</td>
                          <td className="py-2 px-2">{s.failed}</td>
                          <td className="py-2 px-2">{s.redos}</td>
                          <td className="py-2 pl-2 text-right">{formatMs(s.ms)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Per Photo Table */}
                <div className="space-y-2 overflow-x-auto">
                  <h3 className="text-lg font-serif-display text-[#f2ebe0]">Per Photo</h3>
                  <table className="w-full text-xs font-mono tabular-nums border-collapse">
                    <thead>
                      <tr className="border-b border-[#382f26] text-[#b3a796] text-left">
                        <th className="py-2 pr-3">Photo</th>
                        <th className="py-2 px-2">Calls</th>
                        <th className="py-2 px-2">Judge</th>
                        <th className="py-2 px-2">First</th>
                        <th className="py-2 px-2">Tour</th>
                        <th className="py-2 px-2">Redone</th>
                        <th className="py-2 px-2">Retries</th>
                        <th className="py-2 pl-2 text-right">Defects</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.photos.map((p) => (
                        <tr key={p.photoId} className="border-b border-[#382f26]/60">
                          <td className="py-2 pr-3 font-semibold text-[#f2ebe0]">{p.photoId}</td>
                          <td className="py-2 px-2">{p.calls}</td>
                          <td className="py-2 px-2 text-[#c9a063]">
                            {p.score === null ? '—' : `${p.score}/5`}
                          </td>
                          <td className="py-2 px-2">
                            {p.firstScore === null ? '—' : `${p.firstScore}/5`}
                          </td>
                          <td className="py-2 px-2">
                            {p.tourScore === null ? '—' : `${p.tourScore}/5`}
                          </td>
                          <td className="py-2 px-2">{p.redone ? 'yes' : 'no'}</td>
                          <td className="py-2 px-2">{p.retries}</td>
                          <td className="py-2 pl-2 text-right">{p.defects.length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Raw report.md output */}
              <div className="space-y-2">
                <div className="text-xs text-[#b3a796]">Generated Markdown (<code className="text-[#f2ebe0]">report.md</code>)</div>
                <pre className="p-4 rounded-xl bg-[#16120e] border border-[#382f26] text-xs font-mono text-[#b3a796] overflow-x-auto whitespace-pre-wrap max-h-80">
                  {reportMd}
                </pre>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-[#382f26] py-5 px-4 sm:px-8 text-xs text-[#b3a796] flex flex-wrap items-center justify-between gap-4 max-w-[1280px] w-full mx-auto">
        <span>Open House · Walkable 3D Tour &amp; Golden-Hour Staging</span>
        <span>Powered by Gemini 4 Argon &amp; Open House Harness</span>
      </footer>
    </div>
  );
}
