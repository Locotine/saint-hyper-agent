// FILE: Office3dView.tsx
// Purpose: Embeds the van-phong-ao-3d virtual office (with Claude, Codex, and Antigravity support) inside the Saint shell.
// Layer: Web 3D office view
// Exports: Office3dView

import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { RouteSurface } from "~/components/RouteSurface";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import {
  Office3dConfirmDialog,
  isOffice3dConfirmed,
  setOffice3dConfirmed,
} from "./Office3dConfirmDialog";

export function Office3dView() {
  const navigate = useNavigate();
  const [confirmed, setConfirmed] = useState(() => isOffice3dConfirmed());
  const officeUrl = useMemo(() => resolveWsHttpUrl("/office-3d-app/index.html"), []);

  return (
    <RouteSurface>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#05070a]">
        {confirmed ? (
          <iframe
            name="vp3d"
            src={officeUrl}
            title="Văn phòng 3D"
            className="size-full flex-1 border-0 bg-[#05070a]"
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-ui text-muted-foreground">
            Đang chờ xác nhận mở Văn phòng 3D…
          </div>
        )}
        <Office3dConfirmDialog
          open={!confirmed}
          onConfirm={() => {
            setOffice3dConfirmed(true);
            setConfirmed(true);
          }}
          onCancel={() => {
            void navigate({ to: "/" });
          }}
        />
      </div>
    </RouteSurface>
  );
}
