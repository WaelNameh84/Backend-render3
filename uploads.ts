import { Router, type Request, type Response } from "express";
import path from "path";
import { requireAuth } from "./auth";
import { objectStorageClient } from "../lib/objectStorage";

const router = Router();

const BUCKET_ID = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
const USE_OBJECT_STORAGE = !!BUCKET_ID;

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

router.post("/uploads", requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileName, contentType, fileData } = req.body;
    if (!fileName || !fileData) {
      return res.status(400).json({ error: "fileName and fileData are required" });
    }
    const ext = path.extname(fileName) || "";
    const mime = contentType || MIME_MAP[ext.toLowerCase()] || "application/octet-stream";

    if (USE_OBJECT_STORAGE) {
      const { randomUUID } = await import("crypto");
      const saveName = `${randomUUID()}${ext}`;
      const base64Data = fileData.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      const bucket = objectStorageClient.bucket(BUCKET_ID);
      const file = bucket.file(`uploads/${saveName}`);
      await file.save(buffer, { contentType: mime, resumable: false });
      return res.json({ path: `/api/uploads/${saveName}`, name: fileName });
    }

    /* ── Fallback: return the data URL directly so it persists in the DB ── */
    const dataUrl = fileData.startsWith("data:")
      ? fileData
      : `data:${mime};base64,${fileData}`;
    return res.json({ path: dataUrl, name: fileName });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get("/uploads/:filename", async (req: Request, res: Response) => {
  try {
    const filename = req.params.filename;
    if (!filename || filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const ext = path.extname(filename).toLowerCase();
    const mime = MIME_MAP[ext] ?? "application/octet-stream";

    if (USE_OBJECT_STORAGE) {
      const bucket = objectStorageClient.bucket(BUCKET_ID);
      const file = bucket.file(`uploads/${filename}`);
      const [exists] = await file.exists();
      if (!exists) {
        return res.status(404).json({ error: "File not found" });
      }
      const [data] = await file.download();
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "public, max-age=31536000");
      return res.send(data);
    }

    return res.status(404).json({ error: "File not found" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
