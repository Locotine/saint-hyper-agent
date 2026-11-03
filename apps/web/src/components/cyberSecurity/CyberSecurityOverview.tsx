// FILE: CyberSecurityOverview.tsx
// Purpose: The Cyber Security entry page: pick a project to assess.
// Layer: Web cyber security view
// Exports: CyberSecurityOverview

import { useNavigate } from "@tanstack/react-router";

import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "~/components/RouteSurface";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { useHostId } from "~/hosts/hostScope";
import { useStore } from "~/store";
import { cyberSecurityHostSupported } from "./cyberSecurity.logic";
import { LocalOnlyNotice } from "./LocalOnlyNotice";

export function CyberSecurityOverview() {
  const navigate = useNavigate();
  const hostSupported = cyberSecurityHostSupported(useHostId());
  const projects = useStore((state) => state.projects).filter(
    (project) => project.kind === "project",
  );
  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-4 px-6 pt-10 pb-20">
            <header className="flex flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Cyber Security
              </h1>
              <p className="text-ui text-muted-foreground">
                Pick a project to check before it goes to production.
              </p>
            </header>
            {!hostSupported ? (
              <LocalOnlyNotice />
            ) : projects.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No projects yet</EmptyTitle>
                  <EmptyDescription>Open a project to run an assessment on it.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="flex flex-col gap-1">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Button
                      variant="ghost"
                      className="w-full justify-between"
                      onClick={() =>
                        void navigate({
                          to: "/cyber-security/$projectId",
                          params: { projectId: project.id },
                        })
                      }
                    >
                      <span className="shrink-0 text-ui">{project.name}</span>
                      <span className="min-w-0 truncate text-ui-sm text-muted-foreground">
                        {project.cwd}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
