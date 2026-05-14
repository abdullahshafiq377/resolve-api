# Articles API Reference

Base URL: `http://localhost:8000/api/articles`

> Routes marked **[auth]** require an `Authorization` header (JWT — not yet enforced, returns `501` in production until implemented).

---

## Endpoints Overview

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/` | List articles | No |
| GET | `/slug-check?title=` | Real-time slug preview | No |
| GET | `/:slug` | Get single article | No |
| POST | `/upload-url` | Get signed S3 upload URL for images | Yes |
| POST | `/` | Create article | Yes |
| PUT | `/:id` | Update article | Yes |
| DELETE | `/:id` | Delete article | Yes |

---

## Data Shape

```ts
interface Article {
  _id: string;
  title: string;
  slug: string;
  excerpt: string;
  author: string;
  category: 'Politics' | 'Defence' | 'Geopolitics' | 'Economy' | 'Opinion';

  featuredImage: string;         // Full URL to the hero image
  featuredImageCaption?: string; // Optional caption displayed below the hero image
  featuredImageKey?: string;     // S3 object key (used internally)

  template: 'standard' | 'longform' | 'visual';
  publishDate: string;           // ISO 8601

  featured: boolean;             // Appears in Hero carousel (max 5 simultaneously)
  highlight: boolean;            // Appears in Highlight section (max 3 simultaneously)

  status: 'draft' | 'published';
  body: object;                  // EditorJS OutputData — only returned by GET /:slug

  createdAt: string;
  updatedAt: string;
}
```

> The `body` field is **excluded** from list responses (`GET /`) for performance. It is only returned by `GET /:slug`.

---

## Promotion Flags and Limits

| Flag | Section | Max simultaneous |
|------|---------|-----------------|
| `featured` | Hero carousel | **5** |
| `highlight` | Highlight section | **3** |

An article can carry both flags simultaneously. Limits are checked independently.

Attempting to exceed a limit returns:
```json
{ "error": "Featured limit reached (max 5)" }
{ "error": "Highlight limit reached (max 3)" }
```

---

## GET / — List Articles

Returns paginated list of articles. `body` is excluded.

**Query Parameters**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| category | string | no | — | Filter by `Politics` `Defence` `Geopolitics` `Economy` `Opinion` |
| status | string | no | — | Filter by `draft` or `published` |
| template | string | no | — | Filter by `standard` `longform` `visual` |
| featured | `"true"` | no | — | Return only `featured: true` articles |
| highlight | `"true"` | no | — | Return only `highlight: true` articles |
| excludeId | string | no | — | Exclude one article by `_id`. Silently ignored if malformed. |
| page | number | no | `1` | Page number |
| limit | number | no | `10` | Results per page (max 100) |

**Homepage endpoint examples**

```
# Hero carousel (up to 5)
GET /api/articles?status=published&featured=true

# Highlight section (up to 3)
GET /api/articles?status=published&highlight=true

# Latest news (exactly 3)
GET /api/articles?status=published&limit=3

# Long reads section (latest 3 longform articles)
GET /api/articles?status=published&template=longform&limit=3

# Related posts (same category, exclude current article)
GET /api/articles?status=published&category=Defence&limit=4&excludeId=6642f1a3c3e4b2a1d0e5f789
```

**Response — 200 OK**
```json
{
  "data": [
    {
      "_id": "6642f1a3c3e4b2a1d0e5f789",
      "title": "Pakistan's New Defence Policy",
      "slug": "pakistans-new-defence-policy",
      "excerpt": "A deep dive into the shifting priorities...",
      "author": "Ahmed Raza",
      "category": "Defence",
      "featuredImage": "https://resolve-webapp-data.s3.eu-north-1.amazonaws.com/articles/featured/2026/05/uuid.jpg",
      "featuredImageCaption": "Defence Minister at the press conference",
      "featuredImageKey": "articles/featured/2026/05/uuid.jpg",
      "template": "standard",
      "publishDate": "2026-05-12T10:00:00.000Z",
      "featured": true,
      "highlight": false,
      "status": "published",
      "createdAt": "2026-05-12T11:00:00.000Z",
      "updatedAt": "2026-05-12T11:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 42,
    "page": 1,
    "limit": 10,
    "pages": 5
  }
}
```

---

## GET /slug-check?title= — Real-time Slug Preview

Generates a unique slug from a title without creating an article.

**Query Parameters**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | yes | Raw article title |

**Example**
```
GET /api/articles/slug-check?title=Pakistan's New Defence Policy
```

**Response — 200 OK**
```json
{ "slug": "pakistans-new-defence-policy" }
```

Collision → counter suffix appended automatically:
```json
{ "slug": "pakistans-new-defence-policy-1" }
```

**Error — 400**
```json
{ "error": "title query param required" }
```

---

## GET /:slug — Get Single Article

Returns full article including `body` (EditorJS `OutputData`).

**Example**
```
GET /api/articles/pakistans-new-defence-policy
```

**Response — 200 OK**
```json
{
  "_id": "6642f1a3c3e4b2a1d0e5f789",
  "title": "Pakistan's New Defence Policy",
  "slug": "pakistans-new-defence-policy",
  "excerpt": "A deep dive into the shifting priorities...",
  "author": "Ahmed Raza",
  "category": "Defence",
  "featuredImage": "https://resolve-webapp-data.s3.eu-north-1.amazonaws.com/articles/featured/2026/05/uuid.jpg",
  "featuredImageCaption": "Defence Minister at the press conference",
  "featuredImageKey": "articles/featured/2026/05/uuid.jpg",
  "template": "standard",
  "publishDate": "2026-05-12T10:00:00.000Z",
  "featured": true,
  "highlight": false,
  "status": "published",
  "body": {
    "version": "2.29.1",
    "time": 1747044000000,
    "blocks": [
      {
        "id": "abc123",
        "type": "paragraph",
        "data": { "text": "Pakistan's defence policy has undergone significant changes..." }
      }
    ]
  },
  "createdAt": "2026-05-12T11:00:00.000Z",
  "updatedAt": "2026-05-12T11:00:00.000Z"
}
```

**Error — 404**
```json
{ "error": "Article not found" }
```

---

## POST /upload-url — Get Signed S3 Upload URL `[auth]`

Returns a signed S3 URL for direct browser→S3 image upload. Use before creating or updating an article that has a new image.

**Headers**
```
Content-Type: application/json
```

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| filename | string | yes | Original filename including extension |
| contentType | string | yes | MIME type |
| fileSize | number | yes | File size in bytes |
| type | string | no | `"featured"` (default) or `"body"` |

**Accepted file types**

| type | Accepted MIME types | Accepted extensions | Max size |
|------|--------------------|--------------------|----------|
| `featured` | `image/jpeg`, `image/png`, `image/webp` | `.jpg`, `.jpeg`, `.png`, `.webp` | 10 MB |
| `body` | `image/jpeg`, `image/png`, `image/webp`, `image/gif` | `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` | 10 MB |

**Example**
```json
{
  "filename": "defence-minister.jpg",
  "contentType": "image/jpeg",
  "fileSize": 512000,
  "type": "featured"
}
```

**Response — 200 OK**
```json
{
  "uploadUrl": "https://resolve-webapp-data.s3.eu-north-1.amazonaws.com/articles/featured/2026/05/uuid.jpg?X-Amz-...",
  "fileKey": "articles/featured/2026/05/550e8400-e29b-41d4-a716-446655440000.jpg",
  "publicUrl": "https://resolve-webapp-data.s3.eu-north-1.amazonaws.com/articles/featured/2026/05/550e8400-e29b-41d4-a716-446655440000.jpg"
}
```

> The signed URL expires in **15 minutes**.

**Upload flow**

1. Call `POST /api/articles/upload-url` with file metadata.
2. PUT the file directly to `uploadUrl` from the browser — set `Content-Type` to the file's MIME type, no auth headers:
   ```ts
   await fetch(uploadUrl, {
     method: 'PUT',
     headers: { 'Content-Type': contentType },
     body: file,
   });
   ```
3. On success, pass `publicUrl` as `featuredImage` and `fileKey` as `featuredImageKey` when calling create or update.

**Error Responses**

| Status | Cause |
|--------|-------|
| 400 | Wrong MIME type, wrong extension, file exceeds 10 MB, or missing required fields |

---

## POST / — Create Article `[auth]`

**Headers**
```
Content-Type: application/json
```

**Request Body**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| title | string | yes | — |
| excerpt | string | yes | — |
| author | string | yes | — |
| category | string | yes | `Politics` `Defence` `Geopolitics` `Economy` `Opinion` |
| featuredImage | string | yes | Full URL (from upload flow) |
| featuredImageCaption | string | no | — |
| featuredImageKey | string | no | S3 key from upload flow |
| template | string | yes | `standard` `longform` `visual` |
| publishDate | string | yes | ISO 8601 |
| status | string | no | `draft` (default) or `published` |
| body | object | yes | EditorJS `OutputData` |
| featured | boolean | no | Default `false`. Rejected if 5 already exist. |
| highlight | boolean | no | Default `false`. Rejected if 3 already exist. |

> `slug` is not accepted — always server-generated from `title`.

**Response — 201 Created**

Returns the full created article object (same shape as `GET /:slug`).

**Error Responses**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "Featured limit reached (max 5)" }` | Already 5 featured articles |
| 400 | `{ "error": "Highlight limit reached (max 3)" }` | Already 3 highlight articles |
| 400 | `{ "error": "Article validation failed: ..." }` | Missing required field or enum violation |

---

## PUT /:id — Update Article `[auth]`

Partial update — send only the fields to change.

**Path Parameter**

| Param | Type | Description |
|-------|------|-------------|
| id | string | MongoDB `_id` |

**Request Body**

Same fields as POST, all optional. Notes:
- Sending `title` regenerates and deduplicates the slug automatically.
- `slug` is silently ignored if sent.
- `publishDate` accepts ISO 8601 string.
- Limit checks for `featured` and `highlight` only trigger when toggling from `false → true`. Setting the same value again (e.g. article is already featured, send `featured: true`) is a no-op and passes through.

**Example — publish and feature an article**
```json
{ "status": "published", "featured": true }
```

**Example — update image after re-upload**
```json
{
  "featuredImage": "https://resolve-webapp-data.s3.eu-north-1.amazonaws.com/articles/featured/2026/05/new-uuid.jpg",
  "featuredImageKey": "articles/featured/2026/05/new-uuid.jpg",
  "featuredImageCaption": "Updated caption"
}
```

**Response — 200 OK**

Returns the full updated article object.

**Error Responses**

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "Featured limit reached (max 5)" }` | Already 5 featured articles |
| 400 | `{ "error": "Highlight limit reached (max 3)" }` | Already 3 highlight articles |
| 400 | `{ "error": "Article validation failed: ..." }` | Invalid enum value |
| 404 | `{ "error": "Article not found" }` | No article with that `_id` |

---

## DELETE /:id — Delete Article `[auth]`

Permanently deletes an article.

**Example**
```
DELETE /api/articles/6642f1a3c3e4b2a1d0e5f789
```

**Response — 204 No Content**

Empty body on success.

**Error Responses**

| Status | Body | Cause |
|--------|------|-------|
| 404 | `{ "error": "Article not found" }` | No article with that `_id` |
