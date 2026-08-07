"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./icons";

/**
 * 统一弹窗：portal 渲染、ESC 关闭、遮罩点击关闭、进入动画、初始焦点。
 * 替换各页面手写的 .modal-backdrop 结构。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  closeLabel = "Close"
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  closeLabel?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 初始焦点放入弹窗，便于键盘操作
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>("input, textarea, select, button:not(.modal-close)")?.focus();
    });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      cancelAnimationFrame(frame);
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  return createPortal(
    <div className="modal-backdrop modal-backdrop-animated" onClick={onClose}>
      <div
        ref={panelRef}
        className={`modal-panel${wide ? " modal-panel-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-button modal-close" aria-label={closeLabel} onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer === undefined ? null : <div className="modal-actions">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
