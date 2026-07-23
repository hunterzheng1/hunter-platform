export interface MobileServiceWorkerHost {
  readonly pathname: string;
  readonly protocol: string;
  readonly isSecureContext: boolean;
  readonly register: (
    scriptUrl: string,
    options: { readonly scope: string; readonly type: "module" },
  ) => Promise<unknown>;
  readonly onLoad: (listener: () => void) => void;
}

export function isMobileRoute(pathname: string): boolean {
  return pathname === "/mobile" || pathname.startsWith("/mobile/");
}

function browserHost(): MobileServiceWorkerHost | undefined {
  if (!("serviceWorker" in navigator)) return undefined;
  return {
    pathname: window.location.pathname,
    protocol: window.location.protocol,
    isSecureContext: window.isSecureContext,
    register: (scriptUrl, options) => navigator.serviceWorker.register(scriptUrl, options),
    onLoad: (listener) => window.addEventListener("load", listener, { once: true }),
  };
}

export function registerMobileServiceWorker(
  suppliedHost?: MobileServiceWorkerHost,
): boolean {
  const host = suppliedHost ?? browserHost();
  if (
    host === undefined
    || !isMobileRoute(host.pathname)
    || !host.isSecureContext
    || (host.protocol !== "https:" && host.protocol !== "http:")
  ) {
    return false;
  }
  host.onLoad(() => {
    void host.register("/sw.js", { scope: "/mobile/", type: "module" }).catch(() => undefined);
  });
  return true;
}
