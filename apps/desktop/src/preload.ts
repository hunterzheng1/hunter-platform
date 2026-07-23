import { contextBridge, ipcRenderer } from "electron";
import { createDesktopPreloadApi, type DesktopInvoke } from "./ipc.js";
import { z } from "zod";

const EventSubscriptionReceiptSchema = z.strictObject({
  subscriptionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  cursor: z.number().int().nonnegative(),
});

const invoke: DesktopInvoke = (channel, request) => {
  switch (channel) {
    case "projects.list":
      return ipcRenderer.invoke("hunter:projects.list", request);
    case "requirements.create":
      return ipcRenderer.invoke("hunter:requirements.create", request);
    case "requirements.approve":
      return ipcRenderer.invoke("hunter:requirements.approve", request);
    case "changes.publish":
      return ipcRenderer.invoke("hunter:changes.publish", request);
    case "runs.get":
      return ipcRenderer.invoke("hunter:runs.get", request);
    case "runs.command":
      return ipcRenderer.invoke("hunter:runs.command", request);
    case "knowledge.list":
      return ipcRenderer.invoke("hunter:knowledge.list", request);
    case "events.subscribe":
      return ipcRenderer.invoke("hunter:events.subscribe", request);
  }
};

const api = createDesktopPreloadApi(
  invoke,
  (request, listener) => {
    const eventListener = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on("hunter:events.event", eventListener);
    let closed = false;
    let subscriptionId: string | undefined;
    void ipcRenderer.invoke("hunter:events.subscribe", request).then((value) => {
      const receipt = EventSubscriptionReceiptSchema.parse(value);
      subscriptionId = receipt.subscriptionId;
      if (closed) {
        void ipcRenderer.invoke("hunter:events.unsubscribe", {
          subscriptionId,
        });
      }
    }).catch(() => {
      listener({ status: "terminated", code: "EVENT_STREAM_FAILED" });
    });
    return () => {
      closed = true;
      ipcRenderer.removeListener("hunter:events.event", eventListener);
      if (subscriptionId !== undefined) {
        void ipcRenderer.invoke("hunter:events.unsubscribe", {
          subscriptionId,
        });
      }
    };
  },
);

contextBridge.exposeInMainWorld("hunter", api);
