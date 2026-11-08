/** Call after the host commits an invalid state; no DOM globals are accessed until the call. */
export function focusNativeErrorSummary(root: Pick<ParentNode, 'querySelector'>, options: FocusOptions = {}): boolean {
  const summary = root.querySelector<HTMLElement>('[data-typehtml-error-summary]');
  if (summary === null) return false;
  summary.focus(options);
  return true;
}
