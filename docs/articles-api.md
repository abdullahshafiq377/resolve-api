# Articles API Reference

Base URL: `http://localhost:8000/api/articles`

> Routes marked **[auth]** require an `Authorization` header (JWT — not yet enforced, shell only).

---

## Endpoints Overview

| Method   | Path                      | Description              | Auth |
|----------|---------------------------|--------------------------|------|
| GET      | `/`                       | List articles            | No   |
| GET      | `/slug-check?title=`      | Real-time slug preview   | No   |
| GET      | `/:slug`                  | Get single article       | No   |
| POST     | `/`                       | Create article           | Yes  |
| PUT      | `/:id`                    | Update article           | Yes  |
| DELETE   | `/:id`                    | Delete article           | Yes  |

---

## GET / — List Articles

Returns paginated list of articles. `body` field is excluded for performance.

**Query Parameters**

| Param    | Type   | Required | Default | Description                                             |
|----------|--------|----------|---------|---------------------------------------------------------|
| category | string | no       | —       | Filter by `Politics` `Defence` `Geopolitics` `Economy` `Opinion` |
| status   | string | no       | —       | Filter by `draft` or `published`                        |
| page     | number | no       | `1`     | Page number                                             |
| limit    | number | no       | `10`    | Results per page                                        |

**Example**
```
GET /api/articles?category=Defence&status=published&page=1&limit=5
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
      "featuredImage": "https://example.com/images/defence.jpg",
      "template": "standard",
      "publishDate": "2026-05-12T10:00:00.000Z",
      "status": "published",
      "createdAt": "2026-05-12T11:00:00.000Z",
      "updatedAt": "2026-05-12T11:00:00.000Z"
    }
  ],
  "pagination": {
    "total": 42,
    "page": 1,
    "limit": 5,
    "pages": 9
  }
}
```

---

## GET /slug-check?title= — Real-time Slug Preview

Generates a unique slug from a title without creating an article. Use this to show a live slug preview as the user types the title.

**Query Parameters**

| Param | Type   | Required | Description        |
|-------|--------|----------|--------------------|
| title | string | yes      | Raw article title  |

**Example**
```
GET /api/articles/slug-check?title=Pakistan's New Defence Policy
```

**Response — 200 OK**
```json
{ "slug": "pakistans-new-defence-policy" }
```

If a slug collision exists the server appends a counter automatically:
```json
{ "slug": "pakistans-new-defence-policy-1" }
```

**Error — 400**
```json
{ "error": "title query param required" }
```

> **Suggested frontend usage:** debounce the title input (300–500ms), call this endpoint on each change, display the returned slug as a read-only preview field.

---

## GET /:slug — Get Single Article

Returns full article including `body` (EditorJS `OutputData`).

**Path Parameter**

| Param | Type   | Description           |
|-------|--------|-----------------------|
| slug  | string | Article slug          |

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
  "featuredImage": "https://example.com/images/defence.jpg",
  "template": "standard",
  "publishDate": "2026-05-12T10:00:00.000Z",
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

## POST / — Create Article `[auth]`

**Headers**
```
Content-Type: application/json
```

**Request Body**

| Field         | Type   | Required | Constraints                                              |
|---------------|--------|----------|----------------------------------------------------------|
| title         | string | yes      | —                                                        |
| excerpt       | string | yes      | —                                                        |
| author        | string | yes      | —                                                        |
| category      | string | yes      | `Politics` `Defence` `Geopolitics` `Economy` `Opinion`  |
| featuredImage | string | yes      | URL string                                               |
| template      | string | yes      | `standard` `longform` `visual`                          |
| publishDate   | string | yes      | ISO 8601 string — stored as `Date` in DB                |
| status        | string | no       | `draft` (default) or `published`                        |
| body          | object | yes      | EditorJS `OutputData` — `{ version, time, blocks[] }`  |

> `slug` is **not accepted** — always server-generated from `title`.

**Example Request Body**
```json
{
  "title": "Pakistan's New Defence Policy",
  "excerpt": "A deep dive into the shifting priorities of Pakistan's defence establishment.",
  "author": "Ahmed Raza",
  "category": "Defence",
  "featuredImage": "https://example.com/images/defence.jpg",
  "template": "standard",
  "publishDate": "2026-05-12T10:00:00.000Z",
  "status": "draft",
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
  }
}
```

**Response — 201 Created**

Returns the full created article object (same shape as GET `/:slug` response).

**Error Responses**

| Status | Body                                             | Cause                           |
|--------|--------------------------------------------------|---------------------------------|
| 400    | `{ "error": "Article validation failed: ..." }` | Missing required field or enum  |
| 500    | `{ "error": "Internal Server Error" }`          | Server / DB error               |

---

## PUT /:id — Update Article `[auth]`

Partial update — send only the fields to change. All fields are optional.

**Path Parameter**

| Param | Type   | Description         |
|-------|--------|---------------------|
| id    | string | MongoDB `_id`       |

**Headers**
```
Content-Type: application/json
```

**Request Body**

Same fields as POST, all optional. Notes:
- If `title` is sent, `slug` is **automatically regenerated** and deduplicated.
- If `slug` is sent it is **silently ignored** — server always owns the slug.
- `publishDate` accepts ISO 8601 string, converted to `Date`.

**Example — publish a draft**
```json
{ "status": "published" }
```

**Example — update title and excerpt**
```json
{
  "title": "Pakistan's Evolving Defence Strategy",
  "excerpt": "Updated analysis of the latest policy shifts."
}
```

**Response — 200 OK**

Returns the full updated article object.

**Error Responses**

| Status | Body                                             | Cause                           |
|--------|--------------------------------------------------|---------------------------------|
| 400    | `{ "error": "Article validation failed: ..." }` | Invalid enum value              |
| 404    | `{ "error": "Article not found" }`              | No article with that `_id`      |
| 500    | `{ "error": "Internal Server Error" }`          | Server / DB error               |

---

## DELETE /:id — Delete Article `[auth]`

Permanently deletes an article.

**Path Parameter**

| Param | Type   | Description   |
|-------|--------|---------------|
| id    | string | MongoDB `_id` |

**Example**
```
DELETE /api/articles/6642f1a3c3e4b2a1d0e5f789
```

**Response — 204 No Content**

Empty body on success.

**Error Responses**

| Status | Body                               | Cause                      |
|--------|------------------------------------|----------------------------|
| 404    | `{ "error": "Article not found" }` | No article with that `_id` |
| 500    | `{ "error": "Internal Server Error" }` | Server / DB error      |
