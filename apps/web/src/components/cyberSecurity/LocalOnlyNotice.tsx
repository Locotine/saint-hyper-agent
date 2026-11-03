// FILE: LocalOnlyNotice.tsx
// Purpose: What Cyber Security shows for a project on a remote host: it checks this computer's
//          projects only for now.
// Layer: Web cyber security view
// Exports: LocalOnlyNotice

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";

export function LocalOnlyNotice() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Local projects only, for now</EmptyTitle>
        <EmptyDescription>
          Cyber Security checks projects on this computer. Projects on a remote host will be
          supported later; switch to this computer to run an assessment.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
