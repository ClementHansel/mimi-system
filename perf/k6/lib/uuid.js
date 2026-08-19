// Minimal RFC4122 v4 UUID generator — k6's JS runtime (goja) has no
// `crypto.randomUUID`, and every idempotency key in this codebase
// (`clientId` on sales/shifts/attachments/...) must be a real UUID or the
// backend's `@IsUUID()` DTO validation rejects the request outright.
export function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
