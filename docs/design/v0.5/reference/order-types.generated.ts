// GENERATED from examples/order.boundary.json; do not edit.
// Source SHA256: 8d28473d4cc7141575930268c4843ea6e487ff560d379e206c38b1512050cf4e
// Numeric/string constraints remain runtime responsibilities.
export type OrderInput = {
  readonly "productId": string;
  readonly "quantity": number;
};
export type PublicReceipt = {
  readonly "orderId": string;
  readonly "state": "draft";
  readonly "totalMinor": number;
  readonly "currency": "KRW";
};
export type OrderPageView = {
  readonly "productId": string;
  readonly "productName": string;
  readonly "unitPriceMinor": number;
  readonly "currency": "KRW";
  readonly "productRevision": number;
};
