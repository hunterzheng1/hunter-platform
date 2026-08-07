"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

import { Icon, type IconName } from "./icons";

export type ToastTone = "success" | "danger" | "info" | "warning";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  push: (tone: ToastTone, message: string) => void;
  success: (message: string) => void;
  danger: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_ICON: Record<ToastTone, IconName> = {
  success: "success",
  danger: "error",
  info: "info",
  warning: "warning"
};

const TOAST_MS = 3600;

/** 全局 Toast。Provider 挂在 ClientLayout，任意组件 useToast() 触发。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = nextId.current++;
    setItems((current) => [...current.slice(-3), { id, tone, message }]);
    setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, TOAST_MS);
  }, []);

  const api = useMemo<ToastApi>(() => ({
    push,
    success: (message) => push("success", message),
    danger: (message) => push("danger", message),
    info: (message) => push("info", message),
    warning: (message) => push("warning", message)
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((item) => (
          <div className={`toast toast-${item.tone}`} key={item.id}>
            <Icon name={TONE_ICON[item.tone]} size={15} />
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    // 未挂 Provider 时降级为 no-op，避免页面崩溃
    return {
      push: () => undefined,
      success: () => undefined,
      danger: () => undefined,
      info: () => undefined,
      warning: () => undefined
    };
  }
  return ctx;
}
