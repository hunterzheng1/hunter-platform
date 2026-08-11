"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

const TOAST_DURATION_MS: Record<ToastTone, number> = {
  success: 4_800,
  info: 4_800,
  warning: 6_400,
  danger: 6_400
};

/** 全局 Toast。Provider 挂在 ClientLayout，任意组件 useToast() 触发。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = nextId.current++;
    setItems((current) => [...current.slice(-3), { id, tone, message }]);
    const timer = setTimeout(() => dismiss(id), TOAST_DURATION_MS[tone]);
    timers.current.set(id, timer);
  }, [dismiss]);

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
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
      <div className="toast-stack" data-slot="toast-viewport" aria-label="通知">
        {items.map((item) => (
          <div
            className={`toast toast-${item.tone}`}
            data-slot="toast"
            role={item.tone === "danger" ? "alert" : "status"}
            aria-live={item.tone === "danger" ? "assertive" : "polite"}
            key={item.id}
          >
            <span className="toast-icon" data-slot="toast-icon"><Icon name={TONE_ICON[item.tone]} size={17} /></span>
            <span className="toast-message" data-slot="toast-message">{item.message}</span>
            <button
              type="button"
              className="toast-dismiss"
              data-slot="toast-dismiss"
              aria-label="关闭通知"
              onClick={() => dismiss(item.id)}
            >×</button>
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

/**
 * 把既有的异步操作状态接入全局通知层。
 * 适合逐步迁移仍由父组件持有 message/error state 的页面；不渲染任何占位内容。
 */
export function ToastFeedback({ message, tone = "info" }: {
  message: string | null | undefined;
  tone?: ToastTone;
}) {
  const toast = useToast();

  useEffect(() => {
    if (message !== null && message !== undefined && message.trim() !== "") {
      toast.push(tone, message);
    }
  }, [message, toast, tone]);

  return null;
}
