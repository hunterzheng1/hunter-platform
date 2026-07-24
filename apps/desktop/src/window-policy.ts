export function isAllowedExternalUrl(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
