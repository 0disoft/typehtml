/** The server reads disk; opening a document must never upload the editor buffer. */
export function withoutDocumentText<Document extends object>(document: Document): Document {
  // VS Code documents can be frozen; shadow getText on a fresh proxy target.
  return new Proxy({} as Document, { get(_target, key) {
    if (key === 'getText') return () => '';
    // Preserve getters/methods whose receivers must be the real VS Code document.
    const value = Reflect.get(document, key, document);
    return typeof value === 'function' ? value.bind(document) : value;
  } });
}

/** Keep the client's normal open-document tracking and subsequent save notifications. */
export function forwardSavedDocumentOpen<Document extends object>(document: Document, next: (document: Document) => Promise<void>): Promise<void> {
  return next(withoutDocumentText(document));
}
