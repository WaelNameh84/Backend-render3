import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth";
import { z } from "zod";
import { getGeminiApiKey, getGeminiKeySource, saveGeminiApiKey, clearGeminiApiKey, maskKey } from "../lib/gemini-config";

const router = Router();

const PERSONALITY_PROMPTS: Record<string, string> = {
  professional: "Maintain a formal, professional tone. Be precise and structured.",
  friendly: "Be warm, encouraging, and conversational. Use a friendly helpful tone.",
  concise: "Be extremely brief. Give direct answers with no extra words.",
};

const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_TIMEOUT_MS = 45_000;

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function callGemini(apiKey: string, message: string, contents: any[] = []): Promise<Response> {
  return fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: contents.length > 0 ? contents : [{ role: "user", parts: [{ text: message }] }],
        generationConfig: { maxOutputTokens: 64 },
      }),
    },
    GEMINI_TIMEOUT_MS
  );
}

async function callGeminiVerify(apiKey: string): Promise<Response> {
  return fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        generationConfig: { maxOutputTokens: 5 },
      }),
    },
    GEMINI_TIMEOUT_MS
  );
}

router.post("/chat", requireAuth, async (req: any, res) => {
  try {
    const schema = z.object({
      message: z.string().min(1),
      conversationHistory: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })).optional().default([]),
      assistantName: z.string().optional().default("مساعدي"),
      personality: z.enum(["professional", "friendly", "concise"]).optional().default("friendly"),
      userName: z.string().optional().default(""),
      clientApiKey: z.string().optional(),
    });
    const body = schema.parse(req.body);

    const apiKey = body.clientApiKey || await getGeminiApiKey();
    if (!apiKey) {
      return res.status(503).json({ error: "AI assistant is not configured. Please set VITE_GEMINI_API_KEY in your environment variables." });
    }

    const personalityNote = PERSONALITY_PROMPTS[body.personality] ?? PERSONALITY_PROMPTS.friendly;
    const nameNote = body.assistantName ? `Your name is "${body.assistantName}".` : "";
    const userNote = body.userName ? `The user's name is "${body.userName}". Address them by name when appropriate.` : "";

    const systemPrompt = `You are a helpful HR and work assistant for an employee attendance management system called AttendX.
${nameNote}
${userNote}
${personalityNote}

You help employees and managers with questions about:
- Work hours, overtime calculations, and attendance policies
- Leave types (annual, sick, emergency, unpaid) and how to apply
- Understanding attendance reports and summaries
- General HR and workplace queries
- How to use the attendance system

IMPORTANT: Always detect and respond in the same language the user is writing in.
- If the user writes in Arabic, reply fully in Arabic.
- If the user writes in Swedish, reply fully in Swedish.
- If the user writes in English, reply in English.
- Never mix languages in the same response.

Keep responses concise. If asked about topics unrelated to work or HR, politely redirect to work-related topics.`;

    const contents = [
      ...body.conversationHistory.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      { role: "user", parts: [{ text: body.message }] },
    ];

    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { maxOutputTokens: 1024 },
        }),
      },
      GEMINI_TIMEOUT_MS
    );

    if (response.status === 400) {
      return res.status(400).json({ error: "طلب غير صالح إلى Gemini API. تحقق من صحة المدخلات." });
    }
    if (response.status === 401 || response.status === 403) {
      return res.status(502).json({ error: "مفتاح Gemini API غير صالح أو منتهي الصلاحية. يرجى تحديثه من الإعدادات > المساعد الذكي." });
    }
    if (response.status === 429) {
      return res.status(429).json({ error: "تم تجاوز حد الاستخدام. انتظر قليلاً ثم أعد المحاولة." });
    }
    if (!response.ok) {
      const err = await response.text();
      if (err.includes("API key") || err.includes("authentication") || err.includes("credential")) {
        return res.status(502).json({ error: "مفتاح Gemini API غير صالح. يرجى تحديثه من الإعدادات > المساعد الذكي." });
      }
      return res.status(502).json({ error: `خطأ من خدمة Gemini: ${err.slice(0, 200)}` });
    }

    const data = await response.json() as any;
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "عذراً، لم أتمكن من توليد رد. حاول مجدداً.";
    return res.json({ reply });
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.message?.includes("abort")) {
      return res.status(504).json({ error: "انتهت مهلة الانتظار — Gemini لم يستجب خلال 45 ثانية. حاول مجدداً." });
    }
    return res.status(500).json({ error: err.message });
  }
});

router.get("/config", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const source = await getGeminiKeySource();
    const apiKey = await getGeminiApiKey();
    return res.json({
      hasKey: source !== "none",
      source,
      maskedKey: apiKey ? maskKey(apiKey) : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/config", requireAuth, requireAdmin, async (req, res) => {
  try {
    const schema = z.object({
      key: z.string().min(1),
    });
    const { key } = schema.parse(req.body);
    await saveGeminiApiKey(key.trim());
    return res.json({ success: true, maskedKey: maskKey(key.trim()) });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete("/config", requireAuth, requireAdmin, async (_req, res) => {
  try {
    await clearGeminiApiKey();
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/verify-key", requireAuth, async (req, res) => {
  try {
    const schema = z.object({ key: z.string().min(1) });
    const { key } = schema.parse(req.body);

    const response = await callGeminiVerify(key.trim());

    if (response.status === 400) {
      return res.status(200).json({ valid: false, reason: "bad_request" });
    }
    if (response.status === 403 || response.status === 401) {
      return res.status(200).json({ valid: false, reason: "unauthorized" });
    }
    if (response.status === 429) {
      // Rate limited — key is valid but quota exceeded
      return res.status(200).json({ valid: true, note: "rate_limited" });
    }
    if (!response.ok) {
      const errBody = await response.json().catch(() => null);
      const msg = errBody?.error?.message || errBody?.error?.status || "unknown_error";
      return res.status(200).json({ valid: false, reason: msg });
    }

    return res.status(200).json({ valid: true });
  } catch (err: any) {
    return res.status(200).json({ valid: false, reason: err.message });
  }
});

export default router;
