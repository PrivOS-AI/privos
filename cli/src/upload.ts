import fs from "node:fs";
import path from "node:path";
import { isUsage, usage } from "./usage.js";

/** One local file sent as a multipart part. */
export interface UploadFile {
  /** Multipart field name the hub route reads. */
  field: string;
  name: string;
  type: string;
  bytes: Buffer;
}

/** A multipart body: one file part and plain text fields. */
export interface UploadForm {
  file: UploadFile;
  fields: Record<string, string>;
}

/**
 * The type the hub stores and renders by: an image is shown inline only when its part says image/*.
 * Anything not listed goes as application/octet-stream, which the hub keeps as a plain download.
 */
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
};

export function mimeOf(name: string): string {
  return TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Reads --file before any request, so a wrong path fails as a usage error and nothing is sent. */
/** `~/` expands against `home`; without one (a library caller) it is refused, so no path depends on the host user. */
export function readUpload(flagValue: string, field: string, home?: string): UploadFile {
  if (flagValue.startsWith("~/") && (home ?? "") === "") {
    throw usage(`--file ${JSON.stringify(flagValue)}: "~/" needs HOME; pass an absolute path`);
  }
  const file = flagValue.startsWith("~/") ? path.join(home!, flagValue.slice(2)) : flagValue;
  let bytes: Buffer;
  try {
    if (!fs.statSync(file).isFile()) throw usage(`--file ${JSON.stringify(flagValue)} is not a regular file`);
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (isUsage(err)) throw err;
    throw usage(`--file ${JSON.stringify(flagValue)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const name = path.basename(file);
  return { field, name, type: mimeOf(name), bytes };
}

/** The bytes and content type (with its boundary) of a multipart body, built by the platform's own encoder. */
export async function encodeForm(form: UploadForm): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string }> {
  const data = new FormData();
  data.set(form.file.field, new Blob([new Uint8Array(form.file.bytes)], { type: form.file.type }), form.file.name);
  for (const [key, value] of Object.entries(form.fields)) data.set(key, value);
  const req = new Request("http://form.invalid/", { method: "POST", body: data });
  return { body: new Uint8Array(await req.arrayBuffer()), contentType: req.headers.get("content-type") ?? "" };
}

/** What a dry run prints for a multipart body: the fields and the file's name, type and size, never its bytes. */
export function previewForm(form: UploadForm): Record<string, unknown> {
  const { field, name, type, bytes } = form.file;
  return { multipart: { file: { field, name, type, size: bytes.length }, fields: form.fields } };
}
