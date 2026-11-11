// FILE: Office3dConfirmDialog.tsx
// Purpose: Confirmation dialog warning the user about RAM/GPU usage before opening the 3D Virtual Office view.
// Layer: Web 3D office component
// Exports: Office3dConfirmDialog, isOffice3dConfirmed, setOffice3dConfirmed

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

let office3dSessionConfirmed = false;

export function isOffice3dConfirmed(): boolean {
  return office3dSessionConfirmed;
}

export function setOffice3dConfirmed(confirmed: boolean): void {
  office3dSessionConfirmed = confirmed;
}

export function Office3dConfirmDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Mở Văn phòng 3D?</AlertDialogTitle>
          <AlertDialogDescription>
            Chế độ Văn phòng 3D dựng không gian làm việc trực tiếp bằng WebGL và CSS3D theo thời
            gian thực cho các phiên Claude Code, Codex và Antigravity.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2 px-4 pb-2 text-ui-sm text-muted-foreground">
          <div className="rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5">
            <div className="font-medium text-foreground">Lưu ý tài nguyên hệ thống:</div>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-ui-sm text-muted-foreground">
              <li>
                Tiêu tốn thêm khoảng{" "}
                <span className="font-medium text-foreground">150–300 MB RAM</span> cùng tài nguyên{" "}
                <span className="font-medium text-foreground">GPU/CPU</span> để duy trì khung hình
                3D liên tục.
              </li>
              <li>
                Nếu máy cấu hình yếu, ít RAM hoặc đang chạy nhiều tác vụ nặng cùng lúc, bạn nên cân
                nhắc trước khi mở để tránh giật lag.
              </li>
              <li>
                Bạn có thể chuyển sang chế độ{" "}
                <span className="font-medium text-foreground">2D</span> nhẹ hơn ngay trong Văn phòng
                ảo hoặc rời khỏi trang bất cứ lúc nào để giải phóng bộ nhớ.
              </li>
            </ul>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            Để sau
          </AlertDialogClose>
          <Button
            size="sm"
            onClick={() => {
              setOffice3dConfirmed(true);
              onConfirm();
            }}
          >
            Vẫn mở Văn phòng 3D
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
