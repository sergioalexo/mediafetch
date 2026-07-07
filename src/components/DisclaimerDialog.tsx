import { ScrollText } from "lucide-react";
import { useApp } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Legal disclaimer. Shown blocking on first launch until accepted,
 * and viewable again from Settings → Legal.
 */
export function DisclaimerDialog() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const showDisclaimer = useApp((s) => s.showDisclaimer);
  const setShowDisclaimer = useApp((s) => s.setShowDisclaimer);
  const t = useT();

  const accepted = settings?.disclaimerAccepted ?? true; // don't flash before settings load
  const open = !accepted || showDisclaimer;

  const accept = () => {
    void updateSettings({ disclaimerAccepted: true });
    setShowDisclaimer(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Before first acceptance the dialog cannot be dismissed.
        if (!v && accepted) setShowDisclaimer(false);
      }}
    >
      <DialogContent
        className="max-w-xl"
        onPointerDownOutside={(e) => {
          if (!accepted) e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (!accepted) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-primary" /> {t("d.title")}
          </DialogTitle>
          <DialogDescription>{t("d.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto text-sm text-muted-foreground">
          <p>{t("d.p1")}</p>
          <p>{t("d.p2")}</p>
          <p>{t("d.p3")}</p>
          <p>{t("d.p4")}</p>
          <p>{t("d.p5")}</p>
        </div>

        <DialogFooter>
          {accepted ? (
            <Button variant="outline" onClick={() => setShowDisclaimer(false)}>
              {t("d.close")}
            </Button>
          ) : (
            <Button onClick={accept}>{t("d.accept")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
