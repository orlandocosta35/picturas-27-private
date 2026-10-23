"use client";

import Link from "next/link";
import { Skeleton } from "../ui/skeleton";
import {
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "../ui/sidebar";
import ProjectItem from "./project-item";
import { useSession } from "@/providers/session-provider";
import { useGetProjects, useResolveShareLink } from "@/lib/queries/projects";
import { Search, ListChecks, LoaderCircle, Trash2, X } from "lucide-react";
import { Button } from "../ui/button";
import { useEffect, useState } from "react";
import { Transition } from "@headlessui/react";
import { Project, fetchProject, deleteProject } from "@/lib/projects";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Checkbox } from "../ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel,
} from "../ui/alert-dialog";

export default function ProjectList() {
  const session = useSession();
  const projects = useGetProjects(session.user._id, session.token);
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function deleteSelected() {
    if (deleting || selected.length === 0) return;
    setDeleting(true);
    const deleted: string[] = [];
    const failed: string[] = [];
    try {
      for (const pid of selected) {
        try {
          const current = await fetchProject(session.user._id, pid, session.token);
          if (!Number.isInteger(current.version) || current.version < 0) {
            throw new Error("Invalid project version");
          }
          await deleteProject({
            uid: session.user._id, pid, token: session.token,
            projectVersion: current.version,
          });
          deleted.push(pid);
        } catch {
          failed.push(pid);
        }
      }
      const key = ["projects", session.user._id, session.token];
      qc.setQueryData<Project[]>(key, (old) => old?.filter((p) => !deleted.includes(p._id)));
      for (const pid of deleted) {
        qc.removeQueries({ queryKey: ["project", session.user._id, pid] });
        qc.removeQueries({ queryKey: ["projectImages", session.user._id, pid] });
        qc.removeQueries({ queryKey: ["projectResults", session.user._id, pid] });
      }
      if (deleted.some((pid) => pathname === `/dashboard/${pid}`)) router.push("/dashboard");
      void qc.invalidateQueries({ queryKey: key });
      setSelected(failed);
      setSelecting(failed.length > 0);
      setConfirmOpen(false);
      toast({
        title: failed.length ? "Some projects could not be deleted" : "Projects deleted",
        description: `${deleted.length} deleted.${failed.length ? ` ${failed.length} could not be deleted and remain selected so you can try again.` : ""}`,
        variant: failed.length ? "destructive" : "default",
      });
    } finally {
      setDeleting(false);
    }
  }


  const searchParams = useSearchParams();
  const shareId = searchParams.get("share"); // shareId da URL

  // ✅ resolve do share link (projectId, ownerId, permission, projectName)
  const shared = useResolveShareLink(shareId ?? undefined);

  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filteredProjects, setFilteredProjects] = useState<Project[]>(
    projects.data || [],
  );
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    if (projects.data) {
      setFilteredProjects(
        projects.data.filter((p) =>
          p.name.toLowerCase().includes(searchQuery.toLowerCase()),
        ),
      );
      setLastUpdated(new Date());
    }
  }, [searchQuery, projects.data]);

  useEffect(() => {
    if (searchOpen) {
      const i = setInterval(() => {
        if (lastUpdated) {
          const now = new Date();
          const diffSecs = (now.getTime() - lastUpdated.getTime()) / 1000;
          if (diffSecs > 5 && searchQuery === "") {
            setSearchOpen(false);
            setLastUpdated(null);
          }
        }
      }, 1000);
      return () => clearInterval(i);
    }
  }, [searchQuery, lastUpdated, searchOpen]);

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="flex justify-between items-center">
        <span>Your projects</span>
        <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          className="size-fit p-1"
          aria-label={selecting ? "Cancel selection" : "Select projects"}
          title={selecting ? "Cancel selection" : "Select projects"}
          disabled={deleting || !projects.data?.length}
          onClick={() => { setSelecting(!selecting); setSelected([]); }}
        >
          {selecting ? <X className="size-4" /> : <ListChecks className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          aria-label="Search projects"
          className="size-fit p-1"
          onClick={() => {
            setSearchOpen(!searchOpen);
            if (searchOpen) setLastUpdated(null);
            else setLastUpdated(new Date());
          }}
        >
          <Search className="size-[1em]" />
        </Button>
        </div>
      </SidebarGroupLabel>
      {selecting && (
        <div className="mb-2 space-y-2 px-2">
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={filteredProjects.length > 0 && filteredProjects.every((p) => selected.includes(p._id))
                ? true : filteredProjects.some((p) => selected.includes(p._id)) ? "indeterminate" : false}
              disabled={deleting || filteredProjects.length === 0}
              onCheckedChange={(checked) => setSelected((old) => checked
                ? Array.from(new Set([...old, ...filteredProjects.map((p) => p._id)]))
                : old.filter((id) => !filteredProjects.some((p) => p._id === id)))}
            />
            Select all visible projects
          </label>
          <Button variant="destructive" size="sm" className="w-full"
            disabled={deleting || selected.length === 0} onClick={() => setConfirmOpen(true)}>
            <Trash2 /> Delete selected ({selected.length})
          </Button>
        </div>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!deleting) setConfirmOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.length} project(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              The selected projects and their associated data will be deleted. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={deleting} onClick={deleteSelected}>
              {deleting ? <><LoaderCircle className="animate-spin" /> Deleting…</> : "Delete projects"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {projects.data && projects.data.length > 0 && (
        <Transition
          show={searchOpen}
          enter="transition-opacity duration-500"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="transition-opacity duration-500"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full p-2 bg-sidebar-accent text-sidebar-accent-foreground h-6 rounded-md text-sm active:outline-none focus:outline-none mb-2"
          />
        </Transition>
      )}

      <SidebarGroupContent>
        <SidebarMenu>
          {/* Projetos do utilizador */}
          {!projects.isLoading &&
            projects.data &&
            (filteredProjects.length > 0
              ? filteredProjects.map((p) => selecting ? (
                  <SidebarMenuItem key={p._id}>
                    <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-sidebar-accent">
                      <Checkbox checked={selected.includes(p._id)} disabled={deleting}
                        onCheckedChange={(checked) => setSelected((old) => checked
                          ? [...old.filter((id) => id !== p._id), p._id]
                          : old.filter((id) => id !== p._id))} />
                      <span className="truncate">{p.name}</span>
                    </label>
                  </SidebarMenuItem>
                ) : <ProjectItem key={p._id} p={p} />)
              : projects.data.length > 0 && (
                  <SidebarMenuItem>
                    <span className="pl-2">No search results.</span>
                  </SidebarMenuItem>
                ))}

          {projects.isLoading && (
            <SidebarMenuItem className="flex flex-col gap-2 px-2 pt-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton className="w-full h-5" key={i} />
              ))}
            </SidebarMenuItem>
          )}

          {/* ✅ CASO 1: Sem projetos do utilizador, mas share válido */}
          {!projects.isLoading &&
            projects.data &&
            projects.data.length === 0 &&
            shareId &&
            shared.isSuccess &&
            shared.data && (
              <SidebarMenuItem>
                <Link
                  href={`/dashboard/${shared.data.projectId}?owner=${shared.data.ownerId}&share=${shareId}`}
                  className="pl-2 underline"
                >
                  {shared.data.projectName ?? "Shared project"}{" "}
                  <span className="text-xs text-muted-foreground">
                    (Shared, permission: {shared.data.permission})
                  </span>
                </Link>
              </SidebarMenuItem>
            )}

          {/* CASO 2: Sem projetos e sem share válido */}
          {!projects.isLoading &&
            projects.data &&
            projects.data.length === 0 &&
            (!shareId || shared.isError || !shared.data) && (
              <SidebarMenuItem>
                <span className="pl-2">Empty for now.</span>
              </SidebarMenuItem>
            )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
