import type { FormState, OrderPageView, PublicReceipt } from '../runtime/order.ts';

export type FormConstraints = Readonly<{
  minQuantity: number;
  maxQuantity: number;
  productIdMaxLength: number;
}>;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function money(minor: number, currency: string): string {
  return `${escapeHtml(currency)} ${String(minor)}`;
}

function fieldErrors(errors: readonly string[] | undefined): string {
  if (errors === undefined || errors.length === 0) return '';
  return `<p class="field-error" role="alert">${errors.map((error) => escapeHtml(error)).join(', ')}</p>`;
}

export function renderStart(view: OrderPageView, csrfToken: string, beginPath: string): string {
  return page(
    '주문 시작',
    `<h1>주문 시작</h1>
<p>${escapeHtml(view.productName)}</p>
<p>단가: ${money(view.unitPriceMinor, view.currency)}</p>
<form method="post" action="${escapeHtml(beginPath)}">
<input type="hidden" name="_bc_csrf" value="${escapeHtml(csrfToken)}">
<input type="hidden" name="productId" value="${escapeHtml(view.productId)}">
<button type="submit">주문서 작성</button>
</form>`,
  );
}

export function renderForm(
  view: OrderPageView,
  state: FormState,
  actionPath: string,
  constraints: FormConstraints,
): string {
  const quantity = state.rawValues.quantity ?? '2';
  const quantityInvalid = (state.fieldErrors.quantity ?? []).length > 0;
  const productInvalid = (state.fieldErrors.productId ?? []).length > 0;
  return page(
    '주문서',
    `<h1>주문서</h1>
<p>${escapeHtml(view.productName)}</p>
<p>단가: ${money(view.unitPriceMinor, view.currency)}</p>
${state.formErrors.length > 0 ? `<p role="alert">${state.formErrors.map(escapeHtml).join(', ')}</p>` : ''}
<form method="post" action="${escapeHtml(actionPath)}">
<input type="hidden" name="_bc_csrf" value="${escapeHtml(state.csrfToken)}">
<input type="hidden" name="_bc_request" value="${escapeHtml(state.intentId)}">
<input type="hidden" name="productId" value="${escapeHtml(view.productId)}">
<label for="quantity">수량</label>
<input
  id="quantity"
  name="quantity"
  type="number"
  inputmode="numeric"
  min="${constraints.minQuantity}"
  max="${constraints.maxQuantity}"
  value="${escapeHtml(quantity)}"
  required
  ${quantityInvalid ? 'aria-invalid="true"' : ''}
>
${fieldErrors(state.fieldErrors.quantity)}
${productInvalid ? fieldErrors(state.fieldErrors.productId) : ''}
<button type="submit">주문 확정</button>
</form>`,
  );
}

export function renderReceipt(receipt: PublicReceipt): string {
  return page(
    '주문 접수',
    `<h1>주문 접수</h1>
<p>주문 번호: <strong>${escapeHtml(receipt.orderId)}</strong></p>
<p>합계: ${money(receipt.totalMinor, receipt.currency)}</p>
<p>상태: ${escapeHtml(receipt.state)}</p>`,
  );
}

export function renderErrorPage(status: number, message: string): string {
  return page(
    '요청을 처리할 수 없습니다',
    `<h1>요청을 처리할 수 없습니다</h1>
<p>상태: ${status}</p>
<p>${escapeHtml(message)}</p>`,
  );
}
