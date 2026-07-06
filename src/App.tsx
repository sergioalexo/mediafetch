import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/Toaster";
import { useApp } from "@/lib/store";
import { DownloadsPage } from "@/pages/DownloadsPage";
import { QueuePage } from "@/pages/QueuePage";
import { HistoryPage } from "@/pages/HistoryPage";
import { StatsPage } from "@/pages/StatsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { BinariesPage } from "@/pages/BinariesPage";

const PAGES = {
  downloads: DownloadsPage,
  queue: QueuePage,
  history: HistoryPage,
  stats: StatsPage,
  settings: SettingsPage,
  binaries: BinariesPage,
} as const;

export default function App() {
  const page = useApp((s) => s.page);
  const init = useApp((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  const Page = PAGES[page];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full overflow-hidden">
        <Sidebar />
        <main className="relative flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
            >
              <Page />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
