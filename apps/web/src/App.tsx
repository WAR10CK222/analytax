import { CatalogProvider } from "./app/catalog";
import { Shell } from "./app/Shell";
import { TooltipProvider } from "./components/ui/Overlay";
import { ToastProvider } from "./components/ui/Toast";

export function App() {
  return (
    <TooltipProvider>
      <ToastProvider>
        <CatalogProvider>
          <Shell />
        </CatalogProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}
