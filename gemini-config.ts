import { db, appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

async function getSetting(key: string): Promise<string | null> {
  try {
    const rows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key)).limit(1);
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function setSetting(key: string, value: string | null): Promise<void> {
  try {
    await db.insert(appSettingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value } });
  } catch (err) {
    console.error("Failed to save setting", key, err);
  }
}

export async function getGeminiApiKey(): Promise<string | undefined> {
  const val = await getSetting("gemini_api_key");
  return val || process.env.GEMINI_API_KEY || undefined;
}

export async function getGeminiKeySource(): Promise<"db" | "env" | "none"> {
  const val = await getSetting("gemini_api_key");
  if (val) return "db";
  if (process.env.GEMINI_API_KEY) return "env";
  return "none";
}

export async function saveGeminiApiKey(key: string): Promise<void> {
  await setSetting("gemini_api_key", key);
}

export async function clearGeminiApiKey(): Promise<void> {
  await setSetting("gemini_api_key", null);
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••••••••••" + key.slice(-4);
}

export async function getAppName(): Promise<string> {
  return (await getSetting("app_name")) ?? "AttendX";
}

export async function saveAppName(name: string): Promise<void> {
  await setSetting("app_name", name);
}

export async function getAppLogo(): Promise<string> {
  return (await getSetting("app_logo")) ?? "";
}

export async function saveAppLogo(logo: string): Promise<void> {
  await setSetting("app_logo", logo);
}

export async function getWorkStartTime(): Promise<string> {
  return (await getSetting("work_start_time")) ?? "09:00";
}

export async function saveWorkStartTime(time: string): Promise<void> {
  await setSetting("work_start_time", time);
}

export async function getLateGraceMinutes(): Promise<number> {
  const val = await getSetting("late_grace_minutes");
  return val !== null ? parseInt(val, 10) : 15;
}

export async function saveLateGraceMinutes(minutes: number): Promise<void> {
  await setSetting("late_grace_minutes", String(minutes));
}

export async function getLateThresholdMinutes(): Promise<number> {
  const time = await getWorkStartTime();
  const [hh, mm] = time.split(":").map(Number);
  const grace = await getLateGraceMinutes();
  return hh * 60 + mm + grace;
}
