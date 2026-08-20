export async function signToken(secret: string, purpose: string, parts: string[]): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(tokenPayload(purpose, parts))
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export async function verifyToken(
  secret: string,
  purpose: string,
  parts: string[],
  token: string
): Promise<boolean> {
  const expected = await signToken(secret, purpose, parts);
  return timingSafeEqual(expected, token);
}

function tokenPayload(purpose: string, parts: string[]): string {
  return JSON.stringify([purpose, ...parts]);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}
