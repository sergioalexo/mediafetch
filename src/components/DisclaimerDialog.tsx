import { ScrollText } from "lucide-react";
import { useApp } from "@/lib/store";
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
            <ScrollText className="h-5 w-5 text-primary" /> Disclaimer &amp; Terms of Use
          </DialogTitle>
          <DialogDescription>
            Please read carefully before using MediaFetch.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto text-sm text-muted-foreground">
          <p>
            MediaFetch is an independent graphical interface for the open-source tools{" "}
            <span className="font-medium text-foreground">yt-dlp</span> and{" "}
            <span className="font-medium text-foreground">FFmpeg</span>. It is provided for{" "}
            <span className="font-medium text-foreground">
              educational, research and personal-archival purposes only
            </span>
            . It does not host, index, provide or promote any content.
          </p>
          <p>
            Downloading content from{" "}
            <span className="font-medium text-foreground">
              YouTube, SoundCloud, Vimeo and most other streaming platforms may violate their
              Terms of Service
            </span>{" "}
            unless the platform provides an explicit download feature or the rights holder has
            permitted it. It is your responsibility to review and comply with the terms of any
            service you use this software with.
          </p>
          <p>
            Only download content that{" "}
            <span className="font-medium text-foreground">
              you own, that is in the public domain, that is distributed under a permissive
              license (e.g. Creative Commons), or for which you have the rights holder's
              explicit permission
            </span>
            . Downloading or redistributing copyrighted material without authorization may be
            illegal in your jurisdiction.
          </p>
          <p>
            By using MediaFetch you agree that{" "}
            <span className="font-medium text-foreground">
              you are solely responsible for how you use it
            </span>{" "}
            and for any consequences of that use. The developer (Sergio Alexo) assumes{" "}
            <span className="font-medium text-foreground">
              no liability for misuse of this software
            </span>{" "}
            and does not endorse or encourage any violation of platform terms or copyright law.
          </p>
          <p>
            This software is distributed under the MIT License and is provided{" "}
            <span className="font-medium text-foreground">
              "as is", without warranty of any kind
            </span>
            , express or implied.
          </p>
        </div>

        <DialogFooter>
          {accepted ? (
            <Button variant="outline" onClick={() => setShowDisclaimer(false)}>
              Close
            </Button>
          ) : (
            <Button onClick={accept}>I understand and accept</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
