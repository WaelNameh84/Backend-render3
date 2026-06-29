import { Router } from "express";
import { db, usersTable, userSettingsTable, sessionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { sendNewUserNotificationToAdmin } from "../lib/mailer";
import { createNotification } from "../lib/notify";

const router = Router();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password + "attendance_salt_2024").digest("hex");
}

function generateToken(userId: number): string {
  const payload = `${userId}:${Date.now()}:${crypto.randomBytes(16).toString("hex")}`;
  return Buffer.from(payload).toString("base64");
}

async function createSession(userId: number): Promise<string> {
  const token = generateToken(userId);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessionsTable).values({ userId, token, expiresAt });
  return token;
}

async function getUserIdFromToken(token: string): Promise<number | null> {
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.token, token))
    .limit(1);
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await db.delete(sessionsTable).where(eq(sessionsTable.token, token));
    return null;
  }
  return session.userId;
}

export async function requireAuth(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = auth.slice(7);
  const userId = await getUserIdFromToken(token);
  if (!userId) {
    return res.status(401).json({ error: "Invalid token" });
  }
  req.userId = userId;
  next();
}

export function requireAdmin(req: any, res: any, next: any) {
  requireAuth(req, res, async () => {
    const user = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    if (!user[0] || user[0].role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.user = user[0];
    next();
  });
}

function appUrl(): string {
  return process.env.REPLIT_APP_URL ?? process.env.APP_URL ?? "https://attendx88.onrender.com";
}

router.post("/register", async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email(),
      password: z.string().min(6),
      role: z.enum(["admin", "employee"]).optional().default("employee"),
    });
    const body = schema.parse(req.body);
    const emailNorm = body.email.trim().toLowerCase();
    const existing = await db.select().from(usersTable)
      .where(sql`LOWER(${usersTable.email}) = ${emailNorm}`)
      .limit(1);
    if (existing.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const isAdmin = body.role === "admin";
    const [user] = await db.insert(usersTable).values({
      name: body.name,
      email: body.email,
      passwordHash: hashPassword(body.password),
      role: body.role,
      isApproved: isAdmin,
    }).returning();
    await db.insert(userSettingsTable).values({ userId: user.id }).onConflictDoNothing();

    if (!isAdmin) {
      sendNewUserNotificationToAdmin({ name: body.name, email: body.email, role: body.role }, appUrl()).catch(console.error);
      createNotification({
        type: "REGISTRATION",
        title: `New sign-up: ${body.name}`,
        message: `${body.name} (${body.email}) registered and is awaiting approval.`,
        relatedId: user.id,
        relatedType: "user",
      }).catch(console.error);
      return res.status(202).json({ pending: true, message: "Account pending admin approval" });
    }

    const token = await createSession(user.id);
    const { passwordHash, ...safeUser } = user;
    return res.status(201).json({ user: safeUser, token });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const schema = z.object({ email: z.string(), password: z.string() });
    const body = schema.parse(req.body);
    const emailNorm = body.email.trim().toLowerCase();
    const [user] = await db.select().from(usersTable)
      .where(sql`LOWER(${usersTable.email}) = ${emailNorm}`)
      .limit(1);
    if (!user || user.passwordHash !== hashPassword(body.password.trim())) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (!user.isApproved) {
      return res.status(403).json({ error: "Account pending approval", code: "PENDING_APPROVAL" });
    }
    const token = await createSession(user.id);
    const { passwordHash, ...safeUser } = user;
    return res.json({ user: safeUser, token });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post("/logout", async (req: any, res) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    await db.delete(sessionsTable).where(eq(sessionsTable.token, token)).catch(() => {});
  }
  return res.json({ ok: true });
});

router.get("/me", requireAuth, async (req: any, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    const { passwordHash, ...safeUser } = user;
    return res.json(safeUser);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post("/change-password", requireAuth, async (req: any, res) => {
  try {
    const schema = z.object({ currentPassword: z.string(), newPassword: z.string().min(6) });
    const body = schema.parse(req.body);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId)).limit(1);
    if (!user || user.passwordHash !== hashPassword(body.currentPassword)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
    await db.update(usersTable).set({ passwordHash: hashPassword(body.newPassword) }).where(eq(usersTable.id, req.userId));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
