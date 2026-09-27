import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { IconClose } from "./icons";

/**
 * Toasts are rare: only for results that are not visible elsewhere (copying from a menu, background failures).
 * Status changes already show in the header and the progress rail.
 */
export const toastManager = Toast.createToastManager();

export function notify(title: string, description?: string): void {
  toastManager.add({ title, description, timeout: 3500 });
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className="ax-popup flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-lg border border-line bg-raised px-4 py-3 text-fg shadow-overlay"
    >
      <div className="min-w-0 flex-1">
        <Toast.Title className="text-sm font-medium" />
        <Toast.Description className="mt-0.5 text-xs text-fg-2" />
      </div>
      <Toast.Close aria-label="Dismiss" className="ax-press -mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:text-fg">
        <IconClose size={14} aria-hidden="true" />
      </Toast.Close>
    </Toast.Root>
  ));
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager} limit={3}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-[70] flex flex-col items-end gap-2 outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
