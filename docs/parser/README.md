# Run the PrivOS Parser yourself

The PrivOS Parser turns the files people upload to PrivOS Hub into Markdown that
agents and search can read: text PDFs, scanned PDFs, photos of documents, and a
set of data and mail formats. PrivOS Community Edition normally uses the
PrivOS-hosted parser, which is billed in AI credit. This guide is for the other
option: you run the parser on your own host, point it at a vision model you
choose, and pay no parser credit.

The parser ships as one public Docker image, `ghcr.io/privos-ai/privos-parser`,
licensed under the PrivOS Community License 1.0 (PCL-1.0, the same licence as
the Hub image). The licence text is at `/LICENSE` inside the image. The parser's
source code is not published.

Files used in this guide come from the PrivOS release assets
(`https://github.com/PrivOS-AI/privos/releases/latest/download/`):
`compose.parser.yml`, `compose.parser.same-host.yml` and `env.parser.template`.
The release copy has the image pinned by digest; the copy in the git tree has a
placeholder instead.

## How it works

```text
PrivOS Hub --upload bytes + key--> parser API --> Redis (job queue)
                                        |           MongoDB (job records)
                                        v
                                  parser worker --> your vision API (one call per page)
                                        |
                                        +--> writes <room>/.markdown/<file>.md
                                             into the Hub's S3-compatible bucket
```

**Every PDF page is rendered to an image and sent to the vision API you
configure, text PDFs included, and so is every uploaded picture.** The parser
does not use the text layer of a PDF, so the whole content of every PDF reaches
the vision API. Most hosted APIs bill per call or per image, and the parser makes
one call for each page: a 200-page text PDF costs 200 calls, like a 200-page
scan. Only CSV, XLSX, plain-text files and mail bodies are read on the parser
host without a vision call.

## Requirements

| | |
|---|---|
| Host | Linux, amd64 or arm64, Docker Engine 24+ with the Compose plugin v2 |
| Memory | about 5 GB free for the stack at the default settings (parser 3 GB, MongoDB 1 GB, Redis 256 MB) |
| CPU and disk | 2 vCPU; 5 GB for the image and state volumes |
| Vision API | any OpenAI-compatible chat-completions endpoint that accepts images: a hosted API, or a server you run (vLLM, Ollama, LM Studio and similar). No GPU is needed on the parser host |
| PrivOS Hub | a running Community Edition Hub, and its file-storage credentials (see step 2) |
| Network | the parser host reaches the vision API and the Hub's S3 endpoint; the Hub reaches the parser |

When the vision API is a hosted service, the rendered image of every PDF page,
text PDFs included, and every uploaded picture is sent to it. Choose the
provider with that in mind, and check its price per call or per image.

## What is supported

| Input | Supported |
|---|---|
| PDF (text, scanned or mixed), JPG, PNG, TIFF, BMP, GIF, WebP | yes. Every PDF page is rendered to an image and read by your vision model, so a text PDF costs one vision call per page like a scan does. A password-protected, damaged or empty PDF fails with `standalone_pdf_unreadable` or `standalone_pdf_has_no_pages` |
| CSV, XLSX, TXT, Markdown, EML (with attachments of these types), ZIP and TAR archives of these | yes |
| RAR | no: the image has no RAR extractor, so a RAR archive fails with the archive handler's error (only an archive whose files were stored without compression can still be read). Unpack the archive and upload its files, or re-pack it as ZIP |
| Word (DOCX, DOC), PowerPoint (PPTX, PPT), legacy Excel (XLS), HWP | no: they need the separately licensed Office runtime that is not part of this image, and the job fails with a typed error |

The image reads PDFs with pypdfium2 (Apache-2.0 or BSD-3-Clause). It contains no
PyMuPDF, Poppler or Ghostscript, so no AGPL or GPL PDF engine is distributed with
it. `/usr/share/doc/privos-parser/THIRD-PARTY-NOTICES` lists every Python package
with its licence and reproduces the licence texts, including the notices of the
components inside PDFium (FreeType, ICU, libjpeg-turbo, libpng, zlib and
others).

There is one parse mode. Every PDF page and every picture gets one full-page read
from your vision model. A room set to *Accuracy* in the Hub is processed exactly like
*Flash*, and layout detection and per-region specialist models are not used.

## 1. Get the files

Download the three files into an empty directory on the parser host, for example
`/opt/privos-parser` (not the Hub's own directory), and create `.env` from the
template:

```bash
mkdir -p /opt/privos-parser && cd /opt/privos-parser
base=https://github.com/PrivOS-AI/privos/releases/latest/download
curl -fsSLO "$base/compose.parser.yml"
curl -fsSLO "$base/compose.parser.same-host.yml"
curl -fsSL  "$base/env.parser.template" -o .env
chmod 600 .env
```

The SHA-256 of each file is in the release's signed `versions.json`
(`files.<name>.sha256`).

## 2. Configure `.env`

Open `.env` and fill in the empty values.

**Image.** Nothing to set. `compose.parser.yml` pins the image by tag and
digest, so the parser you run is the one this release was tested with.

**Access key.** Generate the key PrivOS Hub will present. It must be exactly 64
lowercase hex characters:

```bash
openssl rand -hex 32        # paste into PARSER_API_KEY
openssl rand -hex 24        # paste into MONGO_PASSWORD
```

**Vision API.**

| Variable | Value |
|---|---|
| `VISION_API_BASE_URL` | the server's base URL, with or without `/v1`: `https://api.example.com`, `http://gpu-host:8000`, `http://host.docker.internal:11434` |
| `VISION_API_MODEL` | the model name the server expects in the `model` field |
| `VISION_API_KEY` | the API key; leave empty for a local server without one |
| `VISION_API_MAX_TOKENS` | output limit per page; keep it at or below the model's own limit |
| `VISION_API_MAX_CONCURRENCY` | pages read in parallel; lower it if the API rate-limits you |
| `VISION_API_EXTRA_BODY` | leave `{}` for hosted APIs. Servers that need extra request fields take them as JSON, for example vLLM: `{"chat_template_kwargs":{"enable_thinking":false}}` |

The parser sends a standard `chat.completions` request with the page as an
`image_url` part and a fixed transcription prompt, at temperature 0.

**Storage.** The parser writes its Markdown into the same bucket PrivOS Hub
uses for files. Copy the values from the `.env` of your Hub bundle:

| Parser `.env` | Hub bundle `.env` |
|---|---|
| `RUSTFS_ACCESS_KEY` | `RUSTFS_ACCESS_KEY` |
| `RUSTFS_SECRET_KEY` | `RUSTFS_SECRET_KEY` |
| `RUSTFS_BUCKET` | `RUSTFS_BUCKET` (default `privos`) |

`RUSTFS_ENDPOINT` is `host:port` without a scheme. The default,
`privos-rustfs:9000`, is right when the Hub bundle runs on the same host with its
default project name. Set `RUSTFS_SECURE=true` for an HTTPS endpoint.

**Where the Hub runs.**

- *Same host* (the default): `COMPOSE_FILE=compose.parser.yml:compose.parser.same-host.yml`.
  The parser joins the Hub's Docker network (`PRIVOS_NETWORK`, default
  `privos-sandbox-net`), so the Hub reaches it at `http://privos-parser:8000` and
  the parser reaches the Hub's RustFS directly.
- *Another host*: set `COMPOSE_FILE=compose.parser.yml`, point `RUSTFS_ENDPOINT` at an
  address of the Hub's object store that the parser host can reach, and publish
  the parser with `PARSER_BIND_ADDRESS=0.0.0.0`. Put a TLS reverse proxy in front
  of the parser before you do: the access key travels in every request.

The parser keeps its own state (queue and job records) in the bundled Redis and
MongoDB, which are not published on the host.

## 3. Start the parser

```bash
docker compose up -d
docker compose ps                        # parser, redis and mongo should become healthy
curl -fsS http://127.0.0.1:8000/health   # {"status":"healthy",...}
```

The first start pulls the image anonymously; no registry login is needed. The
first pull downloads the Redis, MongoDB and parser images.

## 4. Connect PrivOS Hub

Sign in as an administrator and open **Administration → Settings → Document
Parser**:

| Setting | Value |
|---|---|
| Use Document Parser configs from .env | **off** (when it is on, the parser from the environment wins over the values below) |
| Document Parser URL | `http://privos-parser:8000` (same host), or the HTTPS address of your reverse proxy |
| Document Parser API Key | the `PARSER_API_KEY` from your `.env` |

This parser then serves every room. To use it for one room only, open the
room's **Room Settings → Advanced → Document Parser**, enter the same URL and
key, choose **Test Connection**, then **Validate & Save**. A room's own parser
takes precedence over the workspace setting.

Parsing runs for rooms with **Auto Parse** on. Make sure **Auto-embed uploaded
files** is enabled in the Hub's file-upload settings if you want uploads parsed
without a manual action.

There is nothing to enter for storage in the Hub: the parser writes to the
bucket named by its own `RUSTFS_*` values, so they must match the Hub's file
storage. A room with its own storage override in the Hub is not covered, because
this parser writes to a single bucket.

## 5. Check it with one scanned PDF

1. In a room with Auto Parse on, upload a scanned PDF.
2. The file shows as parsed after a few seconds per page. In the room's file
   browser, the hidden `.markdown` folder now holds `<file>.pdf.md` with the
   recognised text.
3. If nothing appears, follow the logs while you upload again:

   ```bash
   docker compose logs -f parser
   ```

To test the parser on its own, without the Hub (this writes into the Hub's
bucket under the folder name you give as `channel_id`, so use a throwaway name):

```bash
KEY=$(grep ^PARSER_API_KEY .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $KEY" \
  -F file=@scan.pdf -F file_id=smoke-1 -F channel_id=parser-smoke \
  -F file_path=parser-smoke/scan.pdf -F mode=flash \
  http://127.0.0.1:8000/api/v1/jobs/process
# -> {"job_id":"file-processing-queue:1", ...}
curl -s -H "Authorization: Bearer $KEY" \
  http://127.0.0.1:8000/api/v1/jobs/status/file-processing-queue:1
# -> "status":"completed"
```

## Upgrade

Each PrivOS release names the parser image it was tested with. To move to it,
download `compose.parser.yml` and `compose.parser.same-host.yml` from the new
release again (step 1; keep your `.env`), then:

```bash
docker compose pull
docker compose up -d
```

If the new `env.parser.template` lists a setting your `.env` lacks, copy it over.
The state volumes are kept. On stop the parser first finishes the pages it is
reading, for up to ten minutes, and jobs still queued resume after the restart.
The Markdown it wrote lives
in the Hub's bucket and is backed up with the Hub; the parser's own volumes hold
only queue and job bookkeeping.

## Troubleshooting

Start with `docker compose ps` and `docker compose logs parser`.

| Symptom | Cause and fix |
|---|---|
| The parser container restarts and the log ends with `standalone_operator_api_key_invalid` | `PARSER_API_KEY` is not exactly 64 lowercase hex characters. Generate it with `openssl rand -hex 32` |
| `standalone_vision_api_base_url_invalid`, `standalone_vision_api_model_required`, `standalone_storage_credentials_required` | The named value in `.env` is empty or malformed |
| `rustfs_startup_readiness_failed` | The parser cannot reach the bucket. Check `RUSTFS_ENDPOINT`, the access key and secret, that the bucket exists, and, on the same host, that `COMPOSE_FILE` includes `compose.parser.same-host.yml` and `PRIVOS_NETWORK` names the Hub's network |
| `redis_durability_policy_mismatch` | Redis was started without the required persistence flags. Keep the `redis` service command of `compose.parser.yml` unchanged |
| `redis_ledger_identity_mismatch` | `RUSTFS_ENDPOINT` or `RUSTFS_BUCKET` changed after the first start, and the state in Redis belongs to the old bucket. Restore the old values, or discard the state with `docker compose down -v` (queued jobs are lost) |
| The Hub says the connection test failed or returns 401 | The key in the Hub differs from `PARSER_API_KEY`, or the Hub cannot reach the parser: `docker exec <hub container> curl -fsS http://privos-parser:8000/health` |
| Uploads are never parsed | Auto Parse is off for the room, or *Use Document Parser configs from .env* is still on in the Hub settings |
| A job ends `failed` with `OcrBackendError` | The vision API is unreachable or rejects the request. Check the base URL, model name and key. A `400` about an unknown field means `VISION_API_EXTRA_BODY` must be empty for that API |
| Pages come back as `[!OCR-REVIEW]` or text is cut off | The model returned an incomplete page. Raise `VISION_API_MAX_TOKENS` up to the model's limit, or use a stronger model |
| `standalone_pdf_unreadable` | The PDF is password-protected, damaged or not a PDF. Remove the password or re-export it, then upload it again |
| `unsupported_format` or `born_digital_package_feature_rejected` | The input is a Word, PowerPoint or legacy Office file, or a RAR archive, which this image does not read. Export Office files to PDF; unpack RAR archives or re-pack them as ZIP |
| The vision API rate-limits or times out | Lower `VISION_API_MAX_CONCURRENCY` and `PARSER_WORKER_CONCURRENCY`; raise `VISION_API_TIMEOUT_SECONDS` for slow servers |

## Remove

```bash
docker compose down        # keep the state volumes
docker compose down -v     # also delete them
```

The Markdown already written stays in the Hub's bucket.
