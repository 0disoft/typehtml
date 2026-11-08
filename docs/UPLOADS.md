# Request-owned uploads

File transport is opt-in. Existing forms continue to accept only URL-encoded bodies with their existing limits. Declare fixed canonical upload names separately from string fields:

```ts
const form = defineSchemaForm({
  id: 'document.save', path: '/documents', fields: {},
  uploads: { attachment: { required: true, accept: ['.pdf'] } },
  multipart: { maxFileBytes: 2 * 1024 * 1024 },
  input: documentInputSchema, output: publicResultSchema,
});
// getFormProps(form) supplies multipart/form-data.
// getSchemaFieldProps(form, 'attachment') supplies a native file input.
```

Use `createSchemaFormHandler` with the normal authentication, CSRF, authorization, operation and public projection hooks. The input validator receives a request-owned `UploadedFile` with `kind`, `field`, `name`, `type`, `size` and `stream()`. A multiple field receives an ordered array. An absent optional single file is omitted; an absent multiple field is `[]`. Empty browser placeholders do not count as selected files, while a named zero-byte file does. `accept` and client MIME/name are untrusted hints; inspect actual contents before committing a durable file.

The default store uses private temporary directories and generated storage names, never a client filename as a path. Authentication and rate limiting run before reading the body. CSRF and input validation run before authorization; only an authorized `execute` should copy the file to durable storage. Await that copy inside `execute`. Streams expire and temporary files are removed before the handler returns, on success, invalid input, denial, exceptions, or cancellation. Files must be selected again after a 422. No POST or storage operation is automatically retried.

| Multipart policy | Default |
| --- | --- |
| Complete body including framing | 10 MiB |
| One file payload | 2 MiB |
| All selected file payloads | 8 MiB |
| Selected files | 4 |
| Parts including protocol fields | 64, additionally bounded by `limits.maxEntries` (16 by default) |
| Part headers | Parser cap of 16 KiB and 100 header pairs |
| Read deadline | 30 seconds |

`limits.maxKeyBytes` and `limits.maxValueBytes` still bound text names and UTF-8 values. Text bytes are decoded strictly as UTF-8; unsupported charset/transfer encodings and duplicate protocol/scalar keys fail. Oversized headers, parts, body and payloads are rejected. The parser feeds at most 4 KiB into queued storage work before awaiting it, so file payloads are not accumulated in memory.

`uploadStore` optionally implements `TemporaryUploadStore.open(metadata, signal)` returning `write`, `finish`, and `dispose`. Custom stores must provide private temporary storage, respect cancellation and settle their I/O; the library cannot stop arbitrary non-cooperative host code. Storage failures produce a generic 500 and preserve the original `cause` for `onError`. Cleanup attempts every acquired upload and preserves both primary and cleanup exceptions.

Upload names may use fixed nested paths. They cannot overlap text leaves or a dynamic collection domain. Dynamic-row file declarations and resumable/direct-to-object-store upload protocols are not implemented. Doctor can check declared control/encoding structure; it cannot verify uploaded bytes, MIME authenticity, malware scanning, or durable storage policy.
