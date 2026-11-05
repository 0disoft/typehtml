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
  return `${escapeHtml(currency)} ${escapeHtml(String(minor))}`;
}

function fieldErrors(id: string, errors: readonly string[] | undefined): string {
  if (errors === undefined || errors.length === 0) return '';
  return `<p id="${id}" class="field-error">${errors.map((error) => escapeHtml(error)).join(', ')}</p>`;
}

export function renderLogin(message?: string): string {
  return page(
    '로그인',
    `<h1>로그인</h1>
${message === undefined ? '' : `<p role="alert">${escapeHtml(message)}</p>`}
<form method="post" action="/login">
<label for="tenantId">테넌트</label>
<input id="tenantId" name="tenantId" autocomplete="organization" required>
<label for="subjectId">사용자</label>
<input id="subjectId" name="subjectId" autocomplete="username" required>
<label for="password">비밀번호</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">로그인</button>
</form>`,
  );
}

export function renderStart(view: OrderPageView, csrfToken: string, beginPath: string): string {
  return page(
    '주문 시작',
    `<h1>주문 시작</h1>
<p>${escapeHtml(view.productName)}</p>
<p>단가: ${money(view.unitPriceMinor, view.currency)}</p>
<form id="begin-draft" method="post" action="${escapeHtml(beginPath)}" enctype="application/x-www-form-urlencoded" accept-charset="UTF-8">
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
  const pattern = constraints.minQuantity === 1 && constraints.maxQuantity === 20
    ? '([1-9]|1[0-9]|20)'
    : '(0|-?[1-9][0-9]*)';
  const maxLength = Math.max(String(constraints.minQuantity).length, String(constraints.maxQuantity).length);
  const hasErrors = quantityInvalid || productInvalid || state.formErrors.length > 0;
  return page(
    hasErrors ? '입력값을 확인해 주세요' : '주문서',
    `<h1>주문서</h1>
<p>${escapeHtml(view.productName)}</p>
<p>단가: ${money(view.unitPriceMinor, view.currency)}</p>
${hasErrors ? `<section aria-labelledby="errors-title" role="alert"><h2 id="errors-title">수정할 항목</h2>
${quantityInvalid ? `<p><a href="#quantity">수량: ${(state.fieldErrors.quantity ?? []).map(escapeHtml).join(', ')}</a></p>` : ''}
${productInvalid ? `<p>상품: ${(state.fieldErrors.productId ?? []).map(escapeHtml).join(', ')}</p>` : ''}
${state.formErrors.map((error) => `<p>${escapeHtml(error)}</p>`).join('')}
</section>` : ''}
<form id="create-draft" method="post" action="${escapeHtml(actionPath)}" enctype="application/x-www-form-urlencoded" accept-charset="UTF-8">
<input type="hidden" name="_bc_csrf" value="${escapeHtml(state.csrfToken)}">
<input type="hidden" name="_bc_request" value="${escapeHtml(state.intentId)}">
<input type="hidden" name="productId" value="${escapeHtml(view.productId)}">
<label for="quantity">수량</label>
<p id="quantity-hint">${constraints.minQuantity}부터 ${constraints.maxQuantity}까지의 정수를 입력하세요. 지수·소수 표기는 사용할 수 없습니다.</p>
<input
  id="quantity"
  name="quantity"
  type="text"
  inputmode="numeric"
  pattern="${pattern}"
  maxlength="${maxLength}"
  aria-describedby="quantity-hint${quantityInvalid ? ' quantity-error' : ''}"
  value="${escapeHtml(quantity)}"
  required
  ${quantityInvalid ? 'aria-invalid="true"' : ''}
>
${fieldErrors('quantity-error', state.fieldErrors.quantity)}
${productInvalid ? fieldErrors('productId-error', state.fieldErrors.productId) : ''}
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

export function renderErrorPage(
  status: number,
  message: string,
  link?: Readonly<{ href: string; label: string }>,
): string {
  const guidance = status === 409 || status === 410
    ? '상품 안내 화면으로 돌아가 현재 가격을 확인한 뒤 새 주문서를 시작해 주세요. 완료한 주문이 있다면 영수증을 확인해 주세요.'
    : status === 429 || status === 503
      ? '잠시 후 같은 주문서에서 다시 시도해 주세요. 처리 결과를 확인하기 전에 새 주문서를 만들지 마세요.'
      : '';
  return page(
    '요청을 처리할 수 없습니다',
    `<h1>요청을 처리할 수 없습니다</h1>
<p>상태: ${status}</p>
<p>${escapeHtml(message)}</p>
${guidance === '' ? '' : `<p>${guidance}</p>`}
${link === undefined ? '' : `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`}`,
  );
}
