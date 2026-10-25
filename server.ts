import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const NOT_FOUND_RE = /\b404\b|NOT_FOUND|not found|no longer available/i;

function getAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured in environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  app.post('/api/gemini/generate', async (req, res) => {
    try {
      const { model, contents, config } = req.body || {};
      const ai = getAiClient();

      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        return res.json({
          text: response.text,
          candidates: response.candidates,
          promptFeedback: response.promptFeedback,
          modelVersion: (response as any).modelVersion || model,
        });
      } catch (innerErr: any) {
        const msg = [innerErr?.message, innerErr?.status, innerErr?.code].filter(Boolean).join(' ');
        // If the adapter exhausted down to gemini-2.5-flash-image and that 404s,
        // transparently fall back to gemini-3.1-flash-lite-image so image edits still succeed.
        if (model === 'gemini-2.5-flash-image' && NOT_FOUND_RE.test(msg)) {
          const fallbackModel = 'gemini-3.1-flash-lite-image';
          const fallbackRes = await ai.models.generateContent({
            model: fallbackModel,
            contents,
          });
          return res.json({
            text: fallbackRes.text,
            candidates: fallbackRes.candidates,
            promptFeedback: fallbackRes.promptFeedback,
            modelVersion: fallbackModel,
            fallbackFrom: model,
            fallbackTo: fallbackModel,
          });
        }
        throw innerErr;
      }
    } catch (err: any) {
      const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
      return res.status(status).json({
        isGeminiError: true,
        message: err?.message || String(err),
        status: err?.status || status,
        code: err?.code || null,
        error: err?.error || null,
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Open House server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
